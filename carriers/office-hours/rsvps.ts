import type { CarrierObjects, CarrierSite } from "@archival/carrier";
import { Database, hashToken, now, randomToken, type RsvpRow } from "./db.ts";
import { sendConfirmation, sendReminder } from "./email.ts";
import { type Context, type Env, fail, json, settings, text } from "./http.ts";
import { endOf, type Event, type Host, Notion, NotionError } from "./notion.ts";

const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_PLAN = 1000;
const HOUR_MS = 60 * 60 * 1000;
const REMINDER_MS = 60 * 60 * 1000;
// Bounds what a script can do with a form anyone can post to.
const RSVPS_PER_HOUR = 30;
const DEFAULT_ZONE = "America/Los_Angeles";

const notion = (env: Env) =>
  new Notion(settings(env).notion_token, settings(env).notion_database);

const timeZone = (env: Env) => settings(env).timezone?.trim() || DEFAULT_ZONE;

const replyTo = (env: Env) => settings(env).reply_to?.trim() || null;

const cancelUrl = (env: Env, token: string) =>
  `${env.site.url.replace(/\/$/, "")}/office-hours/cancel?token=${encodeURIComponent(token)}`;

const isEmail = (value: string) =>
  value.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const isPageId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** The line an RSVP adds to the event's page in Notion. */
const line = (name: string, email: string, plan: string) =>
  `${name} <${email}> — ${plan.replace(/\s+/g, " ").trim()}`;

/** What the page shows: no link, no address. Those come with the RSVP. */
const publicEvent = (event: Event) => ({
  id: event.id,
  name: event.name,
  start: event.start,
  end: event.end,
  allDay: event.allDay,
  types: event.types,
  place: event.place?.name ?? null,
  hosts: event.hosts,
});

const notionFailure = (error: unknown) => {
  console.error(error);
  if (error instanceof NotionError && error.status === 500) {
    return fail("Office hours aren't set up yet. Try again later.", 503);
  }
  return fail("Couldn't reach the calendar. Try again in a bit.", 502);
};

export const events = async (context: Context): Promise<Response> => {
  const client = notion(context);
  if (!client.configured) return json({ events: [], hosts: [] });
  try {
    const upcoming = await client.upcoming(new Date());
    const hosts = new Map<string, Host>();
    upcoming.forEach((event) =>
      event.hosts.forEach((host) => hosts.set(host.id, host)),
    );
    return json({
      events: upcoming.map(publicEvent),
      hosts: [...hosts.values()],
    });
  } catch (error) {
    return notionFailure(error);
  }
};

