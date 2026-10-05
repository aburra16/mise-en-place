import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

/**
 * The parts of a config that decide where a run's events go and what they mean: the list,
 * the signer, the relays and the state file that records them. `build` writes this block into
 * `manifest.json` as `config`, and `sign` and `publish` refuse a run whose block differs from
 * the config they were started with. So a rehearsal run is never signed or published with the
 * real config, nor a real run with the rehearsal one.
 */
export interface ConfigIdentity {
  headerCoordinate: string;
  curatorPubkey: string;
  relays: Record<string, string>;
  /** `paths.state` as the config spells it. */
  statePath: string;
}

const FIELDS = ["headerCoordinate", "curatorPubkey", "relays", "statePath"] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Relays sorted by name, so the order a config lists them in never counts as a difference. */
function sortedRelays(relays: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(relays).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function configIdentity(cfg: Config): ConfigIdentity {
  return {
    headerCoordinate: cfg.headerCoordinate,
    curatorPubkey: cfg.curatorPubkey,
    relays: sortedRelays(cfg.relays) as Record<string, string>,
    statePath: cfg.paths.state,
  };
}

/** One field as compared and shown: JSON text, with relays in name order. */
function shown(field: (typeof FIELDS)[number], value: unknown): string {
  return JSON.stringify(field === "relays" && isObject(value) ? sortedRelays(value) : value) ?? "nothing";
}

/**
 * Refuses unless `<runDir>/manifest.json` exists, is JSON and records a `config` block equal,
 * field by field, to `cfg`'s identity. A run with no manifest, or one written before the
 * manifest held a config block, is refused too: nothing then says which config built it.
 * The message names the first field that differs and both values.
 */
export function checkRunConfig(cfg: Config, runDir: string): void {
  const path = join(runDir, "manifest.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${path} not found, so nothing says which config built this run; build it again with npm run build`);
    }
    throw err;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; build the run again with npm run build`);
  }
  const recorded = isObject(manifest) ? manifest.config : undefined;
  if (!isObject(recorded)) {
    throw new Error(
      `${path} records no config, so nothing says which config built this run; build it again with npm run build`,
    );
  }
  const current = configIdentity(cfg);
  for (const field of FIELDS) {
    const was = shown(field, recorded[field]);
    const now = shown(field, current[field]);
    if (was !== now) {
      throw new Error(
        `${runDir} was built with another config: ${field} is ${was} in ${path}, but ${now} in the config ` +
          "now loaded; check MISE_CONFIG, or build a new run with this config",
      );
    }
  }
}

/**
 * The relay names a run was built for: the keys of `config.relays` in `<runDir>/manifest.json`.
 * Undefined when the manifest cannot be read or records no relays, so the caller can fall back
 * to its own. Reads only; `checkRunConfig` is what refuses a run.
 */
export function manifestRelays(runDir: string): string[] | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    const relays = isObject(manifest) && isObject(manifest.config) ? manifest.config.relays : undefined;
    const names = isObject(relays) ? Object.keys(relays) : [];
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined;
  }
}
