// Comments for archival.dev updates, running as a Val Town HTTP val against
// Val Town's SQLite. See README.md in this directory for deployment.
//
// GET  /counts?slugs=a,b,c   -> { counts: { slug: number } }
// GET  /thread?slug=a        -> { slug, count, comments: [...] }
// POST /comments             -> { comment }
// POST /moderate             -> { ok: true }   (admin token)

import { sqlite } from "https://esm.town/v/std/sqlite";

const TABLE = "archival_comments_v1";
// Hiding a comment hides the replies hanging off it too, so a thread never
// keeps answers to something nobody can read.
const VISIBLE_JOIN = `LEFT JOIN ${TABLE} p ON p.id = c.parent_id
  WHERE c.hidden = 0 AND (c.parent_id IS NULL OR p.hidden = 0)`;

const MAX_AUTHOR = 60;
const MAX_BODY = 2000;
const MAX_SLUGS_PER_REQUEST = 200;
// Turnstile already stops the drive-by case. This is the ceiling on what one
// network can do after clearing it.
const RATE_LIMIT_COMMENTS = 5;
const RATE_LIMIT_MINUTES = 10;

const DEFAULT_ORIGINS = [
  "https://archival.dev",
  "https://www.archival.dev",
  "https://archival-staging.dev",
  "https://www.archival-staging.dev",
];

type Role = "reader" | "team";

interface CommentRow {
  id: number;
  slug: string;
  parent_id: number | null;
  author: string;
  body: string;
  role: Role;
  created_at: string;
}

interface Comment {
  id: number;
  parentId: number | null;
  author: string;
  body: string;
  role: Role;
  createdAt: string;
  replies?: Comment[];
}

let ready: Promise<void> | null = null;

const init = () => {
  ready ??= (async () => {
    await sqlite.execute(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        parent_id INTEGER REFERENCES ${TABLE}(id),
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'reader',
        created_at TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        ip_hash TEXT
      )
    `);
    await sqlite.execute(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_slug ON ${TABLE} (slug, id)`,
    );
  })();
  return ready;
};

interface ResultSet {
  columns: string[];
  rows: unknown[];
}

const toObjects = <T>(result: ResultSet): T[] =>
  result.rows.map((row) =>
    Array.isArray(row)
      ? (Object.fromEntries(
          result.columns.map((column, i) => [column, row[i]]),
        ) as T)
      : (row as T),
  );

const allowedOrigins = () => {
  const configured = Deno.env.get("ALLOWED_ORIGINS");
  return configured
    ? configured.split(",").map((origin) => origin.trim())
    : DEFAULT_ORIGINS;
};

const corsHeaders = (request: Request): Record<string, string> => {
  const origin = request.headers.get("origin") ?? "";
  const allowed =
    allowedOrigins().includes(origin) ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
  return {
    "access-control-allow-origin": allowed ? origin : DEFAULT_ORIGINS[0],
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
};

const json = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(request),
    },
  });

const fail = (request: Request, status: number, error: string) =>
  json(request, { error }, status);

const isSlug = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,120}$/.test(value);

