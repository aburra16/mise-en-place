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

/** Reads and validates the config: `path`, else `$MISE_CONFIG`, else `config.json`. */
export function loadConfig(path?: string): Config {
  const file = path ?? process.env.MISE_CONFIG ?? "config.json";
  const cfg = JSON.parse(readFileSync(file, "utf8")) as Config;
  if (typeof cfg.headerCoordinate !== "string" || !COORDINATE_RE.test(cfg.headerCoordinate)) {
    throw new Error(
      `${file}: headerCoordinate must look like 39998:<64 hex pubkey>:<d tag>`,
    );
  }
  if (typeof cfg.curatorPubkey !== "string" || !PUBKEY_RE.test(cfg.curatorPubkey)) {
    throw new Error(`${file}: curatorPubkey must be 64 lowercase hex characters`);
  }
  return cfg;
}

/** The pubkey of the header's author: the middle part of its `39998:<pubkey>:<d>` coordinate. */
export function headerAuthor(coordinate: string): string {
  const pubkey = coordinate.split(":")[1];
  if (!pubkey) throw new Error(`not an address coordinate: ${coordinate}`);
  return pubkey;
}
