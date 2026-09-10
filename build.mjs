#!/usr/bin/env node

import esbuild from "esbuild";
import metaUrlPlugin from "@chialab/esbuild-plugin-meta-url";

const dev = process.argv.includes("--dev");
const staging = process.argv.includes("--staging");

// Turnstile sitekeys are public. The dev value is Cloudflare's published
// always-passes test key, so local work needs no widget of its own:
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const API_URL = dev
  ? "http://localhost:8777"
  : staging
    ? "https://api.archival-staging.dev"
    : "https://api.archival.dev";
// Where the template gallery lives, and where templates.json and the template
// thumbnails are served from. It answers with access-control-allow-origin: *,
// so the mosaic can read the catalog at runtime.
const EDITOR_URL = dev
  ? "http://localhost:8788"
  : staging
    ? "https://editor.archival-staging.dev"
    : "https://editor.archival.dev";
const TURNSTILE_SITE_KEY = dev
  ? "1x00000000000000000000AA"
  : staging
    ? "0x4AAAAAAEZffDvzgSX4xffU"
    : "0x4AAAAAAEZfb1ZNwVKPq0Eq";

const ctx = await esbuild.context({
  entryPoints: {
    main: "src/index.ts",
    "build-with-claude": "src/build-with-claude.ts",
    link: "src/link.ts",
    updates: "src/updates.ts",
  },
  bundle: true,
  outdir: "dist/scripts",
  plugins: [metaUrlPlugin()],
  define: {
    DEV: dev ? "true" : "false",
    EDITOR_URL: `"${EDITOR_URL}"`,
    API_URL: `"${API_URL}"`,
    TURNSTILE_SITE_KEY: `"${TURNSTILE_SITE_KEY}"`,
  },
  format: "esm",
  target: "es2022",
  sourcemap: dev,
});

if (dev) {
  await ctx.watch();

  const { host, port } = await ctx.serve({ servedir: "dist" });
  console.log(`server started at http://${host}:${port}`);
} else {
  await ctx.rebuild();
  process.exit(0);
}
