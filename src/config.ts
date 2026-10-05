import { readFileSync } from "node:fs";

export interface Config {
  headerCoordinate: string;
  curatorPubkey: string;
  /** name -> url, e.g. { dcosl: "wss://…", search: "wss://…" } */
  relays: Record<string, string>;
  /** relay name used for the header read */
  headerRelay: string;
  scope: { amenity: string[]; shop: string[]; craft: string[] };
  btcmapFields: string[];
  publish: { eventsPerSecond: number; okTimeoutMs: number };
  /** deletions above this fraction of live items abort `build` */
  deletionGuardFraction: number;
  pilotSize: number;
  paths: { data: string; out: string; state: string };
}

const COORDINATE_RE = /^39998:[0-9a-f]{64}:[^:]+$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isRelayUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    const url = new URL(v);
    return (url.protocol === "ws:" || url.protocol === "wss:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** A short rendering of a bad value for an error message. */
function shown(v: unknown): string {
  if (v === undefined) return "nothing";
  const text = JSON.stringify(v);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Reads and validates the config: `path`, else `$MISE_CONFIG`, else `config.json`. Every
 * field is checked, so a missing or mistyped value (say a missing `pilotSize` or
 * `deletionGuardFraction`) stops the run here instead of turning a safety check off later.
 * Each error names the file and the field.
 */
export function loadConfig(path?: string): Config {
  const file = path ?? process.env.MISE_CONFIG ?? "config.json";
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObject(raw)) throw new Error(`${file}: must be a JSON object, got ${shown(raw)}`);

  const check = (field: string, value: unknown, ok: boolean, rule: string): void => {
    if (!ok) throw new Error(`${file}: ${field} must be ${rule}, got ${shown(value)}`);
  };

  const { headerCoordinate, curatorPubkey, relays, headerRelay, scope, btcmapFields, publish } = raw;
  check(
    "headerCoordinate",
    headerCoordinate,
    typeof headerCoordinate === "string" && COORDINATE_RE.test(headerCoordinate),
    "39998:<64 hex pubkey>:<d tag>",
  );
  check(
    "curatorPubkey",
    curatorPubkey,
    typeof curatorPubkey === "string" && PUBKEY_RE.test(curatorPubkey),
    "64 lowercase hex characters",
  );

  check("relays", relays, isObject(relays) && Object.keys(relays).length > 0, "a non-empty object of named relay URLs");
  const relayMap = relays as Record<string, unknown>;
  for (const [name, url] of Object.entries(relayMap)) {
    check(`relays.${name}`, url, isRelayUrl(url), "a ws:// or wss:// URL");
  }
  check(
    "headerRelay",
    headerRelay,
    typeof headerRelay === "string" && Object.hasOwn(relayMap, headerRelay),
    `one of the relay names (${Object.keys(relayMap).join(", ")})`,
  );

  check("scope", scope, isObject(scope), "an object with amenity, shop and craft lists");
  for (const key of ["amenity", "shop", "craft"]) {
    const list = (scope as Record<string, unknown>)[key];
    check(`scope.${key}`, list, isStringArray(list), "an array of strings");
  }
  check(
    "btcmapFields",
    btcmapFields,
    isStringArray(btcmapFields) && btcmapFields.length > 0,
    "a non-empty array of strings",
  );

  check("publish", publish, isObject(publish), "an object with eventsPerSecond and okTimeoutMs");
  for (const key of ["eventsPerSecond", "okTimeoutMs"]) {
    const value = (publish as Record<string, unknown>)[key];
    check(`publish.${key}`, value, isPositiveNumber(value), "a number above 0");
  }

  const fraction = raw.deletionGuardFraction;
  check(
    "deletionGuardFraction",
    fraction,
    typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1,
    "a number from 0 to 1",
  );
  check("pilotSize", raw.pilotSize, Number.isInteger(raw.pilotSize) && (raw.pilotSize as number) > 0, "a positive integer");

  check("paths", raw.paths, isObject(raw.paths), "an object with data, out and state");
  for (const key of ["data", "out", "state"]) {
    const value = (raw.paths as Record<string, unknown>)[key];
    check(`paths.${key}`, value, typeof value === "string" && value.trim() !== "", "a non-empty string");
  }

  return raw as unknown as Config;
}

/** The pubkey of the header's author: the middle part of its `39998:<pubkey>:<d>` coordinate. */
export function headerAuthor(coordinate: string): string {
  const pubkey = coordinate.split(":")[1];
  if (!pubkey) throw new Error(`not an address coordinate: ${coordinate}`);
  return pubkey;
}
