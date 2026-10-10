#!/usr/bin/env node
// Copies every comment thread from the old Val Town val into the comments
// carrier. Run once, after the carrier is deployed and admin_token is set:
//
//   COMMENTS_ADMIN_TOKEN=... ./scripts/migrate-comments.mjs <val url> <carrier url>
//
// The val lists only visible comments, so hidden ones stay behind.

const [valUrl, carrierUrl] = process.argv.slice(2);
const token = process.env.COMMENTS_ADMIN_TOKEN;

if (!valUrl || !carrierUrl || !token) {
  console.error(
    "usage: COMMENTS_ADMIN_TOKEN=... migrate-comments.mjs <val url> <carrier url>",
  );
  process.exit(1);
}

const read = async (path) => {
  const response = await fetch(`${valUrl.replace(/\/+$/, "")}${path}`);
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}`);
  }
  return response.json();
};

const { counts } = await read("/counts");
const slugs = Object.keys(counts).filter((slug) => counts[slug] > 0);
console.log(`${slugs.length} thread(s) to copy`);

let total = 0;
for (const slug of slugs) {
  const { comments } = await read(`/thread?slug=${encodeURIComponent(slug)}`);
  const response = await fetch(carrierUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "import", token, slug, comments }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${slug}: ${result.error ?? response.status}`);
  }
  console.log(`${slug}: ${result.imported}`);
  total += result.imported;
}
console.log(`copied ${total} comment(s)`);
