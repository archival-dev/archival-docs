// Accounts are passkeys: no password and no email. A visitor who wants to
// comment picks a name and makes one; the browser's passkey prompt signs
// them in after that, on this device and on the ones it syncs to.

import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { CarrierSqlStatement } from "@archival/carrier";
import { now, randomToken } from "./db.ts";
import { type Context, type Env, fail, isAdmin, json, text } from "./http.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SESSION_MS = 180 * DAY_MS;
const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_NAME = 40;
// Nothing proves a passkey's holder is a person, so these bound what a script
// can do, sized for a site with a few dozen commenters a day.
const SIGNUPS_PER_HOUR = 5;
const SIGNUPS_PER_DAY = 20;
const OPEN_CHALLENGES = 20;
const CHANGES_PER_HOUR = 60;
const RP_NAME = "Archival";

export type Role = "reader" | "team";

export interface User {
  id: number;
  name: string;
  role: Role;
}

type UserRow = { id: number; name: string; role: string };

const toUser = (row: UserRow): User => ({
  id: Number(row.id),
  name: row.name,
  role: row.role === "team" ? "team" : "reader",
});

const relyingParty = (env: Env) => {
  const url = new URL(env.site.url);
  return { id: url.hostname, origin: url.origin, name: RP_NAME };
};

export const cleanName = (raw: unknown): string | null => {
  const name = text(raw).normalize("NFC").replace(/\s+/g, " ");
  if (name.length < 2 || name.length > MAX_NAME || /[\p{C}<>@]/u.test(name)) {
    return null;
  }
  return /[\p{L}\p{N}]/u.test(name) ? name : null;
};

// The team's own names belong to whoever holds the admin token.
const reserved = (env: Env, name: string) =>
  [
    RP_NAME,
    `${RP_NAME} Team`,
    ...env.objects.author.flatMap((author) => [author.name, author.key]),
  ].some((taken) => taken?.trim().toLowerCase() === name.toLowerCase());

