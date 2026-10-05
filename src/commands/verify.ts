import type { NostrEvent } from "nostr-tools/core";
import type { Config } from "../config.js";
import { tagValue } from "../item.js";
import { newer, queryAll } from "../relay.js";
import type { LiveItem, State } from "../state.js";

const ITEM_KIND = 39999;

export interface RelayVerifyResult {
  /** Items (distinct `d`) the relay holds under the header coordinate. */
  onRelay: number;
  /** Items live in state. */
  inState: number;
  /** Live in state, absent from the relay. Sorted. */
  missing: string[];
  /** On the relay, not live in state. Sorted. */
  extra: string[];
  /** Live and on the relay, but the relay's newest version is not the one state recorded. Sorted. */
  stale: string[];
  /** Set when the relay could not be read in full; the lists are then empty. */
  error?: string;
}

function compare(events: NostrEvent[], live: Map<string, LiveItem>): RelayVerifyResult {
  // The relay may still hold an older version beside the newest; clients read only the newest.
  const onRelay = new Map<string, NostrEvent>();
  for (const ev of events) {
    const d = tagValue(ev.tags, "d") ?? "";
    onRelay.set(d, newer(ev, onRelay.get(d) ?? null));
  }
  return {
    onRelay: onRelay.size,
    inState: live.size,
    missing: [...live.keys()].filter((d) => !onRelay.has(d)).sort(),
    extra: [...onRelay.keys()].filter((d) => !live.has(d)).sort(),
    stale: [...live.values()]
      .filter((item) => onRelay.has(item.d) && onRelay.get(item.d)!.id !== item.latestEventId)
      .map((item) => item.d)
      .sort(),
  };
}

/**
 * Reads back every item each configured relay holds for the curator under the header
 * coordinate (`{kinds:[39999], authors:[curator], "#z":[coordinate]}`, paged with `until`)
 * and compares it with the live items in state by `d`. The relays are read at once; one that
 * cannot be read gets an `error` and does not stop the others.
 */
export async function verify(cfg: Config, state: State): Promise<Record<string, RelayVerifyResult>> {
  const live = state.liveItems();
  const filter = { kinds: [ITEM_KIND], authors: [cfg.curatorPubkey], "#z": [cfg.headerCoordinate] };
  const names = Object.keys(cfg.relays);
  const results = await Promise.all(
    names.map(async (name): Promise<RelayVerifyResult> => {
      try {
        return compare(await queryAll(cfg.relays[name]!, filter), live);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { onRelay: 0, inState: live.size, missing: [], extra: [], stale: [], error };
      }
    }),
  );
  return Object.fromEntries(names.map((name, i) => [name, results[i]!]));
}
