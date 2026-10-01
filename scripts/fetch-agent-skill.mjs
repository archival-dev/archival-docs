#!/usr/bin/env node

// Mirrors the agent contract - the skill a coding agent follows to build and
// publish an Archival site - into public/agent/, so it is served from
// https://archival.dev/agent/. Runs as `build:agent`, which must stay ahead of
// `build:site` in `npm run build`: that is the step that copies public/ into
// dist/.
//
// The canonical copy lives in archival, as a Claude Code plugin, so there is
// exactly one to keep correct. That copy is also the one a Claude Code *cloud*
// session can reach: raw.githubusercontent.com is on the default network
// allowlist and archival.dev is not. This mirror exists for humans, for agents
// that would rather read one documented URL, and so the contract is linkable
// from the docs.

import fs from "node:fs/promises";
import path from "node:path";

// Destination path -> path within the archival repo.
const FILES = {
  "build-site.md": "plugins/archival/skills/new/SKILL.md",
  "edit-site.md": "plugins/archival/skills/site/SKILL.md",
  "reference/authoring.md":
    "plugins/archival/skills/new/reference/authoring.md",
  "reference/conventions.md":
    "plugins/archival/skills/new/reference/conventions.md",
  "reference/local.md": "plugins/archival/skills/new/reference/local.md",
  "reference/publishing.md":
    "plugins/archival/skills/new/reference/publishing.md",
  "install-archival.sh": "plugins/archival/bin/install-archival.sh",
  "site-info.sh": "plugins/archival/bin/site-info.sh",
};

// Same reasoning as the schemas: the skill ships from main rather than a tag,
// because it describes the current API and the currently released CLI, neither
// of which moves with an archival version bump.
const REF = process.env.ARCHIVAL_AGENT_REF ?? "refs/heads/main";
// ARCHIVAL_AGENT_SOURCE points the fetch elsewhere - an absolute path to a
// local archival checkout, or another base URL - to try contract changes here
// before they land upstream.
const SOURCE =
  process.env.ARCHIVAL_AGENT_SOURCE ??
  `https://raw.githubusercontent.com/archival-dev/archival/${REF}`;

const outDir = new URL("../public/agent/", import.meta.url).pathname;

const read = async (repoPath) => {
  if (SOURCE.startsWith("/")) {
    return await fs.readFile(path.join(SOURCE, repoPath), "utf8");
  }
  const url = `${SOURCE}/${repoPath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `fetching ${url}: ${response.status} ${response.statusText}. ` +
        `The agent contract must be merged to archival before this site builds.`,
    );
  }
  return await response.text();
};

await Promise.all(
  Object.entries(FILES).map(async ([dest, repoPath]) => {
    const body = await read(repoPath);
    const target = path.join(outDir, dest);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    console.log(`agent: ${dest} <- ${repoPath}`);
  }),
);
