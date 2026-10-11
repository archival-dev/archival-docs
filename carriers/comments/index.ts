// Comments on archival.dev updates. One thread per update merges three
// sources: comments posted on the site itself (kept in site.sql), replies from
// the fediverse to the update's ActivityPub post, and webmention replies from
// other sites. See README.md for the endpoints.
//
// GET  ?slugs=a,b,c                        -> { counts: { slug: number } }
// GET  ?slug=a                             -> { slug, count, account, reactions, comments }
// POST { slug, author, body, parentId?, turnstileToken?, token? } -> { comment }
// POST { action: "moderate", token, id, hidden }                 -> { ok: true }

import type {
  Carrier,
  CarrierActivityPub,
  CarrierReply,
  CarrierSite,
  CarrierSqlRow,
  CarrierWebmention,
  CarrierWebmentions,
} from "@archival/carrier";

const TABLE = "comments_v1";
const MAX_AUTHOR = 60;
const MAX_BODY = 2000;
const MAX_SLUGS_PER_REQUEST = 200;
const MAX_REMOTE_PAGES = 10;
// Turnstile stops the drive-by case. A carrier never sees the request's
// address, so the ceilings below are per thread and per site, not per visitor.
const RATE_LIMIT_MINUTES = 10;
const RATE_LIMIT_PER_SLUG = 20;
const RATE_LIMIT_PER_SITE = 60;
// Cloudflare's published always-passes pair, for archival run without a secret.
const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";

type Role = "reader" | "team";
type Source = "local" | "fediverse" | "webmention";

interface LocalRow extends CarrierSqlRow {
  id: number;
  parent_id: string | null;
  author: string;
  body: string;
  role: Role;
  created_at: string;
}

interface Author {
  name: string;
  url: string | null;
  handle: string | null;
  icon: string | null;
}

interface Comment {
  id: string;
  parentId: string | null;
  source: Source;
  role: Role;
  author: Author;
  /** Plain text, for a comment posted on the site. */
  body: string | null;
  /** Reduced HTML, for a reply from the fediverse or another site. */
  html: string | null;
  /** The reply's own page elsewhere. */
  url: string | null;
  createdAt: string;
  replies: Comment[];
}

type Objects = Parameters<Carrier>[2];
type Update = Objects["update"][number];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const fail = (status: number, error: string) => json({ error }, status);

const isSlug = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,120}$/.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Collapses runs of whitespace but keeps paragraph breaks. */
const cleanBody = (value: string) =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const localId = (id: number) => `l:${id}`;
const fediverseId = (id: string) => `ap:${id}`;
const webmentionId = (source: string) => `wm:${source}`;

let ready: Promise<void> | null = null;

const init = (site: CarrierSite) => {
  ready ??= site.sql
    .transaction([
      [
        `CREATE TABLE IF NOT EXISTS ${TABLE} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL,
          parent_id TEXT,
          author TEXT NOT NULL,
          body TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'reader',
          created_at TEXT NOT NULL,
          hidden INTEGER NOT NULL DEFAULT 0
        )`,
      ],
      [`CREATE INDEX IF NOT EXISTS ${TABLE}_slug ON ${TABLE} (slug, id)`],
      [
        `CREATE INDEX IF NOT EXISTS ${TABLE}_created ON ${TABLE} (created_at)`,
      ],
    ])
    .then(() => undefined);
  return ready;
};

// Hiding a comment hides the replies hanging off it too, so a thread never
// keeps answers to something nobody can read.
const VISIBLE = `FROM ${TABLE} c
  LEFT JOIN ${TABLE} p ON 'l:' || p.id = c.parent_id
  WHERE c.hidden = 0 AND (p.id IS NULL OR p.hidden = 0)`;

const localThread = (site: CarrierSite, slug: string) =>
  site.sql.exec<LocalRow>(
    `SELECT c.id AS id, c.parent_id AS parent_id, c.author AS author,
            c.body AS body, c.role AS role, c.created_at AS created_at
     ${VISIBLE} AND c.slug = ? ORDER BY c.id ASC`,
    slug,
  );

const localCounts = async (site: CarrierSite, slugs: string[]) => {
  const counts = new Map<string, number>();
  for (let i = 0; i < slugs.length; i += 100) {
    const chunk = slugs.slice(i, i + 100);
    const rows = await site.sql.exec<{ slug: string; total: number }>(
      `SELECT c.slug AS slug, COUNT(*) AS total ${VISIBLE}
       AND c.slug IN (${chunk.map(() => "?").join(",")}) GROUP BY c.slug`,
      ...chunk,
    );
    rows.forEach((row) => counts.set(row.slug, Number(row.total)));
  }
  return counts;
};

