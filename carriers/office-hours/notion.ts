// The office hours database in Notion: the events on it, who hosts them, and
// the RSVPs section of each event's page. Every call is a plain fetch against
// api.notion.com with the integration token from objects/office_hours.toml.

const API = "https://api.notion.com/v1";
const VERSION = "2025-09-03";
const EVENTS_TTL_MS = 60 * 1000;
const USER_TTL_MS = 60 * 60 * 1000;
const RSVP_HEADING = "RSVPs";
const MAX_RICH_TEXT = 2000;

export type EventType = "discord" | "in-person";

export interface Host {
  id: string;
  name: string;
  avatar: string | null;
}

export interface Place {
  name: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  googlePlaceId: string | null;
}

export interface Event {
  id: string;
  url: string;
  name: string;
  /** ISO 8601, with the offset Notion gave it. */
  start: string;
  end: string | null;
  allDay: boolean;
  types: EventType[];
  link: string | null;
  place: Place | null;
  hosts: Host[];
}

export class NotionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, unknown>;

interface RichText {
  plain_text?: string;
  text?: { content?: string };
  mention?: { type?: string };
}

interface NotionUser {
  id: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface Block {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface Page {
  id: string;
  url: string;
  archived?: boolean;
  in_trash?: boolean;
  properties: Record<string, Json>;
}

const cache = new Map<string, { until: number; value: unknown }>();

const cached = async <T>(
  key: string,
  ttl: number,
  load: () => Promise<T>,
): Promise<T> => {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  const value = await load();
  cache.set(key, { until: Date.now() + ttl, value });
  return value;
};

export const forget = (key: string) => cache.delete(key);

export class Notion {
  #token: string;
  #database: string;

  constructor(token: string | null, database: string | null) {
    this.#token = token?.trim() ?? "";
    this.#database = database?.trim() ?? "";
  }

  get configured() {
    return !!this.#token && !!this.#database;
  }

  async #call<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.#token) throw new NotionError("Notion isn't set up.", 500);
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        "notion-version": VERSION,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const data = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok) {
      throw new NotionError(
        `Notion ${path}: ${response.status} ${String(data.message ?? "")}`.trim(),
        response.status,
      );
    }
    return data as T;
  }

