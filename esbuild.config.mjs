import esbuild from "esbuild";
import process from "process";
import { copyFileSync, existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const prod = process.argv[2] === "production";

function askPath() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Deploy path (leave empty to skip copy): ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed && !existsSync(trimmed)) {
        console.error(`\x1b[31m✗ Path does not exist: ${trimmed}\x1b[0m`);
        process.exit(1);
      }
      resolve(trimmed || null);
    });
  });
}

const deployPath = prod ? null : (process.argv[2] || await askPath());

/** Plugin that copies build artifacts to deployPath after each build */
const copyPlugin = {
  name: "copy-to-deploy",
  setup(build) {
    build.onEnd((result) => {
      const ts = new Date().toLocaleTimeString();
      if (result.errors.length > 0) {
        console.log(`\x1b[31m[${ts}] Build failed with ${result.errors.length} error(s)\x1b[0m`);
        return;
      }
      console.log(`\x1b[36m[${ts}] Build succeeded\x1b[0m`);
      if (deployPath) {
        try {
          for (const f of ["main.js", "manifest.json", "styles.css"]) {
            copyFileSync(f, join(deployPath, f));
          }
          console.log(`\x1b[32m[${ts}] ✓ Copied → ${deployPath}\x1b[0m`);
        } catch (e) {
          console.error(`\x1b[31m[${ts}] ✗ Copy failed: ${e.message}\x1b[0m`);
        }
      }
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["./src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "crypto",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  define: {
    "process.env.NODE_ENV": prod ? '"production"' : '"development"',
  },
  plugins: deployPath ? [copyPlugin] : [],
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
  console.log(`\x1b[35m\n━━━ Watching for changes ━━━\x1b[0m`);
  if (deployPath) console.log(`\x1b[35m  Deploy → ${deployPath}\x1b[0m`);
  else console.log(`\x1b[33m  No deploy path — build only\x1b[0m`);
  console.log(`\x1b[35m  Press Ctrl+C to stop\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n`);
}
