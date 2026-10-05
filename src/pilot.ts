import { byBtcmapId, tagValue, type Tags } from "./item.js";

/** Round-robin merge: the first of each list, then the second of each, and so on. */
function interleave(lists: Tags[][]): Tags[] {
  const out: Tags[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

/** Groups items by `key`, returning the groups in key order. */
function groupSorted(items: Tags[], key: (t: Tags) => string): Tags[][] {
  const groups = new Map<string, Tags[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [item]);
    else group.push(item);
  }
  return [...groups.keys()].sort().map((k) => groups.get(k)!);
}

/** `btcmap-id` order, then `d` order for the (malformed) case of two items with one id. */
function byIdThenD(a: Tags, b: Tags): number {
  const da = tagValue(a, "d") ?? "";
  const db = tagValue(b, "d") ?? "";
  return byBtcmapId(a, b) || (da < db ? -1 : da > db ? 1 : 0);
}

/**
 * A deterministic pilot of `n` items spread over places and categories. Items are bucketed
 * by the first 2 characters of their first geohash (cells of roughly 1,250 by 625 km). In
 * each bucket the categories take turns, each in `btcmap-id` order; then the buckets, in key
 * order, take turns until `n` are taken. The result does not depend on the input order.
 */
export function selectPilot(items: Tags[], n: number): Tags[] {
  const cells = groupSorted(items, (t) => (tagValue(t, "g") ?? "").slice(0, 2)).map((cell) =>
    interleave(
      groupSorted(cell, (t) => tagValue(t, "category") ?? "").map((c) => [...c].sort(byIdThenD)),
    ),
  );
  return interleave(cells).slice(0, Math.max(0, n));
}
