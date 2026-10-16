import type {
  CarrierActivityPub,
  CarrierBody,
  CarrierObjects,
  CarrierParams,
  CarrierSite,
  CarrierWebmentions,
} from "@archival/carrier";
import { Database, sameSecret } from "./db.ts";

export type Fields = Record<string, unknown>;

export interface Env {
  objects: CarrierObjects;
  site: CarrierSite;
  db: Database;
}

export interface Context extends Env {
  params: CarrierParams;
  /** Null when the request carried no body, which is every GET. */
  body: Fields | null;
}

export type Update = CarrierObjects["update"][number];

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export const fail = (error: string, status = 400) => json({ error }, status);

export const fields = (body: CarrierBody): Fields | null =>
  body && typeof body === "object" && !Array.isArray(body)
    ? (body as Fields)
    : null;

export const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export const isSlug = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,120}$/.test(value);

export const updatePath = (slug: string) => `update/${slug}`;

export const findUpdate = (env: Env, slug: string): Update | undefined =>
  env.objects.update.find((update) => update.path === updatePath(slug));

export const isAdmin = (env: Env, token: unknown) => {
  const expected = env.objects.comments.admin_token?.trim();
  return !!expected && typeof token === "string" && sameSecret(token, expected);
};

const emptyPage = async () => ({ items: [], total: 0, next: null });

// An archival CLI older than the carrier API it runs leaves these off `site`.
// Reading them as a site that doesn't federate matches what a deployed site
// without the sections does.
export const activitypub = (site: CarrierSite): CarrierActivityPub =>
  site.activitypub ?? {
    account: async () => null,
    followers: emptyPage,
    counts: async (posts) =>
      posts.map(() => ({ likes: 0, boosts: 0, replies: 0 })),
    likes: emptyPage,
    boosts: emptyPage,
    replies: emptyPage,
    setLocalLikes: async () => undefined,
  };

export const webmentions = (site: CarrierSite): CarrierWebmentions =>
  site.webmentions ?? {
    counts: async (pages) =>
      pages.map(() => ({
        replies: 0,
        likes: 0,
        reposts: 0,
        bookmarks: 0,
        mentions: 0,
      })),
    list: emptyPage,
  };
