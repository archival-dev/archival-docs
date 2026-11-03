import type {
  CarrierBody,
  CarrierObjects,
  CarrierSite,
} from "@archival/carrier";
import type { Database } from "./db.ts";

export type Fields = Record<string, unknown>;

export interface Env {
  objects: CarrierObjects;
  site: CarrierSite;
  db: Database;
}

export interface Context extends Env {
  params: URLSearchParams;
  /** Null when the request carried no body, which is every GET. */
  body: Fields | null;
}

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

export const settings = (env: Env) => env.objects.office_hours;
