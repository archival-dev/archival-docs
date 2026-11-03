// The two emails an RSVP gets: a confirmation right away, and a reminder an
// hour before. Both carry where the office hours are: the event's link, its
// place, or both.

import type { CarrierSite } from "@archival/carrier";
import { type Event, mapUrl } from "./notion.ts";

export interface Rsvp {
  name: string;
  email: string;
  plan: string;
}

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const whenText = (event: Event, timeZone: string) => {
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return event.start;
  const zone = { timeZone: safeZone(timeZone) };
  if (event.allDay) {
    return start.toLocaleDateString("en-US", {
      ...zone,
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  const day = start.toLocaleDateString("en-US", {
    ...zone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const time = (date: Date) =>
    date.toLocaleTimeString("en-US", {
      ...zone,
      hour: "numeric",
      minute: "2-digit",
    });
  const end = event.end ? new Date(event.end) : null;
  const span =
    end && !Number.isNaN(end.getTime())
      ? `${time(start)} to ${time(end)}`
      : time(start);
  const name = start
    .toLocaleTimeString("en-US", { ...zone, timeZoneName: "short" })
    .split(" ")
    .pop();
  return `${day}, ${span} ${name ?? ""}`.trim();
};

const safeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
};

interface Where {
  label: string;
  url: string | null;
}

/** The link, the place, or both, in the order they're useful. */
export const whereLines = (event: Event): Where[] => {
  const lines: Where[] = [];
  if (event.link) {
    const discord =
      event.types.includes("discord") || /discord/i.test(event.link);
    lines.push({
      label: discord ? "Join on Discord" : "Join online",
      url: event.link,
    });
  }
  if (event.place) {
    const parts = [event.place.name, event.place.address].filter(
      (part): part is string => !!part && part.trim().length > 0,
    );
    const label = parts.length ? parts.join(", ") : "See the map";
    lines.push({ label, url: mapUrl(event.place) });
  }
  return lines;
};

const render = (
  event: Event,
  rsvp: Rsvp,
  timeZone: string,
  cancelUrl: string | null,
  intro: string,
  outro: string,
) => {
  const when = whenText(event, timeZone);
  const where = whereLines(event);
  const textLines = [
    `Hi ${rsvp.name},`,
    "",
    intro,
    "",
    `What: ${event.name}`,
    `When: ${when}`,
    ...where.map((line) =>
      line.url && line.url !== line.label
        ? `Where: ${line.label} - ${line.url}`
        : `Where: ${line.url ?? line.label}`,
    ),
    "",
    "What you want to work on:",
    rsvp.plan,
    "",
    outro,
  ];
  if (cancelUrl) {
    textLines.push("", `Can't make it? Cancel your RSVP here: ${cancelUrl}`);
  }
  textLines.push("", "The Archival team");

  const whereHtml = where
    .map(
      (line) =>
        `<p style="margin:0 0 6px"><strong>Where:</strong> ${
          line.url
            ? `<a href="${escape(line.url)}">${escape(line.label)}</a>`
            : escape(line.label)
        }</p>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:24px">
<p>Hi ${escape(rsvp.name)},</p>
<p>${escape(intro)}</p>
<p style="margin:0 0 6px"><strong>What:</strong> ${escape(event.name)}</p>
<p style="margin:0 0 6px"><strong>When:</strong> ${escape(when)}</p>
${whereHtml}
<p style="margin:18px 0 6px"><strong>What you want to work on:</strong></p>
<blockquote style="margin:0 0 18px;padding:8px 14px;border-left:3px solid #fe8300;color:#333;white-space:pre-wrap">${escape(rsvp.plan)}</blockquote>
<p>${escape(outro)}</p>
${cancelUrl ? `<p style="color:#555">Can't make it? <a href="${escape(cancelUrl)}">Cancel your RSVP</a>.</p>` : ""}
<p>The Archival team</p>
</body></html>`;
  return { text: textLines.join("\n"), html };
};

export const sendConfirmation = (
  site: CarrierSite,
  event: Event,
  rsvp: Rsvp,
  timeZone: string,
  cancelUrl: string,
  replyTo: string | null,
) => {
  const { text, html } = render(
    event,
    rsvp,
    timeZone,
    cancelUrl,
    "You're on the list for office hours. Here are the details:",
    "We'll email you again an hour before it starts. Bring your site, your questions, or just an idea.",
  );
  return site.email.send({
    to: rsvp.email,
    subject: `You're in: ${event.name}`,
    text,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
};

export const sendReminder = (
  site: CarrierSite,
  event: Event,
  rsvp: Rsvp,
  timeZone: string,
  cancelUrl: string,
  replyTo: string | null,
) => {
  const { text, html } = render(
    event,
    rsvp,
    timeZone,
    cancelUrl,
    "Office hours start in about an hour. Here's a reminder of what you told us and where to find us:",
    "See you soon.",
  );
  return site.email.send({
    to: rsvp.email,
    subject: `Starting soon: ${event.name}`,
    text,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
};
