import esbuild from "esbuild";
import process from "process";
import { copyFileSync } from "fs";
import { join } from "path";

const prod = process.argv[2] === "production";
const deployPath = !prod ? process.argv[2] : null;

/** Plugin that copies build artifacts to deployPath after each build */
const copyPlugin = {
  name: "copy-to-deploy",
  setup(build) {
    build.onEnd(() => {
      if (deployPath) {
        try {
          for (const f of ["main.js", "manifest.json", "styles.css"]) {
            copyFileSync(f, join(deployPath, f));
          }
          console.log(`\x1b[32m✓ Copied main.js, manifest.json, styles.css → ${deployPath}\x1b[0m`);
        } catch (e) {
          console.error(`\x1b[31m✗ Copy failed: ${e.message}\x1b[0m`);
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
}
