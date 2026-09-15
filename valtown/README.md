# Comments val

`comments.ts` is the backend for comments on `/updates` and each update page. It
runs on [Val Town](https://val.town) against Val Town's SQLite, and the site
talks to it directly from the browser.

## Deploy

1. Create an **HTTP val** on Val Town and paste in `comments.ts`.
2. Set these environment variables on the val:

   | Name                   | Required | Purpose                                                        |
   | ---------------------- | -------- | -------------------------------------------------------------- |
   | `TURNSTILE_SECRET_KEY` | yes      | Secret for the Turnstile widget the comment form renders.       |
   | `COMMENTS_ADMIN_TOKEN` | no       | Lets you post as the team and hide comments.                    |
   | `IP_HASH_SALT`         | no       | Salt for the stored IP hash used by the rate limit.             |
   | `ALLOWED_ORIGINS`      | no       | Comma-separated CORS allowlist. Defaults to the archival.dev origins. |

3. Copy the val's URL (`https://<user>-<val>.web.val.run`) into `COMMENTS_URL`
   in `build.mjs`, for both the staging and production branches.

The table is created on the first request, so there is no migration step.

## Endpoints

| Method | Path                    | Purpose                                                    |
| ------ | ----------------------- | ---------------------------------------------------------- |
| `GET`  | `/counts?slugs=a,b,c`   | Comment totals for the feed. Omit `slugs` for every slug.  |
| `GET`  | `/thread?slug=a`        | One update's comments, replies nested under their parent.  |
| `POST` | `/comments`             | `{ slug, author, body, parentId?, turnstileToken }`.       |
| `POST` | `/moderate`             | `{ id, hidden }` with the admin token.                     |

Bodies are stored and returned as plain text. The client renders them as text
nodes, so nothing a commenter writes is ever parsed as markup.

## Posting as the team

A comment posted with `Authorization: Bearer $COMMENTS_ADMIN_TOKEN` is stored
with the `team` role and renders as the highlighted reply on the right. To get
that token into your browser, open any update with `?comment_token=<token>` —
the page stores it and strips it from the URL.

## Hiding a comment

```sh
curl -X POST https://<user>-<val>.web.val.run/moderate \
  -H "Authorization: Bearer $COMMENTS_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": 12, "hidden": true}'
```

Hidden comments drop out of both the thread and the feed count.