const hash = async (token: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const expiry = () => new Date(Date.now() + SESSION_MS).toISOString();

// Sessions travel in request bodies, since a carrier can't read cookies.
// Only their hashes are stored.
const newSession = async () => {
  const token = randomToken(32);
  return { token, hash: await hash(token) };
};

export const currentUser = async (context: Context): Promise<User | null> => {
  const token = text(context.body?.session);
  if (!token) return null;
  const tokenHash = await hash(token);
  const row = await context.db.one<UserRow & { expires_at: string }>(
    `SELECT u.id, u.name, u.role, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash,
    now(),
  );
  if (!row) return null;
  // Sliding expiry, written at most once a day per session.
  if (Date.parse(row.expires_at) < Date.now() + SESSION_MS - DAY_MS) {
    await context.db.all(
      `UPDATE sessions SET expires_at = ? WHERE token_hash = ?`,
      expiry(),
      tokenHash,
    );
  }
  return toUser(row);
};

/**
 * A signed-in account that hasn't spent its hourly changes, so no one account
 * can use up the site's database writes.
 */
export const actingUser = async (
  context: Context,
  signedOut = "Sign in first.",
): Promise<User | Response> => {
  const user = await currentUser(context);
  if (!user) return fail(signedOut, 401);
  const hour = new Date().toISOString().slice(0, 13);
  const [spent] = await context.db.all(
    `UPDATE users SET
       budget_used = CASE WHEN budget_hour = ? THEN budget_used + 1 ELSE 1 END,
       budget_hour = ?
     WHERE id = ? AND (budget_hour IS NOT ? OR budget_used < ?)
     RETURNING budget_used`,
    hour,
    hour,
    user.id,
    hour,
    CHANGES_PER_HOUR,
  );
  return spent
    ? user
    : fail("That's a lot of changes. Try again in a little while.", 429);
};

const issueChallenge = async (
  env: Env,
  kind: string,
  challenge: string,
  name: string | null = null,
  role: string | null = null,
) => {
  const id = randomToken(16);
  const stamp = now();
  const [, [open]] = await env.db.transaction([
    [`DELETE FROM challenges WHERE expires_at <= ?`, stamp],
    [`SELECT count(*) AS n FROM challenges`],
  ]);
  if (Number(open?.n ?? 0) >= OPEN_CHALLENGES) return null;
  await env.db.all(
    `INSERT INTO challenges (id, challenge, kind, name, role, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    challenge,
    kind,
    name,
    role,
    new Date(Date.now() + CHALLENGE_MS).toISOString(),
  );
  return id;
};

const busy = () =>
  fail("Lots of people are signing in right now. Try again in a minute.", 429);

const takeChallenge = async (env: Env, id: string, kind: string) => {
  const [[row]] = await env.db.transaction([
    [
      `SELECT challenge, name, role FROM challenges
       WHERE id = ? AND kind = ? AND expires_at > ?`,
      id,
      kind,
      now(),
    ],
    [`DELETE FROM challenges WHERE id = ?`, id],
  ]);
  return row as
    | { challenge: string; name: string | null; role: string | null }
    | undefined;
};

const responseOf = <T>(context: Context): T | null => {
  const response = context.body?.response;
  return response &&
    typeof response === "object" &&
    typeof (response as { id?: unknown }).id === "string"
    ? (response as T)
    : null;
};

export const registerOptions = async (context: Context): Promise<Response> => {
  const name = cleanName(context.body?.name);
  if (!name) {
    return fail("Pick a name of 2 to 40 letters, numbers or spaces.");
  }
  const admin = isAdmin(context, context.body?.adminToken);
  const [[taken], [recent]] = await context.db.transaction([
    [`SELECT 1 AS taken FROM users WHERE name = ?`, name],
    [
      `SELECT count(*) AS day, coalesce(sum(created_at > ?), 0) AS hour
       FROM users WHERE created_at > ?`,
      new Date(Date.now() - HOUR_MS).toISOString(),
      new Date(Date.now() - DAY_MS).toISOString(),
    ],
  ]);
  if (taken || (!admin && reserved(context, name))) {
    return fail("That name is taken. Try another.", 409);
  }
  if (
    !admin &&
    (Number(recent?.hour) >= SIGNUPS_PER_HOUR ||
      Number(recent?.day) >= SIGNUPS_PER_DAY)
  ) {
    return fail("Lots of new accounts right now. Try again later.", 429);
  }
  const rp = relyingParty(context);
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: name,
    userDisplayName: name,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });
  const ticket = await issueChallenge(
    context,
    "register",
    options.challenge,
    name,
    admin ? "team" : "reader",
  );
  return ticket ? json({ ticket, options }) : busy();
};

export const register = async (context: Context): Promise<Response> => {
  const response = responseOf<RegistrationResponseJSON>(context);
  const pending =
    response &&
    (await takeChallenge(context, text(context.body?.ticket), "register"));
  if (!response || !pending?.name) {
    return fail("That took too long. Please try again.");
  }
  const rp = relyingParty(context);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: false,
  }).catch((error: unknown) => {
    console.error("register", error);
    return null;
  });
  if (!verification?.verified) {
    return fail("That passkey didn't work. Please try again.", 403);
  }

  const { credential } = verification.registrationInfo;
  const session = await newSession();
  const stamp = now();
  const statements: CarrierSqlStatement[] = [
    [
      `INSERT INTO users (name, role, created_at) VALUES (?, ?, ?)`,
      pending.name,
      pending.role ?? "reader",
      stamp,
    ],
    [
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at, used_at)
       VALUES (?, last_insert_rowid(), ?, ?, ?, ?, ?)`,
      credential.id,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      stamp,
      stamp,
    ],
    [
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
       SELECT ?, user_id, ?, ? FROM passkeys WHERE id = ?`,
      session.hash,
      stamp,
      expiry(),
      credential.id,
    ],
    [
      `SELECT u.id, u.name, u.role FROM users u
       JOIN passkeys p ON p.user_id = u.id WHERE p.id = ?`,
      credential.id,
    ],
  ];
  try {
    const results = await context.db.transaction(statements);
    return json({
      session: session.token,
      user: toUser(results[3][0] as UserRow),
    });
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return fail("That name was just taken. Try another.", 409);
    }
    throw error;
  }
};

