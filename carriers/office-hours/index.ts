// Office hours on archival.dev/office-hours: the sessions on the team's
// Notion calendar, RSVPs to them, and the emails each RSVP gets. See
// README.md.
//
// Every request is /carriers/office-hours?action=<name>. A carrier can't see
// the request method, so writes are the actions sent with a JSON body (POST)
// and reads are the ones without.

import type { Carrier, CarrierScheduled } from "@archival/carrier";
import { calendar } from "./calendar.ts";
import { Database } from "./db.ts";
import { type Context, fail, fields } from "./http.ts";
import * as rsvps from "./rsvps.ts";

type Handler = (context: Context) => Promise<Response>;

const READS: Record<string, Handler> = {
  events: rsvps.events,
  ics: calendar,
  rsvp: rsvps.show,
};

const WRITES: Record<string, Handler> = {
  rsvp: rsvps.create,
  cancel: rsvps.cancel,
};

const carrier: Carrier = async (params, body, objects, site) => {
  const action = params.get("action") ?? "";
  const data = fields(body);
  const routes = data ? WRITES : READS;
  if (!Object.hasOwn(routes, action)) return fail("No such action.", 404);

  const db = new Database(site.sql);
  try {
    await db.migrate();
    return await routes[action]({ params, body: data, objects, site, db });
  } catch (error) {
    console.error(action, error);
    return fail("Something went wrong. Try again in a bit.", 500);
  }
};

export default carrier;

export const scheduled: CarrierScheduled = async (objects, site, event) => {
  await rsvps.remind(objects, site, new Date(event.scheduledTime));
};
