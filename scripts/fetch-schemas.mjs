#!/usr/bin/env node

// Fetches archival's JSON Schema files into public/schemas/ so they are served
// from https://archival.dev/schemas/. Runs as `build:schemas`, which must stay
// ahead of `build:site` in `npm run build` - that is the step that copies
// public/ into dist/.
//
// The schemas are fetched from archival so there is exactly one copy to keep
// correct. archival's CI gates their correctness (`cargo test
// schema_files` plus Ajv strict mode in ./validate-schemas.sh).

import fs from "node:fs/promises";
import path from "node:path";

const SCHEMAS = [
  "archival.schema.json",
  "archival_objects.schema.json",
  "archival_editor.schema.json",
  "archival_template.schema.json",
];

// SchemaStore's catalog still fetches these two by their old names. The copies
// are byte-identical, so their `$id` still names the canonical URL, which is
// what `$ref` and editor caches key on. They can go once the corrected catalog
// has shipped widely.
const ALIASES = {
  "manifest.schema.json": "archival.schema.json",
  "objects.schema.json": "archival_objects.schema.json",
};

// Schemas ship from main; archival's CI gates them on every push. Set
// ARCHIVAL_SCHEMA_REF to pin to a tag (e.g. "refs/tags/v0.17.0") if that ever
// stops being true.
const REF = process.env.ARCHIVAL_SCHEMA_REF ?? "refs/heads/main";
// ARCHIVAL_SCHEMA_SOURCE points the fetch somewhere else entirely - a local
// server in front of an archival checkout, say - to try schema changes here
// before they land upstream.
const SOURCE =
  process.env.ARCHIVAL_SCHEMA_SOURCE ??
  `https://raw.githubusercontent.com/archival-dev/archival/${REF}`;
const CANONICAL_ID_PREFIX = "https://archival.dev/schemas/";

const outDir = new URL("../public/schemas/", import.meta.url).pathname;

await fs.mkdir(outDir, { recursive: true });

await Promise.all(
  SCHEMAS.map(async (name) => {
    const url = `${SOURCE}/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`fetching ${url}: ${response.status} ${response.statusText}`);
    }
    const body = await response.text();

    let schema;
    try {
      schema = JSON.parse(body);
    } catch (e) {
      throw new Error(`${url} is not valid JSON: ${e.message}`);
    }

    const expectedId = `${CANONICAL_ID_PREFIX}${name}`;
    if (schema.$id !== expectedId) {
      throw new Error(
        `${url} declares $id ${JSON.stringify(schema.$id)}, but it is served ` +
          `from ${expectedId}. Fix $id in archival before deploying - editors ` +
          `resolve $ref and cache against it.`,
      );
    }

    await fs.writeFile(path.join(outDir, name), body);
    console.log(`schemas: ${name} <- ${url}`);

    for (const [alias, canonical] of Object.entries(ALIASES)) {
      if (canonical === name) {
        await fs.writeFile(path.join(outDir, alias), body);
        console.log(`schemas: ${alias} <- ${name} (alias)`);
      }
    }
  }),
);
