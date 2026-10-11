# Comments carrier

The backend for comments on `/updates` and each update page. It is an archival
[carrier](https://archival.dev/docs/carriers), deployed with the site and
served at `/carriers/comments`, so the browser talks to it on the same origin.

One thread per update merges three sources:

- **Comments posted on the site**, kept in the site's own database
  (`site.sql`) by accounts that sign in with a passkey.
- **Fediverse replies** to the update's post from `@updates@archival.dev`, read
  with `site.activitypub`. Likes and boosts are counted too.
- **Webmention replies** from other sites, read with `site.webmentions`. Likes,
  reposts, bookmarks and plain mentions are counted.

## Accounts

Accounts are passkeys: no password and no email. Posting while signed out
first asks the browser for this site's passkey, with a note beside the Post
button saying why (browsers show no text of the site's own in their prompt).
If there isn't one, the reader picks a name and makes one. Synced passkeys
follow them to their other devices.

Nothing here proves a visitor is a person: a script can make passkeys as easily
as a phone. Archival's proof of work on carrier requests stops the drive-by
case, and the carrier caps the rest:

- 5 new accounts an hour and 20 a day across the site (the team excepted), and
  20 sign-ins waiting at once.
- 60 changes an hour per account: comments, renames and removals all count.
- 10 comments an hour per account, and 60 across the site.

They're constants at the top of `auth.ts` and `comments.ts`.

`session` is the token `register` or `signin` answers. A carrier can't read
cookies, so the browser keeps it and sends it in the body; only its hash is
stored, and it lasts 180 days from last use. Each WebAuthn challenge is stored
between its options and the response that answers it, for five minutes, and
used once.

Passkeys are tied to the host they're made on, so make them on the site's
canonical domain. They work under `archival run` on `localhost`.

## Endpoints

Every request is `/carriers/comments?action=<name>`. A carrier can't see the
request method, so writes are the actions sent with a JSON body (POST) and
reads are the ones without.

| Read (GET)         |                                                                         |
| ------------------ | ----------------------------------------------------------------------- |
| `thread&slug=a`    | One update's comments from all three sources, replies nested one level. |
| `counts&slugs=a,b` | Comment totals for the feed, across all three sources, up to 100 slugs. |

| Write (POST)                    |                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register-options` / `register` | `{ name, adminToken? }`, then `{ ticket, response }` with the new passkey. Answers `{ session, user }`. The admin token makes the account part of the team. |
| `signin-options` / `signin`     | `{}`, then `{ ticket, response }` with the passkey assertion. Answers `{ session, user }`.                                                                   |
| `me` / `signout`                | `{ session }`: the signed-in account / ends that session.                                                                                                   |
| `claim`                         | `{ session, adminToken }`: makes a signed-in account part of the team.                                                                                      |
| `rename`                        | `{ session, name }`. Comments show an account's current name.                                                                                               |
| `comment`                       | `{ session, slug, body, parentId? }`, posted under the account's name.                                                                                      |
| `remove`                        | `{ session, id }`: an account's own comment, or, for the team, any comment with its replies.                                                                |

Names are 2 to 40 characters and unique regardless of case; the site's name
and the authors' names are only for the team.

Ids are strings prefixed by source: `l:12` for a comment posted here,
`ap:<activitypub id>` for a fediverse reply, `wm:<source url>` for a
webmention. A reply can hang off a comment from any source. Comments posted
here are plain text and the client renders them as text nodes. Replies from
elsewhere arrive as the reduced HTML archival keeps and are sanitized again in
the browser before they're shown.

## Setup

On the `comments` object in the editor, so they're stored encrypted (see
[Secrets](https://archival.dev/docs/secrets)):

| Field         | Required | Purpose                                                             |
| ------------- | -------- | ------------------------------------------------------------------- |
| `admin_token` | no       | A long random string. Lets an account join the team.                |
| `blocked`     | no       | Accounts, servers or pages whose replies and mentions are left out. |

To join the team, open any update with `?comment_token=<admin_token>` once,
then sign in or create an account. That account's comments render as the
highlighted reply on the right, it can remove any comment, and it can take
the reserved names.

An entry in `blocked` matches a reply's id or page, an account's id, profile
URL or `@handle`, or a webmention's source. A bare hostname blocks every account
on that server. Fediverse replies and webmentions can't be removed through the
carrier; block them here instead.

The tables are created on the first request, so there is no migration step.

## Dependencies and types

The carrier depends on `@simplewebauthn/server`, installed from this
directory's `package-lock.json` when it deploys. `archival-objects.d.ts` is
generated from `archival_objects.toml`. After changing the `comments`,
`author` or `update` objects, regenerate it:

```sh
cd carriers/comments && npm install && npx archival-carrier-types
```
