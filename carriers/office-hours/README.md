# Office hours carrier

The backend for [archival.dev/office-hours](https://archival.dev/office-hours).
It is an archival [carrier](https://archival.dev/docs/carriers), deployed with
the site and served at `/carriers/office-hours`, so the browser talks to it on
the same origin.

It's `"access": "public"`, so calendar apps can fetch the `ics` feed
without the browser verification carriers otherwise ask for. The RSVP form is
bounded by its hourly limit instead.

The sessions themselves live in the team's Notion calendar, the "Archival
Office Hours" database. Each row is one session: its `Name`, `Date`, `Type`
(Discord, In-Person, or both), `Link`, `Place` and `Hosts`. The carrier reads
that database and writes RSVPs back to it.

## Settings

`objects/office_hours.toml` holds the page copy and the carrier's settings:

- `notion_database`: the database's URL or id.
- `notion_token`: an internal integration token from
  [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
  with the **read content**, **update content** and **read user information**
  capabilities. The database has to be shared with the integration (its page
  menu, "Connections"). Set the token from the editor so it is stored
  encrypted.
- `timezone`: the IANA zone the emails spell times in. The page itself shows
  times in the visitor's own zone.
- `reply_to`: where replies to the emails go, when not the sending address.

Email is sent with `site.email`, from the site's first address on
archival.dev. It needs a plan that includes email.

## Actions

Every request is `/carriers/office-hours?action=<name>`. Reads are GETs,
writes are POSTs with a JSON body.

| Action   | Kind  | What it does                                                                                                                                                                                                                        |
| -------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events` | read  | Every session that hasn't ended, oldest first, with its hosts (name and Notion avatar), its type and the name of its place. The link and the address are left out.                                                                  |
| `ics`    | read  | The sessions as an iCalendar feed to subscribe to (`text/calendar`): every session that hasn't ended or ended in the last 30 days, with its hosts and the name of its place. Like `events`, it leaves out the link and the address. |
| `rsvp`   | read  | `token`: the RSVP a cancel link points at, for the cancel page.                                                                                                                                                                     |
| `rsvp`   | write | `event`, `name`, `email`, `plan`: adds the person to the session, puts a line in the **RSVPs** section of the session's Notion page, and emails them the details.                                                                   |
| `cancel` | write | `token`: cancels the RSVP and strikes its line through on the Notion page.                                                                                                                                                          |

An RSVP is one row in `site.sql` per person per session. RSVPing again for the
same session with the same email revives a cancelled RSVP (its line on the page
loses its strikethrough) and refuses one that is still live. The cancel token
is only stored as a hash; the reminder gets a fresh one.

## Emails

- **Confirmation**, right away: the session's name and time, where it is (the
  Discord link, the place with a map link, or both), what the person said they
  wanted to work on, and a cancel link.
- **Reminder**, an hour before: the same, with a different opening.

The reminder is sent by `scheduled`, which runs every five minutes. Each run
asks Notion for the sessions starting in the next hour and reminds every live
RSVP on them that hasn't been reminded, so a session moved on the calendar is
reminded at its new time. A session that moves to within the hour, or to
earlier than it was, is reminded on the next run.

## Caps

- 30 RSVPs an hour across the site. Archival's proof of work on carrier
  requests stops the drive-by case; this bounds the rest.
- The calendar is cached for a minute per isolate, and host profiles for an
  hour.

They are constants at the top of `rsvps.ts` and `notion.ts`.

## Running locally

`archival run` serves the carrier at `http://localhost:1024/carriers/office-hours`.
`site.sql` is a local SQLite file, `site.email.send` throws (an RSVP still
goes through, with `emailed: false`), and schedules never run. With a token in
`objects/office_hours.toml` it reads and writes the real Notion database.
