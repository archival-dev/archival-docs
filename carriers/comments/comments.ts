import type {
  CarrierReply,
  CarrierSqlRow,
  CarrierWebmention,
} from "@archival/carrier";
import { actingUser, type Role } from "./auth.ts";
import { now } from "./db.ts";
import {
  activitypub,
  type Context,
  type Env,
  fail,
  findUpdate,
  isSlug,
  json,
  text,
  type Update,
  updatePath,
  webmentions,
} from "./http.ts";

const MAX_BODY = 2000;
const MAX_SLUGS = 100;
const MAX_REMOTE_PAGES = 10;
const HOUR_MS = 60 * 60 * 1000;
const COMMENTS_PER_HOUR = 10;
const SITE_COMMENTS_PER_HOUR = 60;

type Source = "local" | "fediverse" | "webmention";

interface CommentRow extends CarrierSqlRow {
  id: number;
  parent_id: string | null;
  user_id: number;
  author: string;
  role: string;
  body: string;
  created_at: string;
}

interface Author {
  name: string;
  url: string | null;
  handle: string | null;
  icon: string | null;
}

export interface Comment {
  /** "l:<row id>", "ap:<activitypub id>" or "wm:<source url>". */
  id: string;
  parentId: string | null;
  source: Source;
  role: Role;
  author: Author;
  /** The account that wrote a comment posted here. */
  authorId: number | null;
  /** Plain text, for a comment posted on the site. */
  body: string | null;
  /** Reduced HTML, for a reply from the fediverse or another site. */
  html: string | null;
  /** The reply's own page elsewhere. */
  url: string | null;
  createdAt: string;
  replies: Comment[];
}

const localId = (id: number) => `l:${id}`;
const fediverseId = (id: string) => `ap:${id}`;
const webmentionId = (source: string) => `wm:${source}`;

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const hostOf = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

const fromRow = (row: CommentRow): Comment => ({
  id: localId(row.id),
  parentId: row.parent_id,
  source: "local",
  role: row.role === "team" ? "team" : "reader",
  author: { name: row.author, url: null, handle: null, icon: null },
  authorId: Number(row.user_id),
  body: row.body,
  html: null,
  url: null,
  createdAt: row.created_at,
  replies: [],
});

const fromReply = (reply: CarrierReply, known: Set<string>): Comment => ({
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
  authorId: null,
  body: null,
  html: reply.content,
  url: reply.url,
  createdAt: reply.published,
  replies: [],
});

const fromMention = (mention: CarrierWebmention): Comment => ({
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
  authorId: null,
  body: null,
  html:
    mention.content ?? (mention.name ? `<p>${escape(mention.name)}</p>` : ""),
  url: mention.url,
  createdAt: mention.published ?? mention.received,
  replies: [],
});

const byDate = (a: Comment, b: Comment) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

/**
 * Threads are one level deep: a reply to a reply joins the same thread, so
 * the conversation stays readable on a phone. Anything whose parent is gone
 * reads as a top-level comment.
 */
