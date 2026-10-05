import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Place } from "../place.js";

/** One record as BTC Map returns it, before normalization. */
export type RawPlace = Record<string, unknown>;

const API = "https://api.btcmap.org/v4/places";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_FILE_RE = /^places-\d{4}-\d{2}-\d{2}\.json$/;

export function placesUrl(fields: string[]): string {
  return `${API}?fields=${fields.map(encodeURIComponent).join(",")}`;
}

/** A trimmed string, or undefined for anything else, including blank strings. */
function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function coordinate(raw: RawPlace, key: "lat" | "lon"): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`BTC Map place ${String(raw.id)}: ${key} is not a number`);
  }
  return value;
}

/** Maps one raw BTC Map record to a Place. Throws if it lacks an id, osm_id, lat or lon. */
export function normalize(raw: RawPlace): Place {
  const sourceId = typeof raw.id === "number" ? String(raw.id) : str(raw.id);
  if (sourceId === undefined) throw new Error("BTC Map place without an id");
  const osmId = str(raw.osm_id);
  if (osmId === undefined) throw new Error(`BTC Map place ${sourceId}: osm_id is missing`);
  return {
    sourceId,
    osmId,
    name: str(raw.name),
    lat: coordinate(raw, "lat"),
    lon: coordinate(raw, "lon"),
    address: str(raw.address),
    city: str(raw["osm:addr:city"]),
    state: str(raw["osm:addr:state"]),
    postcode: str(raw["osm:addr:postcode"]),
    countryTag: str(raw["osm:addr:country"]),
    amenity: str(raw["osm:amenity"]),
    shop: str(raw["osm:shop"]),
    craft: str(raw["osm:craft"]),
    cuisine: str(raw["osm:cuisine"]),
    website: str(raw.website),
    phone: str(raw.phone),
    openingHours: str(raw.opening_hours),
    description: str(raw.description),
    image: str(raw.image),
    payment: {
      lightning: str(raw["osm:payment:lightning"]),
      onchain: str(raw["osm:payment:onchain"]),
      lightningContactless: str(raw["osm:payment:lightning_contactless"]),
    },
  };
}

function cacheDir(cfg: Config): string {
  return join(cfg.paths.data, "cache");
}

/** The newest `places-<date>.json` in the cache dir (dates sort as text), or null if there is none. */
export function latestCachePath(cfg: Config): string | null {
  const dir = cacheDir(cfg);
  if (!existsSync(dir)) return null;
  const newest = readdirSync(dir).filter((f) => CACHE_FILE_RE.test(f)).sort().at(-1);
  return newest === undefined ? null : join(dir, newest);
}

export function readCache(path: string): RawPlace[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${path}: cache is not a JSON array`);
  return data as RawPlace[];
}

/**
 * Fetches every place into `<data>/cache/places-<today>.json`. A cache that is later read as
 * the full truth (so absence means deletion) must never be written from a bad fetch, so this
 * refuses an HTTP error, a non-array body, or a count under half the latest cache's. The file
 * is written to a temp name and renamed, so a failure never leaves a partial cache.
 */
export async function fetchPlaces(
  cfg: Config,
  opts: { fetchImpl?: typeof fetch; today?: string } = {},
): Promise<{ path: string; count: number }> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(today)) throw new Error(`today must be YYYY-MM-DD, got "${today}"`);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl(placesUrl(cfg.btcmapFields));
  if (res.status !== 200) {
    throw new Error(`BTC Map request failed: HTTP ${res.status} ${res.statusText}`.trim());
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("BTC Map response is not valid JSON; expected an array of places");
  }
  if (!Array.isArray(body)) {
    throw new Error("BTC Map response is not an array of places");
  }

  const previous = latestCachePath(cfg);
  if (previous !== null) {
    const previousCount = readCache(previous).length;
    if (body.length < previousCount / 2) {
      throw new Error(
        `BTC Map returned ${body.length} places, fewer than half of the ${previousCount} in ${previous}; ` +
          "refusing to write the cache",
      );
    }
  }

  const dir = cacheDir(cfg);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `places-${today}.json`);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { path, count: body.length };
}
