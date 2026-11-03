// The office hours page and its cancel page, backed by the carrier in
// carriers/office-hours. The list of sessions comes from the team's Notion
// calendar through the carrier; an RSVP posts the form and the carrier does
// the rest: the Notion page, the confirmation and the reminder.

import { track } from "./analytics";

type EventType = "discord" | "in-person";

interface Host {
  id: string;
  name: string;
  avatar: string | null;
}

interface OfficeHoursEvent {
  id: string;
  name: string;
  start: string;
  end: string | null;
  allDay: boolean;
  types: EventType[];
  place: string | null;
  hosts: Host[];
}

interface Rsvp {
  name: string;
  eventName: string;
  eventStart: string;
  plan: string;
  cancelled: boolean;
}

class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, unknown>;

const answer = async <T>(response: Response): Promise<T> => {
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new RequestError(
      data.error || "That didn't work. Please try again.",
      response.status,
    );
  }
  return data as T;
};

const read = async <T>(action: string, query: Json = {}): Promise<T> => {
  const params = new URLSearchParams({ action });
  Object.entries(query).forEach(([key, value]) =>
    params.set(key, String(value)),
  );
  return answer<T>(await fetch(`${OFFICE_HOURS_URL}?${params}`));
};

const write = async <T>(action: string, body: Json): Promise<T> =>
  answer<T>(
    await fetch(`${OFFICE_HOURS_URL}?action=${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const el = <T extends HTMLElement>(
  selector: string,
  root: ParentNode = document,
) => root.querySelector<T>(selector);

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const svg = (markup: string) => {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  return template.content.firstElementChild as SVGElement;
};

const ICONS: Record<EventType, { label: string; markup: string }> = {
  discord: {
    label: "On Discord",
    markup: `<svg viewBox="0 0 100 75" fill="currentColor" aria-hidden="true"><path d="M84.7 6.28A82.6 82.6 0 0 0 64.08 0a57 57 0 0 0-2.64 5.32 76.7 76.7 0 0 0-22.9 0A57 57 0 0 0 35.9 0a82.5 82.5 0 0 0-20.65 6.3C2.2 25.4-1.35 44.05.42 62.43a83 83 0 0 0 25.3 12.57 61 61 0 0 0 5.43-8.65 54 54 0 0 1-8.54-4.03c.72-.51 1.42-1.04 2.1-1.56a59.4 59.4 0 0 0 50.58 0c.69.55 1.39 1.08 2.1 1.56a54 54 0 0 1-8.55 4.04 61 61 0 0 0 5.42 8.64 83 83 0 0 0 25.32-12.56c2.08-21.31-3.55-39.78-14.87-56.16ZM33.39 51.13c-4.93 0-9-4.43-9-9.88s3.93-9.92 9-9.92c5.05 0 9.1 4.47 9 9.92-.09 5.45-3.97 9.88-9 9.88Zm33.22 0c-4.94 0-9-4.43-9-9.88s3.94-9.92 9-9.92c5.07 0 9.08 4.47 9 9.92-.09 5.45-3.97 9.88-9 9.88Z"/></svg>`,
  },
  "in-person": {
    label: "In person",
    markup: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  },
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** Stable per name, so a host without a photo keeps one colour. */
const hue = (name: string) => {
  let total = 0;
  for (let i = 0; i < name.length; i += 1) {
    total = (total * 31 + name.charCodeAt(i)) % 360;
  }
  return total;
};

const avatar = (host: Host, large = false) => {
  const node = make("span", `oh-avatar${large ? " oh-avatar--large" : ""}`);
  node.style.setProperty("--oh-hue", String(hue(host.name)));
  node.title = host.name;
  if (host.avatar) {
    const img = make("img");
    img.src = host.avatar;
    img.alt = host.name;
    img.width = large ? 56 : 32;
    img.height = large ? 56 : 32;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      img.remove();
      node.textContent = initials(host.name);
    });
    node.appendChild(img);
  } else {
    node.textContent = initials(host.name);
  }
  return node;
};

const hostNames = (hosts: Host[]) => {
  const names = hosts.map((host) => host.name.split(/\s+/)[0] ?? host.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

const DATE = {
  month: new Intl.DateTimeFormat(undefined, { month: "short" }),
  day: new Intl.DateTimeFormat(undefined, { day: "numeric" }),
  weekday: new Intl.DateTimeFormat(undefined, { weekday: "long" }),
  time: new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }),
  zone: new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }),
  full: new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }),
};

const zoneName = (date: Date) =>
  DATE.zone.formatToParts(date).find((part) => part.type === "timeZoneName")
    ?.value ?? "";

/** "Wednesday, 1:00 to 4:00 PM PST", in the visitor's own time zone. */
const whenText = (event: OfficeHoursEvent) => {
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return "";
  if (event.allDay) return DATE.weekday.format(start);
  const end = event.end ? new Date(event.end) : null;
  const span =
    end && !Number.isNaN(end.getTime())
      ? `${DATE.time.format(start)} to ${DATE.time.format(end)}`
      : DATE.time.format(start);
  return `${DATE.weekday.format(start)}, ${span} ${zoneName(start)}`.trim();
};

const list = el<HTMLOListElement>("[data-oh-list]");
const dialog = el<HTMLDialogElement>("#oh-rsvp");
const form = el<HTMLFormElement>("[data-oh-form]");

const openForm = (event: OfficeHoursEvent, onDone: () => void) => {
  if (!dialog || !form) return;
  const title = el<HTMLElement>("[data-oh-form-event]", form);
  const error = el<HTMLElement>("[data-oh-form-error]", form);
  const submit = el<HTMLButtonElement>("[data-oh-submit]", form);
  if (title) {
    title.textContent = `${event.name} · ${whenText(event)}`;
  }
  if (error) error.hidden = true;
  form.reset();
  form.onsubmit = async (submitted) => {
    submitted.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    if (submit) submit.disabled = true;
    if (error) error.hidden = true;
    try {
      const result = await write<{ ok: boolean; emailed: boolean }>("rsvp", {
        event: event.id,
        name: data.get("name"),
        email: data.get("email"),
        plan: data.get("plan"),
      });
      track("office-hours-rsvp", {
        event: event.name,
        emailed: String(result.emailed),
      });
      dialog.close();
      onDone();
      if (!result.emailed) {
        window.alert(
          "You're on the list, but we couldn't send a confirmation email. The details are on the event in Discord.",
        );
      }
    } catch (thrown) {
      if (error) {
        error.textContent =
          thrown instanceof Error
            ? thrown.message
            : "That didn't work. Please try again.";
        error.hidden = false;
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  };
  dialog.showModal();
  el<HTMLInputElement>("input[name=name]", form)?.focus();
};

const row = (event: OfficeHoursEvent, rsvpLabel: string) => {
  const item = make("li", "oh-event benefit");
  item.dataset.glow = "";
  const start = new Date(event.start);

  const date = make("div", "oh-event-date");
  date.appendChild(make("span", "oh-event-month", DATE.month.format(start)));
  date.appendChild(make("span", "oh-event-day", DATE.day.format(start)));
  item.appendChild(date);

  const body = make("div", "oh-event-body");
  const name = make("h3", "oh-event-name");
  event.types.forEach((type) => {
    const icon = ICONS[type];
    const badge = make("span", `oh-event-type oh-event-type--${type}`);
    badge.title = icon.label;
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", icon.label);
    badge.appendChild(svg(icon.markup));
    name.appendChild(badge);
  });
  name.appendChild(document.createTextNode(event.name));
  body.appendChild(name);
  const when = [whenText(event), event.place].filter(Boolean).join(" · ");
  body.appendChild(make("p", "oh-event-when", when));
  item.appendChild(body);

  const hosts = make("div", "oh-event-hosts");
  if (event.hosts.length) {
    const avatars = make("span", "oh-avatars");
    event.hosts.forEach((host) => avatars.appendChild(avatar(host)));
    hosts.appendChild(avatars);
    hosts.appendChild(
      make("span", undefined, `with ${hostNames(event.hosts)}`),
    );
  }
  item.appendChild(hosts);

  const action = make("div", "oh-event-action");
  const button = make("button", "primary-cta", rsvpLabel);
  button.type = "button";
  button.dataset.rybbitEvent = "office-hours-open-rsvp";
  button.addEventListener("click", () =>
    openForm(event, () => {
      const done = make("p", "oh-event-done");
      done.innerHTML =
        "<strong>You're on the list.</strong> Check your email for the details.";
      action.replaceChildren(done);
    }),
  );
  action.appendChild(button);
  item.appendChild(action);
  return item;
};

const renderHosts = (hosts: Host[]) => {
  const section = el<HTMLElement>("[data-oh-hosts]");
  const target = el<HTMLUListElement>("[data-oh-host-list]");
  if (!section || !target || !hosts.length) return;
  hosts.forEach((host) => {
    const item = make("li", "oh-host");
    item.appendChild(avatar(host, true));
    item.appendChild(make("span", undefined, host.name));
    target.appendChild(item);
  });
  section.hidden = false;
};

const loadEvents = async () => {
  if (!list) return;
  const status = el<HTMLElement>("[data-oh-status]", list);
  const empty = el<HTMLElement>("[data-oh-empty]");
  const rsvpLabel = list.dataset.rsvpLabel || "RSVP";
  try {
    const { events, hosts } = await read<{
      events: OfficeHoursEvent[];
      hosts: Host[];
    }>("events");
    list.replaceChildren(...events.map((event) => row(event, rsvpLabel)));
    if (!events.length && empty) empty.hidden = false;
    renderHosts(hosts);
  } catch (thrown) {
    if (status) {
      status.textContent =
        thrown instanceof Error
          ? thrown.message
          : "Couldn't load the calendar. Try again in a bit.";
    }
  }
};

const setupDialog = () => {
  if (!dialog) return;
  el<HTMLButtonElement>("[data-oh-close]", dialog)?.addEventListener(
    "click",
    () => dialog.close(),
  );
  dialog.addEventListener("click", (clicked) => {
    if (clicked.target === dialog) dialog.close();
  });
};

const setupCancel = async () => {
  const section = el<HTMLElement>("[data-oh-cancel]");
  if (!section) return;
  const status = el<HTMLElement>("[data-oh-cancel-status]", section);
  const card = el<HTMLElement>("[data-oh-cancel-card]", section);
  const done = el<HTMLElement>("[data-oh-cancel-done]", section);
  const error = el<HTMLElement>("[data-oh-cancel-error]", section);
  const button = el<HTMLButtonElement>("[data-oh-cancel-button]", section);
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const show = (message: string) => {
    if (status) {
      status.textContent = message;
      status.hidden = false;
    }
  };
  if (!token) {
    show("That link is missing its code. Open the one from your email.");
    return;
  }
  let rsvp: Rsvp;
  try {
    ({ rsvp } = await read<{ rsvp: Rsvp }>("rsvp", { token }));
  } catch (thrown) {
    show(thrown instanceof Error ? thrown.message : "That link didn't work.");
    return;
  }
  if (status) status.hidden = true;
  if (rsvp.cancelled) {
    if (done) done.hidden = false;
    return;
  }
  if (!card) return;
  const set = (selector: string, text: string) => {
    const target = el<HTMLElement>(selector, card);
    if (target) target.textContent = text;
  };
  const start = new Date(rsvp.eventStart);
  set("[data-oh-cancel-name]", rsvp.name);
  set("[data-oh-cancel-event]", rsvp.eventName);
  set(
    "[data-oh-cancel-when]",
    Number.isNaN(start.getTime())
      ? ""
      : `on ${DATE.full.format(start)} ${zoneName(start)}`,
  );
  set("[data-oh-cancel-plan]", rsvp.plan);
  card.hidden = false;
  button?.addEventListener("click", async () => {
    button.disabled = true;
    if (error) error.hidden = true;
    try {
      await write("cancel", { token });
      track("office-hours-cancel");
      card.hidden = true;
      if (done) done.hidden = false;
    } catch (thrown) {
      if (error) {
        error.textContent =
          thrown instanceof Error
            ? thrown.message
            : "That didn't work. Please try again.";
        error.hidden = false;
      }
      button.disabled = false;
    }
  });
};

setupDialog();
void loadEvents();
void setupCancel();