/** Collapses runs of whitespace but keeps paragraph breaks. */
const cleanBody = (value: string) =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const hashIp = async (request: Request) => {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const salt = Deno.env.get("IP_HASH_SALT") ?? "archival-comments";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${ip}`),
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const verifyTurnstile = async (token: string, request: Request) => {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form },
  );
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
};

const isAdmin = (request: Request) => {
  const token = Deno.env.get("COMMENTS_ADMIN_TOKEN");
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "");
  if (presented.length !== token.length) return false;
  // Constant time, so a wrong token leaks nothing about the right one.
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) {
    diff |= token.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
};

/** Top-level comments first, each with its replies in posting order. */
const nest = (rows: CommentRow[]): Comment[] => {
  const byId = new Map<number, Comment>();
  const roots: Comment[] = [];
  rows.forEach((row) => {
    byId.set(row.id, {
      id: row.id,
      parentId: row.parent_id,
      author: row.author,
      body: row.body,
      role: row.role,
      createdAt: row.created_at,
      replies: [],
    });
  });
  rows.forEach((row) => {
    const comment = byId.get(row.id)!;
    const parent = row.parent_id === null ? null : byId.get(row.parent_id);
    if (parent) parent.replies!.push(comment);
    else roots.push(comment);
  });
  return roots;
};

const readCounts = async (request: Request, url: URL) => {
  const requested = (url.searchParams.get("slugs") ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  if (requested.length > MAX_SLUGS_PER_REQUEST) {
    return fail(request, 400, "Too many slugs.");
  }
  if (requested.some((slug) => !isSlug(slug))) {
    return fail(request, 400, "Bad slug.");
  }

  const result = requested.length
    ? await sqlite.execute({
        sql: `SELECT c.slug AS slug, COUNT(*) AS total FROM ${TABLE} c ${VISIBLE_JOIN}
              AND c.slug IN (${requested.map(() => "?").join(",")})
              GROUP BY c.slug`,
        args: requested,
      })
    : await sqlite.execute(
        `SELECT c.slug AS slug, COUNT(*) AS total FROM ${TABLE} c ${VISIBLE_JOIN} GROUP BY c.slug`,
      );

  const counts: Record<string, number> = {};
  requested.forEach((slug) => {
    counts[slug] = 0;
  });
  toObjects<{ slug: string; total: number }>(result as ResultSet).forEach(
    (row) => {
      counts[row.slug] = Number(row.total);
    },
  );
  return json(request, { counts });
};

const readThread = async (request: Request, url: URL) => {
  const slug = url.searchParams.get("slug");
  if (!isSlug(slug)) return fail(request, 400, "Bad slug.");

  const result = await sqlite.execute({
    sql: `SELECT c.id AS id, c.slug AS slug, c.parent_id AS parent_id,
                 c.author AS author, c.body AS body, c.role AS role,
                 c.created_at AS created_at
          FROM ${TABLE} c ${VISIBLE_JOIN} AND c.slug = ? ORDER BY c.id ASC`,
    args: [slug],
  });
  const rows = toObjects<CommentRow>(result as ResultSet);
  return json(request, { slug, count: rows.length, comments: nest(rows) });
};

const postComment = async (request: Request) => {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(request, 400, "Expected JSON.");
  }

  const { slug, author, body, parentId, turnstileToken } = payload;
  if (!isSlug(slug)) return fail(request, 400, "Bad slug.");

  const cleanAuthor = typeof author === "string" ? author.trim() : "";
  const cleanText = typeof body === "string" ? cleanBody(body) : "";
  if (!cleanAuthor || cleanAuthor.length > MAX_AUTHOR) {
    return fail(request, 400, "Add a name, up to 60 characters.");
  }
  if (!cleanText || cleanText.length > MAX_BODY) {
    return fail(request, 400, "Add a comment, up to 2000 characters.");
  }

  const admin = isAdmin(request);
  const role: Role = admin ? "team" : "reader";
  if (!admin) {
    if (typeof turnstileToken !== "string" || !turnstileToken) {
      return fail(request, 400, "Missing challenge.");
    }
    if (!(await verifyTurnstile(turnstileToken, request))) {
      return fail(request, 403, "The challenge didn't pass.");
    }
  }

  const ipHash = await hashIp(request);
  if (!admin) {
    const recent = await sqlite.execute({
      sql: `SELECT COUNT(*) AS total FROM ${TABLE}
            WHERE ip_hash = ? AND role != 'team' AND created_at > datetime('now', ?)`,
      args: [ipHash, `-${RATE_LIMIT_MINUTES} minutes`],
    });
    const [{ total }] = toObjects<{ total: number }>(recent as ResultSet);
    if (Number(total) >= RATE_LIMIT_COMMENTS) {
      return fail(request, 429, "That's a lot of comments. Try again shortly.");
    }
  }

  // Threads are one level deep: a reply to a reply joins the same thread, so
  // the conversation stays readable on a phone.
  let parent: number | null = null;
  if (typeof parentId === "number" && Number.isInteger(parentId)) {
    const found = await sqlite.execute({
      sql: `SELECT id, parent_id FROM ${TABLE} WHERE id = ? AND slug = ? AND hidden = 0`,
      args: [parentId, slug],
    });
    const rows = toObjects<{ id: number; parent_id: number | null }>(
      found as ResultSet,
    );
    if (!rows.length) return fail(request, 404, "That comment is gone.");
    parent = rows[0].parent_id === null ? rows[0].id : rows[0].parent_id;
  }

  const createdAt = new Date().toISOString();
  const inserted = await sqlite.execute({
    sql: `INSERT INTO ${TABLE} (slug, parent_id, author, body, role, created_at, ip_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [slug, parent, cleanAuthor, cleanText, role, createdAt, ipHash],
  });

  const comment: Comment = {
    id: Number(
      (inserted as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0,
    ),
    parentId: parent,
    author: cleanAuthor,
    body: cleanText,
    role,
    createdAt,
  };
  return json(request, { comment }, 201);
};

const moderate = async (request: Request) => {
  if (!isAdmin(request)) return fail(request, 401, "Nope.");
  const { id, hidden } = (await request.json()) as {
    id?: number;
    hidden?: boolean;
  };
  if (typeof id !== "number") return fail(request, 400, "Which comment?");
  await sqlite.execute({
    sql: `UPDATE ${TABLE} SET hidden = ? WHERE id = ?`,
    args: [hidden === false ? 0 : 1, id],
  });
  return json(request, { ok: true });
};

export default async function (request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    await init();
    if (request.method === "GET" && path === "/counts") {
      return await readCounts(request, url);
    }
    if (request.method === "GET" && path === "/thread") {
      return await readThread(request, url);
    }
    if (request.method === "POST" && path === "/comments") {
      return await postComment(request);
    }
    if (request.method === "POST" && path === "/moderate") {
      return await moderate(request);
    }
    return fail(request, 404, "No such endpoint.");
  } catch (error) {
    console.error(error);
    return fail(request, 500, "Something went wrong.");
  }
}
