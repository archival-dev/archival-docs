// The sessions as an iCalendar feed, for subscribing from a calendar app. Like
// the page, it leaves out the address and the Discord link: those go out with
// an RSVP.

import { type Context, settings, text } from "./http.ts";
import { endOf, type Event, Notion } from "./notion.ts";

// A session stays in the feed this long after it ends, so it doesn't vanish
// from subscribers' calendars the moment it's over.
const KEEP_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const escapeText = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

const utc = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const day = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");

const encoder = new TextEncoder();

// Lines longer than 75 octets are folded, without splitting a character.
const fold = (line: string): string => {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
};

const list = (names: string[]) =>
  names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : (names[0] ?? "");

const where = (event: Event) => {
  const inPerson =
    event.place || event.types.includes("in-person")
      ? text(event.place?.name) || "In person"
      : "";
  const discord = event.types.includes("discord") ? "Discord" : "";
  return [inPerson, discord].filter(Boolean).join(" or ");
};

// Notion's all-day end date is the last day of the session; DTEND is the day after.
const dates = (event: Event): string[] => {
  if (event.allDay) {
    const start = new Date(event.start);
    const end = event.end
      ? new Date(new Date(event.end).getTime() + DAY_MS)
      : new Date(start.getTime() + DAY_MS);
    return [`DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(end)}`];
  }
  return [
    `DTSTART:${utc(new Date(event.start))}`,
    `DTEND:${utc(endOf(event))}`,
  ];
};

const vevent = (
  event: Event,
  {
    host,
    page,
    about,
    stamp,
  }: { host: string; page: string; about: string; stamp: string },
): string[] => {
  const hosts = list(event.hosts.map((h) => text(h.name)).filter(Boolean));
  const description = [about, hosts && `With ${hosts}.`, `RSVP at ${page}`]
    .filter(Boolean)
    .join("\n\n");
  const location = where(event);
  return [
    "BEGIN:VEVENT",
    `UID:${event.id}@${host}`,
    `DTSTAMP:${stamp}`,
    ...dates(event),
    `SUMMARY:${escapeText(event.name)}`,
    `DESCRIPTION:${escapeText(description)}`,
    ...(location ? [`LOCATION:${escapeText(location)}`] : []),
    `URL:${page}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
  ];
};

export const calendar = async (context: Context): Promise<Response> => {
  const office = settings(context);
  const client = new Notion(office.notion_token, office.notion_database);
  const now = new Date();
  let events: Event[] = [];
  if (client.configured) {
    try {
      events = await client.upcoming(new Date(now.getTime() - KEEP_PAST_MS));
    } catch (error) {
      console.error(error);
      return new Response("Couldn't reach the calendar. Try again in a bit.", {
        status: 502,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
  }

  const site = context.site.url.replace(/\/$/, "");
  const page = `${site}/office-hours`;
  const name = `${text(office.title) || "Office hours"} | Archival`;
  const about = text(office.description);
  const details = {
    host: new URL(site).hostname,
    page,
    about,
    stamp: utc(now),
  };
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Archival//Office Hours//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeText(name)}`,
    `X-WR-CALNAME:${escapeText(name)}`,
    ...(about
      ? [
          `DESCRIPTION:${escapeText(about)}`,
          `X-WR-CALDESC:${escapeText(about)}`,
        ]
      : []),
    `URL:${page}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...events.flatMap((event) => vevent(event, details)),
    "END:VCALENDAR",
  ];
  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="office-hours.ics"',
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
};