const allPages = async <T>(
  read: (cursor?: string) => Promise<{ items: T[]; next: string | null }>,
) => {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_REMOTE_PAGES; i += 1) {
    const page = await read(cursor);
    items.push(...page.items);
    if (!page.next) break;
    cursor = page.next;
  }
  return items;
};

const fediverseReplies = (site: CarrierSite, post: Update) =>
  allPages<CarrierReply>((cursor) =>
    activitypub(site).replies(post, { limit: 100, cursor }),
  );

const webmentionReplies = (site: CarrierSite, post: Update) =>
  allPages<CarrierWebmention>((cursor) =>
    webmentions(site).list(post, { kind: "reply", limit: 100, cursor }),
  );

const emptyPage = async () => ({ items: [], total: 0, next: null });

// An archival CLI older than the carrier API it runs leaves these off `site`.
// Reading them as a site that doesn't federate matches what a deployed site
// without the sections does.
const activitypub = (site: CarrierSite): CarrierActivityPub =>
  site.activitypub ?? {
    account: async () => null,
    followers: emptyPage,
    counts: async (posts) =>
      posts.map(() => ({ likes: 0, boosts: 0, replies: 0 })),
    likes: emptyPage,
    boosts: emptyPage,
    replies: emptyPage,
    setLocalLikes: async () => undefined,
  };

const webmentions = (site: CarrierSite): CarrierWebmentions =>
  site.webmentions ?? {
    counts: async (pages) =>
      pages.map(() => ({
        replies: 0,
        likes: 0,
        reposts: 0,
        bookmarks: 0,
        mentions: 0,
      })),
    list: emptyPage,
  };

const hostOf = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * An entry in comments.blocked matches a reply's id, page, account or site.
 * A bare hostname blocks every account on that server.
 */
const blocker = (blocked: { url: string | null }[]) => {
  const exact = new Set<string>();
  const hosts = new Set<string>();
  blocked.forEach(({ url }) => {
    const value = url?.trim().toLowerCase();
    if (!value) return;
    exact.add(value.replace(/\/+$/, ""));
    if (!/[/\s@]/.test(value)) hosts.add(value);
    const host = hostOf(value);
    if (host && /^https?:\/\/[^/]+\/?$/.test(value)) hosts.add(host);
  });
  return (...candidates: (string | null)[]) =>
    candidates.some((candidate) => {
      if (!candidate) return false;
      const value = candidate.toLowerCase().replace(/\/+$/, "");
      if (exact.has(value)) return true;
      const host = hostOf(value) ?? value.replace(/^@[^@]*@/, "");
      return hosts.has(host);
    });
};

const fromLocal = (row: LocalRow): Comment => ({
  id: localId(row.id),
  parentId: row.parent_id,
  source: "local",
  role: row.role === "team" ? "team" : "reader",
  author: { name: row.author, url: null, handle: null, icon: null },
  body: row.body,
  html: null,
  url: null,
  createdAt: row.created_at,
  replies: [],
});

const fromFediverse = (reply: CarrierReply, known: Set<string>): Comment => ({
  id: fediverseId(reply.id),
  parentId: known.has(reply.inReplyTo) ? fediverseId(reply.inReplyTo) : null,
  source: "fediverse",
  role: "reader",
  author: {
    name: reply.account.name || reply.account.handle || "Someone",
    url: reply.account.url,
    handle: reply.account.handle,
    icon: reply.account.icon,
  },
  body: null,
  html: reply.content,
  url: reply.url,
  createdAt: reply.published,
  replies: [],
});

const fromWebmention = (mention: CarrierWebmention): Comment => ({
  id: webmentionId(mention.source),
  parentId: null,
  source: "webmention",
  role: "reader",
  author: {
    name: mention.author?.name || hostOf(mention.url) || "Someone",
    url: mention.author?.url ?? null,
    handle: null,
    icon: mention.author?.photo ?? null,
  },
  body: null,
  html: mention.content ?? (mention.name ? `<p>${escape(mention.name)}</p>` : ""),
  url: mention.url,
  createdAt: mention.published ?? mention.received,
  replies: [],
});

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const byDate = (a: Comment, b: Comment) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

/**
 * Threads are one level deep: a reply to a reply joins the same thread, so the
 * conversation stays readable on a phone. Anything whose parent is gone reads
 * as a top-level comment.
 */
const nest = (items: Comment[]) => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rootOf = (item: Comment): Comment => {
    let current = item;
    for (let depth = 0; depth < items.length; depth += 1) {
      const parent = current.parentId ? byId.get(current.parentId) : undefined;
      if (!parent || parent === item) break;
      current = parent;
    }
    return current;
  };
  const roots: Comment[] = [];
  items.forEach((item) => {
    const root = rootOf(item);
    if (root === item) {
      roots.push(item);
    } else {
      item.parentId = root.id;
      root.replies.push(item);
    }
  });
  roots.sort(byDate);
  roots.forEach((root) => root.replies.sort(byDate));
  return roots;
};

