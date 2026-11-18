#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help") || args.length < 2) {
  console.log("Usage: build.mjs <t3code tree> <out dir> [--dev]\n  Bundles the AI plugin's chat page into <out dir>, resolving T3's contracts and Effect from <t3code tree>.");
  process.exit(args.includes("--help") ? 0 : 1);
}
const [tree, out] = args.map((a) => resolve(a));
const dev = args.includes("--dev");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, "src/main.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["safari17"],
  jsx: "automatic",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  nodePaths: [join(tree, "apps/web/node_modules")],
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  outfile: join(out, "app.js"),
  logLevel: "warning",
});

copyFileSync(join(here, "index.html"), join(out, "index.html"));
copyFileSync(join(here, "src/styles.css"), join(out, "styles.css"));
copyFileSync(join(here, "src/tokens.css"), join(out, "tokens.css"));
console.log(`page built in ${out}`);
