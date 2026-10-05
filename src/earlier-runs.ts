import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { manifestRelays } from "./manifest.js";
import type { State } from "./state.js";

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/** The event ids of `signed.jsonl`, one per line, and nothing else read from the line. */
function signedIds(runDir: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(join(runDir, "signed.jsonl"), "utf8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the newline that ends the last line
  return lines.map((line, i) => {
    let id: unknown;
    try {
      id = (JSON.parse(line) as { id?: unknown } | null)?.id;
    } catch {
      // Not JSON: reported below with the other lines that carry no id.
    }
    if (typeof id !== "string" || id === "") {
      throw new Error(`signed.jsonl line ${i + 1} is not a nostr event with an id`);
    }
    return id;
  });
}

/** What of one run is not yet published, as short phrases; none when it is complete or has nothing to publish. */
function missingOf(cfg: Config, state: State, runDir: string): string[] {
  const ids = signedIds(runDir);
  if (ids === undefined) {
    try {
      // A run that holds no events (a rebuild that found nothing to do) can never be signed.
      return statSync(join(runDir, "unsigned.jsonl")).size > 0 ? ["not signed"] : [];
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }
  const missing: string[] = [];
  for (const relay of manifestRelays(runDir) ?? Object.keys(cfg.relays)) {
    const short = ids.filter((id) => !state.acceptedOn(id, relay)).length;
    if (short > 0) missing.push(`not published to ${relay}: ${short} of ${ids.length} events missing`);
  }
  return missing;
}

/**
 * One warning line for each earlier run in `<paths.out>` that was built but is not fully
 * published, in run id order: it has `unsigned.jsonl` but no `signed.jsonl` (not signed), or a
 * `signed.jsonl` whose events some relay it was built for has not accepted, per state. The
 * relays are those in the run's manifest, else the configured ones. A dir without a
 * `manifest.json` is not a run and is ignored, and the scan reads `signed.jsonl` ids only.
 * A run that cannot be checked is reported as such: the scan only advises, so it never throws
 * for one run's files.
 */
export function earlierRunWarnings(cfg: Config, state: State): string[] {
  let names: string[];
  try {
    names = readdirSync(cfg.paths.out, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const warnings: string[] = [];
  for (const name of names) {
    const runDir = join(cfg.paths.out, name);
    if (!manifestExists(runDir)) continue;
    try {
      const missing = missingOf(cfg, state, runDir);
      if (missing.length > 0) warnings.push(`warning: earlier run ${name} is not fully published: ${missing.join("; ")}`);
    } catch (err) {
      warnings.push(`warning: could not check earlier run ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return warnings;
}

function manifestExists(runDir: string): boolean {
  return statSync(join(runDir, "manifest.json"), { throwIfNoEntry: false })?.isFile() ?? false;
}