export const create = async (context: Context): Promise<Response> => {
  const body = context.body ?? {};
  const name = text(body.name);
  const email = text(body.email).toLowerCase();
  const plan = text(body.plan)
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (!isPageId(body.event)) return fail("Pick an office hours session.");
  if (!name || name.length > MAX_NAME) return fail("Add your name.");
  if (!isEmail(email)) return fail("Add an email address we can reach you at.");
  if (!plan || plan.length > MAX_PLAN) {
    return fail(
      `Tell us what you want to work on, in up to ${MAX_PLAN} characters.`,
    );
  }

  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const recent = await context.db.one<{ n: number }>(
    `SELECT count(*) AS n FROM rsvps WHERE created_at > ?`,
    since,
  );
  if (Number(recent?.n) >= RSVPS_PER_HOUR) {
    return fail("Lots of RSVPs right now. Try again in a bit.", 429);
  }

  const client = notion(context);
  let event: Event | null;
  try {
    event = await client.event(body.event);
  } catch (error) {
    return notionFailure(error);
  }
  if (!event || !event.start) return fail("That session is gone.", 404);
  if (endOf(event) < new Date())
    return fail("That session has already happened.");

  const existing = await context.db.one<RsvpRow>(
    `SELECT * FROM rsvps WHERE event_id = ? AND email = ?`,
    event.id,
    email,
  );
  if (existing && !existing.cancelled_at) {
    return fail(
      "You're already on the list. Check your email for the details.",
      409,
    );
  }

  const token = randomToken();
  const tokenHash = await hashToken(token);
  const entry = line(name, email, plan);

  let blockId: string | null = existing?.notion_block_id ?? null;
  try {
    if (blockId) {
      await client.setRsvp(blockId, entry, false);
    } else {
      blockId = await client.addRsvp(event.id, entry);
    }
  } catch (error) {
    console.error("notion rsvp", error);
  }

  if (existing) {
    await context.db.all(
      `UPDATE rsvps SET name = ?, plan = ?, token_hash = ?, notion_block_id = ?,
         event_name = ?, event_start = ?, created_at = ?,
         cancelled_at = NULL, reminded_at = NULL
       WHERE id = ?`,
      name,
      plan,
      tokenHash,
      blockId,
      event.name,
      event.start,
      now(),
      existing.id,
    );
  } else {
    await context.db.all(
      `INSERT INTO rsvps (event_id, event_name, event_start, name, email, plan,
         token_hash, notion_block_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.name,
      event.start,
      name,
      email,
      plan,
      tokenHash,
      blockId,
      now(),
    );
  }

  let emailed = true;
  try {
    await sendConfirmation(
      context.site,
      event,
      { name, email, plan },
      timeZone(context),
      cancelUrl(context, token),
      replyTo(context),
    );
  } catch (error) {
    console.error("confirmation email", error);
    emailed = false;
  }
  return json({ ok: true, emailed, event: publicEvent(event) }, 201);
};

const byToken = async (context: Context, token: string) =>
  context.db.one<RsvpRow>(
    `SELECT * FROM rsvps WHERE token_hash = ?`,
    await hashToken(token),
  );

export const show = async (context: Context): Promise<Response> => {
  const token = text(context.params.get("token"));
  if (!token) return fail("That link is missing its code.");
  const row = await byToken(context, token);
  if (!row) return fail("That link doesn't match an RSVP.", 404);
  return json({
    rsvp: {
      name: row.name,
      eventName: row.event_name,
      eventStart: row.event_start,
      plan: row.plan,
      cancelled: !!row.cancelled_at,
    },
  });
};

export const cancel = async (context: Context): Promise<Response> => {
  const token = text(context.body?.token);
  if (!token) return fail("That link is missing its code.");
  const row = await byToken(context, token);
  if (!row) return fail("That link doesn't match an RSVP.", 404);
  if (row.cancelled_at) return json({ ok: true, cancelled: true });

  await context.db.all(
    `UPDATE rsvps SET cancelled_at = ? WHERE id = ?`,
    now(),
    row.id,
  );
  if (row.notion_block_id) {
    try {
      await notion(context).setRsvp(
        row.notion_block_id,
        line(row.name, row.email, row.plan),
        true,
      );
    } catch (error) {
      console.error("notion cancel", error);
    }
  }
  return json({ ok: true, cancelled: true });
};

/**
 * A run every few minutes. Events starting within the hour are read fresh
 * from Notion, so a session that moved is reminded at its new time, and each
 * RSVP on them is reminded once.
 */
export const remind = async (
  objects: CarrierObjects,
  site: CarrierSite,
  at: Date,
): Promise<void> => {
  const db = new Database(site.sql);
  await db.migrate();
  const env: Env = { objects, site, db };
  const client = notion(env);
  if (!client.configured) return;

  const upcoming = await client.upcoming(at);
  const soon = upcoming.filter((event) => {
    const start = new Date(event.start).getTime();
    return (
      !event.allDay &&
      start > at.getTime() &&
      start - at.getTime() <= REMINDER_MS
    );
  });
  if (!soon.length) return;

  const rows = await db.all<RsvpRow>(
    `SELECT * FROM rsvps
     WHERE cancelled_at IS NULL AND reminded_at IS NULL
       AND event_id IN (${soon.map(() => "?").join(",")})`,
    ...soon.map((event) => event.id),
  );
  for (const row of rows) {
    const event = soon.find((candidate) => candidate.id === row.event_id);
    if (!event) continue;
    // A new token: the one in the confirmation is only known to its hash.
    const token = randomToken();
    await db.all(
      `UPDATE rsvps SET reminded_at = ?, token_hash = ?, event_name = ?, event_start = ?
       WHERE id = ?`,
      now(),
      await hashToken(token),
      event.name,
      event.start,
      row.id,
    );
    try {
      await sendReminder(
        site,
        event,
        { name: row.name, email: row.email, plan: row.plan },
        timeZone(env),
        cancelUrl(env, token),
        replyTo(env),
      );
    } catch (error) {
      console.error("reminder email", row.email, error);
    }
  }
};