export const nest = (items: Comment[]) => {
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

const fediverseReplies = (env: Env, post: Update) =>
  allPages<CarrierReply>((cursor) =>
    activitypub(env.site).replies(post, { limit: 100, cursor }),
  );

const webmentionReplies = (env: Env, post: Update) =>
  allPages<CarrierWebmention>((cursor) =>
    webmentions(env.site).list(post, { kind: "reply", limit: 100, cursor }),
  );

/**
 * An entry in comments.blocked matches a reply's id, page, account or site.
 * A bare hostname blocks every account on that server.
 */
const blocker = (env: Env) => {
  const exact = new Set<string>();
  const hosts = new Set<string>();
  env.objects.comments.blocked.forEach(({ url }) => {
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

// An account's current name and role, so a rename or a claimed team role
// reaches past comments.
const LOCAL_THREAD = `SELECT c.id, c.parent_id, c.user_id,
    coalesce(u.name, c.author) AS author, coalesce(u.role, 'reader') AS role,
    c.body, c.created_at
  FROM comments c LEFT JOIN users u ON u.id = c.user_id
  WHERE c.slug = ? ORDER BY c.id`;

export const thread = async (context: Context): Promise<Response> => {
  const slug = context.params.get("slug");
  if (!isSlug(slug)) return fail("Bad slug.");
  const post = findUpdate(context, slug);
  if (!post) return fail("No such update.", 404);

  const [rows, replies, mentions, account, [apCounts], [wmCounts]] =
    await Promise.all([
      context.db.all<CommentRow>(LOCAL_THREAD, slug),
      fediverseReplies(context, post),
      webmentionReplies(context, post),
      activitypub(context.site).account(),
      activitypub(context.site).counts([post]),
      webmentions(context.site).counts([post]),
    ]);

  const blocked = blocker(context);
  const known = new Set(replies.map((reply) => reply.id));
  const items = [
    ...rows.map(fromRow),
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
      .map((reply) => fromReply(reply, known)),
    ...mentions
      .filter(
        (mention) =>
          !blocked(mention.source, mention.url, mention.author?.url ?? null),
      )
      .map(fromMention),
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

export const counts = async (context: Context): Promise<Response> => {
  const requested = [
    ...new Set(
      (context.params.get("slugs") ?? "")
        .split(",")
        .map((slug) => slug.trim())
        .filter(Boolean),
    ),
  ];
  if (requested.length > MAX_SLUGS) return fail("Too many slugs.");
  if (requested.some((slug) => !isSlug(slug))) return fail("Bad slug.");

  const posts = requested
    .map((slug) => findUpdate(context, slug))
    .filter((post): post is Update => post !== undefined);
  const result: Record<string, number> = {};
  requested.forEach((slug) => {
    result[slug] = 0;
  });
  if (!posts.length) return json({ counts: result });

  const slugs = posts.map((post) => post.path.slice("update/".length));
  const [local, ap, wm] = await Promise.all([
    context.db.all<{ slug: string; n: number }>(
      `SELECT slug, count(*) AS n FROM comments
       WHERE slug IN (${slugs.map(() => "?").join(",")}) GROUP BY slug`,
      ...slugs,
    ),
    activitypub(context.site).counts(posts),
    webmentions(context.site).counts(posts),
  ]);
  slugs.forEach((slug, i) => {
    result[slug] = ap[i].replies + wm[i].replies;
  });
  local.forEach((row) => {
    result[row.slug] += Number(row.n);
  });
  return json({ counts: result });
};

/** Resolves the id a new reply should hang off, or null for a new thread. */
const resolveParent = async (
  env: Env,
  post: Update,
  slug: string,
  parentId: unknown,
): Promise<string | null | undefined> => {
  if (parentId === null || parentId === undefined) return null;
  if (typeof parentId !== "string") return undefined;

  if (parentId.startsWith("l:")) {
    const id = Number(parentId.slice(2));
    if (!Number.isInteger(id)) return undefined;
    const row = await env.db.one<{ id: number; parent_id: string | null }>(
      `SELECT id, parent_id FROM comments WHERE id = ? AND slug = ?`,
      id,
      slug,
    );
    if (!row) return undefined;
    return row.parent_id ?? localId(Number(row.id));
  }

  if (parentId.startsWith("ap:")) {
    const replies = await fediverseReplies(env, post);
    const known = new Set(replies.map((reply) => reply.id));
    const nested = nest(replies.map((reply) => fromReply(reply, known)));
    const found = nested
      .flatMap((root) => [root, ...root.replies])
      .find((item) => item.id === parentId);
    return found ? (found.parentId ?? found.id) : undefined;
  }

  if (parentId.startsWith("wm:")) {
    const mentions = await webmentionReplies(env, post);
    return mentions.some((mention) => webmentionId(mention.source) === parentId)
      ? parentId
      : undefined;
  }

  return undefined;
};

export const create = async (context: Context): Promise<Response> => {
  const body = context.body ?? {};
  const slug = body.slug;
  if (!isSlug(slug)) return fail("Bad slug.");
  const post = findUpdate(context, slug);
  if (!post) return fail("No such update.", 404);

  const content = text(body.body)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (!content || content.length > MAX_BODY) {
    return fail(`Add a comment, up to ${MAX_BODY} characters.`);
  }

  const user = await actingUser(context, "Sign in to comment.");
  if (user instanceof Response) return user;

  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const [recent] = await context.db.all<{ mine: number; all: number }>(
    `SELECT coalesce(sum(user_id = ?), 0) AS mine, count(*) AS "all"
     FROM comments WHERE created_at > ?`,
    user.id,
    since,
  );
  if (user.role !== "team") {
    if (Number(recent?.mine) >= COMMENTS_PER_HOUR) {
      return fail("That's a lot of comments. Try again in a bit.", 429);
    }
    if (Number(recent?.all) >= SITE_COMMENTS_PER_HOUR) {
      return fail("Lots of comments right now. Try again in a bit.", 429);
    }
  }

  const parent = await resolveParent(context, post, slug, body.parentId);
  if (parent === undefined) return fail("That comment is gone.", 404);

  const [row] = await context.db.all<CommentRow>(
    `INSERT INTO comments (slug, parent_id, user_id, author, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    slug,
    parent,
    user.id,
    user.name,
    content,
    now(),
  );
  return json({ comment: fromRow({ ...row, role: user.role }) }, 201);
};

// Anyone can remove their own comment; the team can remove any, with its
// replies. Replies from elsewhere are left out through comments.blocked.
export const remove = async (context: Context): Promise<Response> => {
  const user = await actingUser(context);
  if (user instanceof Response) return user;
  const id = text(context.body?.id);
  if (!id.startsWith("l:") || !Number.isInteger(Number(id.slice(2)))) {
    return fail("Only a comment posted here can be removed.");
  }
  const rowId = Number(id.slice(2));
  const comment = await context.db.one<{ user_id: number }>(
    `SELECT user_id FROM comments WHERE id = ?`,
    rowId,
  );
  if (!comment) return fail("That comment is gone.", 404);
  const moderator = user.role === "team";
  if (!moderator && Number(comment.user_id) !== user.id) {
    return fail("That isn't your comment.", 403);
  }
  const removed = moderator
    ? await context.db.all(
        `DELETE FROM comments WHERE id = ? OR parent_id = ? RETURNING id`,
        rowId,
        id,
      )
    : await context.db.all(
        `DELETE FROM comments WHERE id = ? RETURNING id`,
        rowId,
      );
  return json({ ok: removed.length > 0, removed: removed.length });
};

export { updatePath };