  /**
   * The id of the data source the events live on. `notion_database` may be a
   * database URL or id, or a data source URL (`collection://…`).
   */
  async #dataSource(): Promise<string> {
    const raw = this.#database;
    const uuid = raw.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )?.[0];
    const bare = uuid ?? raw.match(/[0-9a-f]{32}/i)?.[0];
    if (!bare)
      throw new NotionError("notion_database isn't a Notion id or URL.", 500);
    if (raw.startsWith("collection://")) return bare;
    return cached(`data-source:${bare}`, USER_TTL_MS, async () => {
      const database = await this.#call<{ data_sources?: { id: string }[] }>(
        `/databases/${bare}`,
      );
      const id = database.data_sources?.[0]?.id;
      if (!id) throw new NotionError("That database has no data source.", 500);
      return id;
    });
  }

  async #user(user: NotionUser): Promise<Host> {
    if (user.name) {
      return { id: user.id, name: user.name, avatar: user.avatar_url ?? null };
    }
    return cached(`user:${user.id}`, USER_TTL_MS, async () => {
      const full = await this.#call<NotionUser>(`/users/${user.id}`).catch(
        () => user,
      );
      return {
        id: user.id,
        name: full.name || "Archival team",
        avatar: full.avatar_url ?? null,
      };
    });
  }

  async #event(page: Page): Promise<Event> {
    const p = page.properties;
    // A date mention in the title repeats the Date property, which is shown
    // beside the name anyway.
    const title = ((p.Name?.title as RichText[] | undefined) ?? []).filter(
      (part) => part.mention?.type !== "date",
    );
    const date = p.Date?.date as
      { start: string; end: string | null } | null | undefined;
    const types = ((p.Type?.multi_select as { name: string }[]) ?? [])
      .map((option) => option.name.toLowerCase().replace(/\s+/g, "-"))
      .filter(
        (name): name is EventType => name === "discord" || name === "in-person",
      );
    const place = p.Place?.place as
      | {
          name?: string | null;
          address?: string | null;
          lat?: number | null;
          lon?: number | null;
          google_place_id?: string | null;
        }
      | null
      | undefined;
    const people = (p.Hosts?.people as NotionUser[] | undefined) ?? [];
    const start = date?.start ?? "";
    return {
      id: page.id,
      url: page.url,
      name: plain(title).replace(/\s+/g, " ").trim() || "Office hours",
      start,
      end: date?.end ?? null,
      allDay: !!start && !start.includes("T"),
      types,
      link: typeof p.Link?.url === "string" ? p.Link.url : null,
      place: place
        ? {
            name: place.name ?? null,
            address: place.address ?? null,
            lat: place.lat ?? null,
            lon: place.lon ?? null,
            googlePlaceId: place.google_place_id ?? null,
          }
        : null,
      hosts: await Promise.all(people.map((user) => this.#user(user))),
    };
  }

  /** Every event on the calendar that starts or ends after `from`. */
  async upcoming(from: Date): Promise<Event[]> {
    const day = from.toISOString().slice(0, 10);
    return cached(`events:${day}`, EVENTS_TTL_MS, async () => {
      const dataSource = await this.#dataSource();
      const pages: Page[] = [];
      let cursor: string | undefined;
      do {
        const result = await this.#call<{
          results: Page[];
          has_more: boolean;
          next_cursor: string | null;
        }>(`/data_sources/${dataSource}/query`, {
          method: "POST",
          body: JSON.stringify({
            filter: { property: "Date", date: { on_or_after: day } },
            sorts: [{ property: "Date", direction: "ascending" }],
            page_size: 100,
            start_cursor: cursor,
          }),
        });
        pages.push(...result.results);
        cursor = result.has_more
          ? (result.next_cursor ?? undefined)
          : undefined;
      } while (cursor);
      const events = await Promise.all(
        pages
          .filter((page) => !page.archived && !page.in_trash)
          .map((page) => this.#event(page)),
      );
      return events.filter((event) => event.start && endOf(event) > from);
    });
  }

  async event(id: string): Promise<Event | null> {
    const page = await this.#call<Page>(`/pages/${id}`).catch((error) => {
      if (error instanceof NotionError && error.status === 404) return null;
      throw error;
    });
    if (!page || page.archived || page.in_trash) return null;
    return this.#event(page);
  }

  /**
   * Adds a line to the RSVPs section of the event's page and resolves to its
   * block id. The section's empty first bullet is reused when it is there;
   * without the heading, the section is added at the end of the page.
   */
  async addRsvp(eventId: string, line: string): Promise<string> {
    const blocks = await this.#children(eventId);
    const headingAt = blocks.findIndex(
      (block) =>
        /^heading_[123]$/.test(block.type) &&
        plain(richText(block)).trim().toLowerCase() ===
          RSVP_HEADING.toLowerCase(),
    );
    if (headingAt === -1) {
      const added = await this.#append(eventId, [
        {
          object: "block",
          type: "heading_2",
          heading_2: { rich_text: [{ text: { content: RSVP_HEADING } }] },
        },
        bullet(line, false),
      ]);
      return added[1]?.id ?? added[0].id;
    }
    let last = blocks[headingAt];
    for (let i = headingAt + 1; i < blocks.length; i += 1) {
      if (/^heading_[123]$/.test(blocks[i].type)) break;
      last = blocks[i];
    }
    const section = blocks.slice(headingAt + 1, blocks.indexOf(last) + 1);
    const empty = section.find(
      (block) =>
        block.type === "bulleted_list_item" && !plain(richText(block)).trim(),
    );
    if (empty) {
      await this.setRsvp(empty.id, line, false);
      return empty.id;
    }
    const [added] = await this.#append(eventId, [bullet(line, false)], last.id);
    return added.id;
  }

  /** Rewrites an RSVP's line, struck through when it was cancelled. */
  async setRsvp(blockId: string, line: string, struck: boolean): Promise<void> {
    await this.#call(`/blocks/${blockId}`, {
      method: "PATCH",
      body: JSON.stringify(bullet(line, struck)),
    });
  }

  async #children(blockId: string): Promise<Block[]> {
    const blocks: Block[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const result = await this.#call<{
        results: Block[];
        has_more: boolean;
        next_cursor: string | null;
      }>(`/blocks/${blockId}/children?${query}`);
      blocks.push(...result.results);
      cursor = result.has_more ? (result.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return blocks;
  }

  async #append(parent: string, children: Json[], after?: string) {
    const result = await this.#call<{ results: Block[] }>(
      `/blocks/${parent}/children`,
      {
        method: "PATCH",
        body: JSON.stringify(after ? { children, after } : { children }),
      },
    );
    return result.results;
  }
}

const richText = (block: Block): RichText[] => {
  const inner = block[block.type];
  return inner && typeof inner === "object"
    ? (((inner as Json).rich_text as RichText[] | undefined) ?? [])
    : [];
};

const plain = (parts: RichText[]) =>
  parts.map((part) => part.plain_text ?? part.text?.content ?? "").join("");

const bullet = (line: string, struck: boolean) => ({
  type: "bulleted_list_item",
  bulleted_list_item: {
    rich_text: [
      {
        type: "text",
        text: { content: line.slice(0, MAX_RICH_TEXT) },
        annotations: { strikethrough: struck },
      },
    ],
  },
});

const HOUR_MS = 60 * 60 * 1000;

/** When an event is over: its end, or two hours after it starts. */
export const endOf = (event: Event): Date => {
  if (event.end) return new Date(event.end);
  const start = new Date(event.start);
  if (event.allDay) return new Date(start.getTime() + 24 * HOUR_MS);
  return new Date(start.getTime() + 2 * HOUR_MS);
};

export const mapUrl = (place: Place): string | null => {
  const query = place.address ?? place.name;
  if (query) {
    const params = new URLSearchParams({ api: "1", query });
    if (place.googlePlaceId) params.set("query_place_id", place.googlePlaceId);
    return `https://www.google.com/maps/search/?${params}`;
  }
  if (place.lat !== null && place.lon !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lon}`;
  }
  return null;
};