const readThread = async (
  site: CarrierSite,
  objects: Objects,
  slug: string,
) => {
  const post = findUpdate(objects, slug);
  if (!post) return fail(404, "No such update.");

  const [rows, replies, mentions, account, [apCounts], [wmCounts]] =
    await Promise.all([
      localThread(site, slug),
      fediverseReplies(site, post),
      webmentionReplies(site, post),
      activitypub(site).account(),
      activitypub(site).counts([post]),
      webmentions(site).counts([post]),
    ]);

  const blocked = blocker(objects.comments.blocked);
  const knownReplies = new Set(replies.map((reply) => reply.id));
  const items = [
    ...rows.map(fromLocal),
    ...replies
      .filter(
        (reply) =>
          !blocked(
            reply.id,
            reply.url,
            reply.account.id,
            reply.account.url,
            reply.account.handle,
          ),
      )
      .map((reply) => fromFediverse(reply, knownReplies)),
    ...mentions
      .filter(
        (mention) =>
          !blocked(mention.source, mention.url, mention.author?.url ?? null),
      )
      .map(fromWebmention),
  ];

  return json({
    slug,
    count: items.length,
    account: account ? { handle: account.handle, url: account.url } : null,
    reactions: {
      likes: apCounts.likes + wmCounts.likes,
      boosts: apCounts.boosts + wmCounts.reposts,
      mentions: wmCounts.mentions + wmCounts.bookmarks,
    },
    comments: nest(items),
  });
};

const readCounts = async (
  site: CarrierSite,
  objects: Objects,
  requested: string[],
) => {
  if (requested.length > MAX_SLUGS_PER_REQUEST) {
    return fail(400, "Too many slugs.");
  }
  if (requested.some((slug) => !isSlug(slug))) return fail(400, "Bad slug.");

  const posts = requested
    .map((slug) => findUpdate(objects, slug))
    .filter((post): post is Update => post !== undefined);
  const remote = new Map<string, number>();
  for (let i = 0; i < posts.length; i += 100) {
    const chunk = posts.slice(i, i + 100);
    const [ap, wm] = await Promise.all([
      activitypub(site).counts(chunk),
      webmentions(site).counts(chunk),
    ]);
    chunk.forEach((post, index) => {
      remote.set(post.path, ap[index].replies + wm[index].replies);
    });
  }
  const local = await localCounts(site, requested);

  const counts: Record<string, number> = {};
  requested.forEach((slug) => {
    counts[slug] = (local.get(slug) ?? 0) + (remote.get(updatePath(slug)) ?? 0);
  });
  return json({ counts });
};

const verifyTurnstile = async (token: string, secret: string) => {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form },
  );
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
};

const isLocalRun = (site: CarrierSite) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(site.url);

const isAdmin = (presented: unknown, objects: Objects) => {
  const token = objects.comments.admin_token;
  if (!token || typeof presented !== "string") return false;
  if (presented.length !== token.length) return false;
  // Constant time, so a wrong token leaks nothing about the right one.
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) {
    diff |= token.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
};

/** Resolves the id a new reply should hang off, or null for a new thread. */
const resolveParent = async (
  site: CarrierSite,
  post: Update,
  slug: string,
  parentId: unknown,
): Promise<string | null | undefined> => {
  if (parentId === null || parentId === undefined) return null;
  if (typeof parentId !== "string") return undefined;

  if (parentId.startsWith("l:")) {
    const id = Number(parentId.slice(2));
    if (!Number.isInteger(id)) return undefined;
    const [row] = await site.sql.exec<{ id: number; parent_id: string | null }>(
      `SELECT id, parent_id FROM ${TABLE} WHERE id = ? AND slug = ? AND hidden = 0`,
      id,
      slug,
    );
    if (!row) return undefined;
    return row.parent_id ?? localId(row.id);
  }

  if (parentId.startsWith("ap:")) {
    const replies = await fediverseReplies(site, post);
    const known = new Set(replies.map((reply) => reply.id));
    const target = replies.find((reply) => fediverseId(reply.id) === parentId);
    if (!target) return undefined;
    const [root] = nest(replies.map((reply) => fromFediverse(reply, known)));
    const found = [root, ...(root?.replies ?? [])].find(
      (item) => item.id === parentId,
    );
    return found?.parentId ?? found?.id ?? undefined;
  }

  if (parentId.startsWith("wm:")) {
    const mentions = await webmentionReplies(site, post);
    const target = mentions.find(
      (mention) => webmentionId(mention.source) === parentId,
    );
    return target ? parentId : undefined;
  }

  return undefined;
};

