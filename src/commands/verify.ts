import type { AbstractRelay } from "nostr-tools/abstract-relay";
import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { Config } from "../config.js";
import { tagValue } from "../item.js";
import { connectRelay, DEFAULT_READ_TIMEOUT_MS, newer, query, queryPaged, relayPageSize } from "../relay.js";
import type { LiveItem, State } from "../state.js";

const ITEM_KIND = 39999;
/** Live `d` values asked for in one `#d` query (fewer if the relay's page is smaller). */
const D_BATCH = 200;

export type ExtraCheck = "complete" | `incomplete: ${string}`;

export interface RelayVerifyResult {
  /** Distinct `d` found on the relay: the live ones it holds plus the extras seen. */
  onRelay: number;
  /** Items live in state. */
  inState: number;
  /** Live in state, absent from the relay. Exact: every live `d` is asked for by name. Sorted. */
  missing: string[];
  /** On the relay, not live in state. Only those seen when `extraCheck` is incomplete. Sorted. */
  extra: string[];
  /** Live and on the relay, but the relay's newest version is not the one state recorded. Exact. Sorted. */
  stale: string[];
  /**
   * Extras can only be found by listing everything the relay holds, paging by `until`. That
   * cannot step past one `created_at` shared by more than a page of events, and one run's
   * events all share one, so a large run leaves this incomplete. missing and stale are exact
   * either way.
   */
  extraCheck: ExtraCheck;
  /** Set when the relay could not be read; the lists are then empty. */
  error?: string;
}

export interface VerifyOptions {
  /** The page size for reading a relay, instead of its NIP-11 max_limit. */
  pageSize?: number;
  /** Reads a relay's NIP-11 document. Tests inject it so no HTTP request is made. */
  fetchRelayInfo?: (wsUrl: string) => Promise<unknown>;
}

const dOf = (ev: NostrEvent) => tagValue(ev.tags, "d") ?? "";

/**
 * The newest event the relay holds for each of `ds`, asked for by name in batches of D_BATCH,
 * or of one page if the relay's page is smaller, so the relay's own cap never cuts a batch
 * short unseen. A relay returns the newest events first, so an answer that names every `d` of
 * the batch holds each one's newest version even if it is full. A full answer that leaves a
 * `d` out may have cut it off, and that is an error rather than a false "missing".
 */
async function newestByD(
  relay: AbstractRelay,
  filter: Filter,
  ds: string[],
  pageSize: number,
): Promise<Map<string, NostrEvent>> {
  const batchSize = Math.min(D_BATCH, pageSize);
  const newest = new Map<string, NostrEvent>();
  for (let i = 0; i < ds.length; i += batchSize) {
    const batch = ds.slice(i, i + batchSize);
    const limit = Math.max(batch.length, pageSize);
    const events = await query(relay, { ...filter, "#d": batch, limit }, DEFAULT_READ_TIMEOUT_MS);
    for (const ev of events) newest.set(dOf(ev), newer(ev, newest.get(dOf(ev)) ?? null));
    if (events.length >= limit && batch.some((d) => !newest.has(d))) {
      throw new Error(
        `${relay.url} returned a full page (${limit}) for ${batch.length} items and left some out, ` +
          "so verify cannot tell missing from cut off",
      );
    }
  }
  return newest;
}

function extraCheckOf(stalledAt: number | undefined, pageSize: number): ExtraCheck {
  if (stalledAt === undefined) return "complete";
  const why = `more than ${pageSize} events share created_at ${stalledAt}`;
  return `incomplete: ${why}, so listing by until could not see them all`;
}

/** One relay, on one connection: every live `d` by name, then everything listed for extras. */
async function verifyRelay(
  url: string,
  cfg: Config,
  live: Map<string, LiveItem>,
  opts: VerifyOptions,
): Promise<RelayVerifyResult> {
  const filter = { kinds: [ITEM_KIND], authors: [cfg.curatorPubkey], "#z": [cfg.headerCoordinate] };
  const pageSize = opts.pageSize ?? (await relayPageSize(url, opts.fetchRelayInfo));
  const relay = await connectRelay(url, DEFAULT_READ_TIMEOUT_MS);
  try {
    const held = await newestByD(relay, filter, [...live.keys()], pageSize);
    const listed = await queryPaged(relay, filter, pageSize, DEFAULT_READ_TIMEOUT_MS);
    const extra = [...new Set(listed.events.map(dOf))].filter((d) => !live.has(d)).sort();
    return {
      onRelay: held.size + extra.length,
      inState: live.size,
      missing: [...live.keys()].filter((d) => !held.has(d)).sort(),
      extra,
      stale: [...live.values()]
        .filter((item) => held.has(item.d) && held.get(item.d)!.id !== item.latestEventId)
        .map((item) => item.d)
        .sort(),
      extraCheck: extraCheckOf(listed.stalledAt, pageSize),
    };
  } finally {
    relay.close();
  }
}

/**
 * Compares each configured relay with the live items in state, all relays at once, on the
 * filter `{kinds:[39999], authors:[curator], "#z":[coordinate]}`. missing and stale are exact
 * for any number of items; extras are as complete as `extraCheck` says. The page size is the
 * relay's NIP-11 max_limit (see relayPageSize). A relay that cannot be read gets an `error`
 * and does not stop the others.
 */
export async function verify(
  cfg: Config,
  state: State,
  opts: VerifyOptions = {},
): Promise<Record<string, RelayVerifyResult>> {
  const live = state.liveItems();
  const names = Object.keys(cfg.relays);
  const results = await Promise.all(
    names.map(async (name): Promise<RelayVerifyResult> => {
      try {
        return await verifyRelay(cfg.relays[name]!, cfg, live, opts);
      } catch (err) {
        return {
          onRelay: 0,
          inState: live.size,
          missing: [],
          extra: [],
          stale: [],
          extraCheck: "incomplete: the relay could not be read",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return Object.fromEntries(names.map((name, i) => [name, results[i]!]));
}

/** Up to 20 values, then how many more there are. */
function listed(ds: string[]): string {
  const shown = ds.slice(0, 20).join(", ");
  return ds.length > 20 ? `${shown} and ${ds.length - 20} more` : shown;
}

/**
 * What `npm run verify` prints: a line per relay plus its missing, extra and stale values, a
 * warning per incomplete extra check, and the relays that fail (an error, or anything missing,
 * extra or stale). An incomplete extra check alone does not fail a relay.
 */
export function verifySummary(results: Record<string, RelayVerifyResult>): {
  lines: string[];
  warnings: string[];
  failed: string[];
} {
  const lines: string[] = [];
  const warnings: string[] = [];
  const failed: string[] = [];
  for (const [name, r] of Object.entries(results)) {
    if (r.error !== undefined) {
      lines.push(`${name}: ${r.error}`);
      failed.push(name);
      continue;
    }
    lines.push(
      `${name}: on relay ${r.onRelay}, in state ${r.inState}, ` +
        `missing ${r.missing.length}, extra ${r.extra.length}, stale ${r.stale.length}`,
    );
    const lists: [string, string[]][] = [["missing", r.missing], ["extra", r.extra], ["stale", r.stale]];
    for (const [label, ds] of lists) if (ds.length > 0) lines.push(`  ${label}: ${listed(ds)}`);
    if (lists.some(([, ds]) => ds.length > 0)) failed.push(name);
    if (r.extraCheck !== "complete") warnings.push(`${name}: extra check ${r.extraCheck}`);
  }
  return { lines, warnings, failed };
}
