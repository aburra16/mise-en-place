import { createHash } from "node:crypto";
import type { Tags } from "./item.js";
import type { LiveItem } from "./state.js";

/**
 * The change hash of an item: sha256 hex of its tags as JSON. `created_at` is not part of
 * the tags, so re-signing the same item never looks like a change.
 */
export function contentHash(tags: Tags): string {
  return createHash("sha256").update(JSON.stringify(tags)).digest("hex");
}

export interface Diff {
  /** Built items with no live item of the same `d`, sorted by `d`. */
  created: Tags[];
  /** Built items whose hash differs from the live item's, sorted by `d`. */
  changed: Tags[];
  unchanged: number;
  /** `d` values that are live but were not built, sorted. Always empty without `detectGone`. */
  gone: string[];
}

/**
 * Compares built items (keyed by `d`) with the live items in state. Only a build that saw
 * every place may call a live item gone, so a filtered or pilot build passes
 * `detectGone: false`. A `held` d (its record is still in the fetch but could not be read) is
 * never gone.
 */
export function diffItems(
  built: Map<string, Tags>,
  live: Map<string, LiveItem>,
  opts: { detectGone: boolean; held?: ReadonlySet<string> },
): Diff {
  const diff: Diff = { created: [], changed: [], unchanged: 0, gone: [] };
  for (const d of [...built.keys()].sort()) {
    const tags = built.get(d)!;
    const current = live.get(d);
    if (current === undefined) diff.created.push(tags);
    else if (current.contentHash !== contentHash(tags)) diff.changed.push(tags);
    else diff.unchanged++;
  }
  if (opts.detectGone) {
    diff.gone = [...live.keys()].filter((d) => !built.has(d) && !opts.held?.has(d)).sort();
  }
  return diff;
}
