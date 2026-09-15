#!/usr/bin/env node

// Renames the built CSS and JS to include a hash of their own contents, then
// repoints the emitted HTML at the new names. Runs as `build:fingerprint`, which
// must stay last in `npm run build` - it rewrites what `build:site`, `build:js`
// and `tailwind` produced, so all three have to have run.
//
// The problem it solves: the filenames were fixed, so a deploy changed what
// /style/main.css contained without changing its URL. A browser holding the old
// copy has no reason to ask for it again, and Cloudflare serves these with
// max-age=14400, so for four hours after a deploy a returning visitor gets fresh
// HTML wired to stale CSS and JS. That is not a corner case: it is everyone who
// visited in the four hours before the deploy. It shipped the Safari mosaic fix
// to production and left the site looking unfixed on a phone that had been there
// earlier the same day.
//
// A hashed name makes the URL change whenever the bytes do, so the stale copy is
// never the one the page asks for. It also means the assets can be cached hard
// rather than briefly, since a URL's contents can no longer change - see the
// immutable rules in public/_headers.
//
// Not run in dev: `npm run dev` rebuilds these files continuously and the
// templates reference them unhashed, so watch mode wants the plain names.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DIST = "dist";

// Every first-party asset the templates link to. Each is referenced from exactly
// one template, and nothing off-site links to them, so the names are ours to
// change. Third-party scripts (Typekit, Turnstile, highlight.js) are loaded from
// their own origins and are not ours to fingerprint.
const ASSET_DIRS = [
  { dir: "scripts", ext: ".js" },
  { dir: "style", ext: ".css" },
  { dir: ".", ext: ".js", only: ["umami.js"] },
];

/** `main.a1b2c3d4.js` - what this script produces, and what it cleans up. */
const HASHED = /\.[0-9a-f]{8}(\.[a-z0-9]+)$/;

const sha8 = (buf) =>
  crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);

const listFiles = async (dir) => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
};

/** Every .html under dist, at any depth - docs and cli pages are nested. */
const htmlFiles = async (dir) => {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
};

const renames = new Map(); // "/style/main.css" -> "/style/main.a1b2c3d4.css"

for (const { dir, ext, only } of ASSET_DIRS) {
  const here = path.join(DIST, dir);
  const files = await listFiles(here);

  // Copies left by an earlier local build. The plain names have just been
  // regenerated, so anything already hashed is a previous run's output and would
  // otherwise pile up in dist forever.
  for (const name of files.filter((f) => HASHED.test(f))) {
    await fs.rm(path.join(here, name));
  }

  const sources = files.filter(
    (f) =>
      f.endsWith(ext) &&
      !HASHED.test(f) &&
      // Source maps are dev-only output; in a production build there are none,
      // and a stale one from a local dev run should not be published as an asset.
      !f.endsWith(".map") &&
      (!only || only.includes(f)),
  );

  for (const name of sources) {
    const from = path.join(here, name);
    const hash = sha8(await fs.readFile(from));
    const hashed = `${path.basename(name, ext)}.${hash}${ext}`;
    await fs.rename(from, path.join(here, hashed));
    const urlDir = dir === "." ? "" : `/${dir}`;
    renames.set(`${urlDir}/${name}`, `${urlDir}/${hashed}`);
  }
}

if (renames.size === 0) {
  console.error("fingerprint: found no assets to hash in dist/ - did the build run?");
  process.exit(1);
}

const pages = await htmlFiles(DIST);
let rewritten = 0;
for (const page of pages) {
  const before = await fs.readFile(page, "utf8");
  let after = before;
  for (const [from, to] of renames) {
    // The quote keeps this to whole attribute values, so /style/main.css cannot
    // match inside a longer path that merely starts the same way.
    after = after.split(`"${from}"`).join(`"${to}"`);
  }
  if (after !== before) {
    await fs.writeFile(page, after);
    rewritten += 1;
  }
}

// A reference the rewrite missed would ship as a 404, and the page would lose
// its stylesheet or its script with nothing in the build to say so.
const missed = [];
for (const page of pages) {
  const html = await fs.readFile(page, "utf8");
  for (const from of renames.keys()) {
    if (html.includes(`"${from}"`)) missed.push(`${page} still links ${from}`);
  }
}
if (missed.length) {
  console.error("fingerprint: unrewritten references:\n  " + missed.join("\n  "));
  process.exit(1);
}

for (const [from, to] of renames) console.log(`  ${from} -> ${to}`);
console.log(
  `fingerprint: hashed ${renames.size} assets, rewrote ${rewritten} of ${pages.length} pages`,
);
