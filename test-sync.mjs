/**
 * Standalone sync test: Downloads all files from OneDrive /Office to D:\obsidian
 * Uses the same logic as the plugin but with Node.js fs instead of Obsidian's vault API.
 */
import fs from "fs";
import path from "path";
import { ProxyAgent, setGlobalDispatcher } from "undici";

// Set up proxy
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  console.log("Using proxy:", proxyUrl.replace(/:[^:@]+@/, ":***@"));
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const VAULT_PATH = "D:/obsidian";
const DATA_PATH = `${VAULT_PATH}/.obsidian/plugins/obsidian-multisync/data.json`;
const GRAPH = "https://graph.microsoft.com/v1.0";

const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
const account = data.accounts[0];
const creds = account.credentials;
const rule = data.rules[0]; // cloudFolder: "Office", localFolder: ""

async function refreshToken() {
  const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: [
      `client_id=${creds.clientId}`,
      `refresh_token=${creds.refreshToken}`,
      `grant_type=refresh_token`,
      `scope=Files.ReadWrite.All offline_access`,
    ].join("&"),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  const d = await resp.json();
  creds.accessToken = d.access_token;
  creds.refreshToken = d.refresh_token || creds.refreshToken;
  creds.tokenExpiry = String(Date.now() + d.expires_in * 1000);
  data.accounts[0].credentials = creds;
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

async function graphGet(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

async function graphGetBinary(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        redirect: "follow",
      });
      if (resp.status === 302 || resp.status === 301) {
        // Follow redirect manually
        const location = resp.headers.get("location");
        if (location) {
          const resp2 = await fetch(location);
          if (!resp2.ok) throw new Error(`Redirect download ${resp2.status}`);
          return Buffer.from(await resp2.arrayBuffer());
        }
      }
      if (resp.status === 429 || resp.status === 503) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!resp.ok) throw new Error(`Download ${resp.status}: ${(await resp.text()).substring(0, 100)}`);
      return Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

function encodeGraphPath(p) {
  return p.split("/").map(s => encodeURIComponent(s)).join("/");
}

async function listCloudFiles(cloudFolder) {
  const entries = [];
  const driveItemPath = `/me/drive/root:${encodeGraphPath("/" + cloudFolder)}:`;
  
  const recurse = async (apiPath, prefix) => {
    let url = `${apiPath}/children?$select=name,id,size,lastModifiedDateTime,folder,file&$top=200`;
    while (url) {
      let d;
      try {
        d = await graphGet(url);
      } catch (e) {
        if (e.message?.includes("404")) return;
        throw e;
      }
      for (const item of d.value || []) {
        const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
        const isFolder = !!item.folder;
        entries.push({
          path: isFolder ? itemPath + "/" : itemPath,
          mtime: new Date(item.lastModifiedDateTime).getTime(),
          size: item.size || 0,
          isFolder,
          id: item.id,
        });
        if (isFolder) {
          await recurse(`/me/drive/items/${item.id}`, itemPath);
        }
      }
      url = d["@odata.nextLink"]?.replace(GRAPH, "") || "";
    }
  };

  await recurse(driveItemPath, "");
  return entries;
}

function listLocalFiles(localFolder) {
  const entries = [];
  const basePath = localFolder ? path.join(VAULT_PATH, localFolder) : VAULT_PATH;
  
  const recurse = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue; // skip hidden
      const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        entries.push({ path: itemPath + "/", mtime: 0, size: 0, isFolder: true });
        recurse(fullPath, itemPath);
      } else {
        const stat = fs.statSync(fullPath);
        entries.push({
          path: itemPath,
          mtime: stat.mtimeMs,
          size: stat.size,
          isFolder: false,
        });
      }
    }
  };

  recurse(basePath, "");
  return entries;
}

async function downloadFile(cloudFolder, relativePath) {
  const encoded = encodeGraphPath("/" + cloudFolder + "/" + relativePath);
  return graphGetBinary(`/me/drive/root:${encoded}:/content`);
}

async function main() {
  console.log("=== Standalone Sync Test ===\n");

  // Refresh token
  console.log("1. Refreshing token...");
  await refreshToken();
  console.log("   OK\n");

  // List cloud files
  console.log("2. Listing cloud files in /" + rule.cloudFolder + "...");
  const cloudFiles = await listCloudFiles(rule.cloudFolder);
  const cloudFileCount = cloudFiles.filter(e => !e.isFolder).length;
  const cloudFolderCount = cloudFiles.filter(e => e.isFolder).length;
  console.log(`   ${cloudFileCount} files, ${cloudFolderCount} folders\n`);

  // List local files
  console.log("3. Listing local files...");
  const localFiles = listLocalFiles(rule.localFolder);
  const localFileCount = localFiles.filter(e => !e.isFolder).length;
  const localFolderCount = localFiles.filter(e => e.isFolder).length;
  console.log(`   ${localFileCount} files, ${localFolderCount} folders\n`);

  // Detect cloud-add (files on cloud but not local)
  const localPaths = new Set(localFiles.map(e => e.path));
  const cloudOnly = cloudFiles.filter(e => !localPaths.has(e.path));
  console.log(`4. Files to download (cloud-add): ${cloudOnly.filter(e => !e.isFolder).length} files, ${cloudOnly.filter(e => e.isFolder).length} folders\n`);

  if (cloudOnly.length === 0) {
    console.log("Nothing to sync — all files are up to date.");
    return;
  }

  // Create folders first
  const folders = cloudOnly.filter(e => e.isFolder).sort((a, b) => a.path.length - b.path.length);
  for (const folder of folders) {
    const localPath = rule.localFolder
      ? path.join(VAULT_PATH, rule.localFolder, folder.path.replace(/\/$/, ""))
      : path.join(VAULT_PATH, folder.path.replace(/\/$/, ""));
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true });
      console.log(`   📁 Created: ${folder.path}`);
    }
  }

  // Download files with concurrency
  const files = cloudOnly.filter(e => !e.isFolder);
  const CONCURRENCY = 4;
  let completed = 0;
  let errors = 0;
  let i = 0;

  const worker = async () => {
    while (i < files.length) {
      const file = files[i++];
      try {
        const content = await downloadFile(rule.cloudFolder, file.path);
        const localPath = rule.localFolder
          ? path.join(VAULT_PATH, rule.localFolder, file.path)
          : path.join(VAULT_PATH, file.path);
        
        // Ensure parent dir exists
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.writeFileSync(localPath, content);
        completed++;
        if (completed % 10 === 0 || completed === files.length) {
          console.log(`   ⟳ ${completed}/${files.length} downloaded`);
        }
      } catch (e) {
        errors++;
        console.error(`   ✗ Failed: ${file.path} — ${e.message?.substring(0, 80)}`);
      }
    }
  };

  console.log(`\n5. Downloading ${files.length} files (concurrency=${CONCURRENCY})...\n`);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));

  console.log(`\n=== Sync Complete ===`);
  console.log(`Downloaded: ${completed}, Errors: ${errors}`);
  
  // Verify
  const afterLocal = listLocalFiles(rule.localFolder);
  const afterFileCount = afterLocal.filter(e => !e.isFolder).length;
  console.log(`Local files after sync: ${afterFileCount}`);
}

main().catch(e => console.error("FATAL:", e));
