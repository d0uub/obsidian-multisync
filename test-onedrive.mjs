/**
 * Standalone test: Refresh OneDrive token, list files in /Office folder,
 * then test downloading a file.
 */
import fs from "fs";
import { ProxyAgent, setGlobalDispatcher } from "undici";

// Set up proxy from environment
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  console.log("Using proxy:", proxyUrl.replace(/:[^:@]+@/, ":***@"));
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const dataPath = "D:/obsidian/.obsidian/plugins/obsidian-multisync/data.json";
const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
const account = data.accounts[0];
const creds = account.credentials;

const GRAPH = "https://graph.microsoft.com/v1.0";

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
  if (!resp.ok) {
    console.error("Token refresh failed:", resp.status, await resp.text());
    process.exit(1);
  }
  const d = await resp.json();
  creds.accessToken = d.access_token;
  creds.refreshToken = d.refresh_token || creds.refreshToken;
  creds.tokenExpiry = String(Date.now() + d.expires_in * 1000);
  // Save updated tokens back
  data.accounts[0].credentials = creds;
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  console.log("Token refreshed OK, expires in", d.expires_in, "seconds.");
}

async function graphGet(path) {
  const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph API ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

async function listFiles(cloudFolder) {
  const encoded = `/${encodeURIComponent(cloudFolder)}`;
  const driveItemPath = `/me/drive/root:${encoded}:`;
  const entries = [];
  let fileCount = 0, folderCount = 0;

  const recurse = async (apiPath, prefix) => {
    let url = `${apiPath}/children?\\$select=name,id,size,lastModifiedDateTime,folder,file&\\$top=200`;
    while (url) {
      let d;
      try {
        console.log(`  → ${url.substring(0, 100)}`);
        d = await graphGet(url);
      } catch (e) {
        console.warn(`  ⚠ Error listing ${prefix || "/"}: ${e.message?.substring(0, 120)}`);
        return;
      }
      for (const item of d.value || []) {
        const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
        const isFolder = !!item.folder;
        entries.push({
          path: isFolder ? itemPath + "/" : itemPath,
          mtime: new Date(item.lastModifiedDateTime).getTime(),
          size: item.size || 0,
          isFolder,
        });
        if (isFolder) {
          folderCount++;
          await recurse(`/me/drive/items/${item.id}`, itemPath);
        } else {
          fileCount++;
        }
      }
      url = d["@odata.nextLink"] ? d["@odata.nextLink"].replace(GRAPH, "") : "";
    }
  };

  await recurse(driveItemPath, "");
  console.log(`\nTotal: ${fileCount} files, ${folderCount} folders`);
  return entries;
}

async function main() {
  console.log("=== OneDrive Integration Test ===\n");

  // Step 1: Refresh token
  console.log("1. Refreshing token...");
  await refreshToken();

  // Step 2: Test basic connectivity
  console.log("\n2. Testing /me/drive...");
  const drive = await graphGet("/me/drive");
  console.log("Drive ID:", drive.id, "| Owner:", drive.owner?.user?.displayName);

  // Step 3: List files in /Office
  console.log("\n3. Listing files in /Office...");
  const entries = await listFiles("Office");
  
  // Show first 30 entries
  console.log("\nFirst 30 entries:");
  for (const e of entries.slice(0, 30)) {
    const d = new Date(e.mtime).toISOString().substring(0, 19);
    console.log(`  ${e.isFolder ? "📁" : "📄"} ${e.path} (${e.size}b, ${d})`);
  }

  // Step 4: Try downloading a small file
  const firstFile = entries.find(e => !e.isFolder && e.size < 100000);
  if (firstFile) {
    console.log(`\n4. Downloading first file: ${firstFile.path}...`);
    const parts = firstFile.path.split("/");
    const encoded = parts.map(p => encodeURIComponent(p)).join("/");
    const content = await graphGet(`/me/drive/root:/Office/${encoded}:/content`);
    console.log("Download OK, got response.");
  } else {
    console.log("\n4. No small files found to test download.");
  }

  // Step 5: Test delta API
  console.log("\n5. Testing delta API...");
  const deltaUrl = data.deltaTokens?.[account.id];
  if (deltaUrl) {
    console.log("Using stored delta token...");
    try {
      const delta = await graphGet(deltaUrl);
      const deletedItems = (delta.value || []).filter(i => i.deleted);
      console.log(`Delta returned ${delta.value?.length || 0} items, ${deletedItems.length} deleted.`);
      if (deletedItems.length > 0) {
        for (const d of deletedItems.slice(0, 5)) {
          console.log(`  🗑 ${d.name} (parent: ${d.parentReference?.path})`);
        }
      }
    } catch (e) {
      console.log("Delta query failed:", e.message?.substring(0, 100));
    }
  } else {
    console.log("No delta token found, getting latest...");
    const delta = await graphGet("/me/drive/root/delta?token=latest");
    console.log("Got deltaLink:", delta["@odata.deltaLink"]?.substring(0, 80) + "...");
  }

  console.log("\n=== Test Complete ===");
}

main().catch(e => console.error("FATAL:", e));
