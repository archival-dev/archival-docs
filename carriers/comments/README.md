# Comments carrier

`index.ts` is the backend for comments on `/updates` and each update page. It
is an archival [carrier](https://archival.dev/docs/carriers), deployed with the
site and served at `/carriers/comments`, so the browser talks to it on the
same origin.

One thread per update merges three sources:

- **Comments posted on the site**, kept in the site's own database
  (`site.sql`).
- **Fediverse replies** to the update's post from `@updates@archival.dev`, read
  with `site.activitypub`. Likes and boosts are counted too.
- **Webmention replies** from other sites, read with `site.webmentions`. Likes,
  reposts, bookmarks and plain mentions are counted.

## Setup

Set the secrets on the `comments` object from the editor, so they're stored
encrypted (see [Secrets](https://archival.dev/docs/secrets)):

| Field                  | Required | Purpose                                                         |
| ---------------------- | -------- | --------------------------------------------------------------- |
| `turnstile_secret_key` | yes      | Secret for the Turnstile widget the comment form renders.       |
| `admin_token`          | no       | Lets you post as the team and hide comments.                    |
| `blocked`              | no       | Accounts, servers or pages whose replies and mentions are left out. |

An entry in `blocked` matches a reply's id or page, an account's id, profile
URL or `@handle`, or a webmention's source. A bare hostname blocks every account
on that server.

The table is created on the first request, so there is no migration step.

Under `archival run`, with no secret set, the carrier accepts Cloudflare's
always-passes test widget that the dev build renders.

## Endpoints

| Method | Query / body                                          | Purpose                                                   |
| ------ | ----------------------------------------------------- | --------------------------------------------------------- |
| `GET`  | `?slugs=a,b,c`                                        | Comment totals for the feed, across all three sources.    |
| `GET`  | `?slug=a`                                             | One update's thread, replies nested under their parent.   |
| `POST` | `{ slug, author, body, parentId?, turnstileToken }`   | Post a comment. Add `token` to post as the team.          |
| `POST` | `{ action: "moderate", token, id, hidden }`           | Hide (or unhide) a comment posted on the site.            |

Ids are strings prefixed by source: `l:12` for a comment posted here,
`ap:<activitypub id>` for a fediverse reply, `wm:<source url>` for a
webmention. Comments posted here are plain text and the client renders them as
text nodes. Replies from elsewhere arrive as the reduced HTML archival keeps
and are sanitized again in the browser before they're shown.

## Posting as the team

A comment posted with `token` set to `admin_token` is stored with the `team`
role and renders as the highlighted reply on the right. To get that token into
your browser, open any update with `?comment_token=<token>` — the page stores
it and strips it from the URL.

## Hiding a comment

```sh
curl -X POST https://archival.dev/carriers/comments \
  -H "Content-Type: application/json" \
  -d '{"action": "moderate", "token": "'"$COMMENTS_ADMIN_TOKEN"'", "id": "l:12", "hidden": true}'
```

Hidden comments drop out of both the thread and the feed count. Fediverse
replies and webmentions can't be hidden this way: add them to `blocked` on the
`comments` object instead.

## Types

`archival-objects.d.ts` is generated from `archival_objects.toml`. After
changing the `comments` or `update` objects, regenerate it:

```sh
cd carriers/comments && npm install && npx archival-carrier-types
```