export const signinOptions = async (context: Context): Promise<Response> => {
  const rp = relyingParty(context);
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: "preferred",
  });
  const ticket = await issueChallenge(context, "signin", options.challenge);
  return ticket ? json({ ticket, options }) : busy();
};

export const signin = async (context: Context): Promise<Response> => {
  const response = responseOf<AuthenticationResponseJSON>(context);
  const pending =
    response &&
    (await takeChallenge(context, text(context.body?.ticket), "signin"));
  if (!response || !pending) {
    return fail("That took too long. Please try again.");
  }
  const passkey = await context.db.one<{
    user_id: number;
    public_key: Uint8Array;
    counter: number;
    transports: string | null;
  }>(
    `SELECT user_id, public_key, counter, transports FROM passkeys WHERE id = ?`,
    response.id,
  );
  if (!passkey) {
    return fail(
      "That passkey isn't one this site knows. Create an account instead.",
      404,
    );
  }
  const rp = relyingParty(context);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    credential: {
      id: response.id,
      publicKey: new Uint8Array(passkey.public_key),
      counter: Number(passkey.counter),
      transports: JSON.parse(passkey.transports ?? "[]"),
    },
    requireUserVerification: false,
  }).catch((error: unknown) => {
    console.error("signin", error);
    return null;
  });
  if (!verification?.verified) {
    return fail("That passkey didn't work. Please try again.", 403);
  }

  const session = await newSession();
  const stamp = now();
  const [, , [user]] = await context.db.transaction([
    [
      `UPDATE passkeys SET counter = ?, used_at = ? WHERE id = ?`,
      verification.authenticationInfo.newCounter,
      stamp,
      response.id,
    ],
    [
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      session.hash,
      passkey.user_id,
      stamp,
      expiry(),
    ],
    [`SELECT id, name, role FROM users WHERE id = ?`, passkey.user_id],
  ]);
  return json({ session: session.token, user: toUser(user as UserRow) });
};

export const rename = async (context: Context): Promise<Response> => {
  const user = await actingUser(context);
  if (user instanceof Response) return user;
  const name = cleanName(context.body?.name);
  if (!name) {
    return fail("Pick a name of 2 to 40 letters, numbers or spaces.");
  }
  if (user.role !== "team" && reserved(context, name)) {
    return fail("That name is taken. Try another.", 409);
  }
  try {
    await context.db.all(
      `UPDATE users SET name = ? WHERE id = ?`,
      name,
      user.id,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return fail("That name is taken. Try another.", 409);
    }
    throw error;
  }
  return json({ user: { ...user, name } });
};

export const me = async (context: Context): Promise<Response> => {
  const user = await currentUser(context);
  return user ? json({ user }) : fail("Signed out", 401);
};

export const signout = async (context: Context): Promise<Response> => {
  const token = text(context.body?.session);
  if (token) {
    await context.db.all(
      `DELETE FROM sessions WHERE token_hash = ?`,
      await hash(token),
    );
  }
  return json({ ok: true });
};

// A team member signs in like anyone, then proves it once with the admin token.
export const claim = async (context: Context): Promise<Response> => {
  const user = await currentUser(context);
  if (!user) return fail("Sign in first.", 401);
  if (!isAdmin(context, context.body?.adminToken)) {
    return fail("That token is no longer good.", 403);
  }
  await context.db.all(
    `UPDATE users SET role = 'team' WHERE id = ?`,
    user.id,
  );
  return json({ user: { ...user, role: "team" } });
};