const insert = (
  site: CarrierSite,
  row: Omit<LocalRow, "id"> & { slug: string },
) =>
  site.sql
    .exec<{ id: number }>(
      `INSERT INTO ${TABLE} (slug, parent_id, author, body, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      row.slug,
      row.parent_id,
      row.author,
      row.body,
      row.role,
      row.created_at,
    )
    .then(([inserted]) => Number(inserted.id));

const postComment = async (
  site: CarrierSite,
  objects: Objects,
  payload: Record<string, unknown>,
) => {
  const { slug, author, body, parentId, turnstileToken, token } = payload;
  if (!isSlug(slug)) return fail(400, "Bad slug.");
  const post = findUpdate(objects, slug);
  if (!post) return fail(404, "No such update.");

  const cleanAuthor = typeof author === "string" ? author.trim() : "";
  const cleanText = typeof body === "string" ? cleanBody(body) : "";
  if (!cleanAuthor || cleanAuthor.length > MAX_AUTHOR) {
    return fail(400, `Add a name, up to ${MAX_AUTHOR} characters.`);
  }
  if (!cleanText || cleanText.length > MAX_BODY) {
    return fail(400, `Add a comment, up to ${MAX_BODY} characters.`);
  }

  const admin = isAdmin(token, objects);
  if (token && !admin) return fail(401, "That token is no longer good.");
  const role: Role = admin ? "team" : "reader";
  if (!admin) {
    const secret =
      objects.comments.turnstile_secret_key ||
      (isLocalRun(site) ? TEST_TURNSTILE_SECRET : "");
    if (!secret) return fail(503, "Comments aren't set up yet.");
    if (typeof turnstileToken !== "string" || !turnstileToken) {
      return fail(400, "Missing challenge.");
    }
    if (!(await verifyTurnstile(turnstileToken, secret))) {
      return fail(403, "The challenge didn't pass.");
    }

    const since = new Date(Date.now() - RATE_LIMIT_MINUTES * 60_000);
    const [recent] = await site.sql.exec<{ thread: number; site: number }>(
      `SELECT SUM(slug = ?) AS thread, COUNT(*) AS site FROM ${TABLE}
       WHERE role != 'team' AND created_at > ?`,
      slug,
      since.toISOString(),
    );
    if (
      Number(recent.thread) >= RATE_LIMIT_PER_SLUG ||
      Number(recent.site) >= RATE_LIMIT_PER_SITE
    ) {
      return fail(429, "That's a lot of comments. Try again shortly.");
    }
  }

  const parent = await resolveParent(site, post, slug, parentId);
  if (parent === undefined) return fail(404, "That comment is gone.");

  const createdAt = new Date().toISOString();
  const id = await insert(site, {
    slug,
    parent_id: parent,
    author: cleanAuthor,
    body: cleanText,
    role,
    created_at: createdAt,
  });

  const comment = fromLocal({
    id,
    parent_id: parent,
    author: cleanAuthor,
    body: cleanText,
    role,
    created_at: createdAt,
  });
  return json({ comment }, 201);
};

const moderate = async (
  site: CarrierSite,
  objects: Objects,
  payload: Record<string, unknown>,
) => {
  if (!isAdmin(payload.token, objects)) return fail(401, "Nope.");
  const { id, hidden } = payload;
  const local = typeof id === "string" && id.startsWith("l:") ? id.slice(2) : id;
  const numeric = Number(local);
  if (!Number.isInteger(numeric)) {
    return fail(400, "Only a comment posted here can be hidden. Block the rest in objects/comments.toml.");
  }
  await site.sql.exec(
    `UPDATE ${TABLE} SET hidden = ? WHERE id = ?`,
    hidden === false ? 0 : 1,
    numeric,
  );
  return json({ ok: true });
};

const updatePath = (slug: string) => `update/${slug}`;

const findUpdate = (objects: Objects, slug: string): Update | undefined =>
  objects.update.find((update) => update.path === updatePath(slug));

const carrier: Carrier = async (params, body, objects, site) => {
  try {
    await init(site);

    if (body === null) {
      const slug = params.get("slug");
      if (slug !== null) {
        if (!isSlug(slug)) return fail(400, "Bad slug.");
        return await readThread(site, objects, slug);
      }
      const slugs = params.get("slugs");
      if (slugs !== null) {
        const requested = slugs
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        return await readCounts(site, objects, requested);
      }
      return fail(400, "Pass slug or slugs.");
    }

    if (!isRecord(body)) return fail(400, "Expected JSON.");
    const payload = body as Record<string, unknown>;
    switch (payload.action) {
      case undefined:
      case "comment":
        return await postComment(site, objects, payload);
      case "moderate":
        return await moderate(site, objects, payload);
      default:
        return fail(400, "No such action.");
    }
  } catch (error) {
    console.error(error);
    return fail(500, "Something went wrong.");
  }
};

export default carrier;

export type { Comment, Author, Source, Role };
