// Comments on archival.dev updates. One thread per update merges three
// sources: comments posted on the site itself (kept in site.sql, by accounts
// that sign in with a passkey), replies from the fediverse to the update's
// ActivityPub post, and webmention replies from other sites. See README.md.
//
// Every request is /carriers/comments?action=<name>. A carrier can't see the
// request method, so writes are the actions sent with a JSON body (POST) and
// reads are the ones without.

import type { Carrier } from "@archival/carrier";
import * as auth from "./auth.ts";
import * as comments from "./comments.ts";
import { Database } from "./db.ts";
import { type Context, fail, fields } from "./http.ts";

type Handler = (context: Context) => Promise<Response>;

const READS: Record<string, Handler> = {
  thread: comments.thread,
  counts: comments.counts,
};

const WRITES: Record<string, Handler> = {
  "register-options": auth.registerOptions,
  register: auth.register,
  "signin-options": auth.signinOptions,
  signin: auth.signin,
  me: auth.me,
  signout: auth.signout,
  claim: auth.claim,
  rename: auth.rename,
  comment: comments.create,
  remove: comments.remove,
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
