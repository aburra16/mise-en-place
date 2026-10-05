import type { Config } from "./config.js";
import { buildItem, byBtcmapId, tagValue, type Tags } from "./item.js";
import type { Place } from "./place.js";
import { classify } from "./scope.js";
import { normalize, type RawPlace } from "./source/btcmap.js";

/** Two cache records that build the same `d`: the lower `btcmap-id` is kept. */
export interface Duplicate {
  osmId: string;
  kept: string;
  dropped: string;
}

export interface Catalog {
  /** Every record that normalized, in scope or not, in cache order. */
  places: Place[];
  /** One item per `d` for the in-scope places. */
  items: Map<string, Tags>;
  skipped: { "out-of-scope": number; malformed: number };
  duplicates: Duplicate[];
  /** One line per record `normalize` refused: its btcmap id (or cache index) and why. */
  malformed: string[];
}

function describeMalformed(record: unknown, index: number, err: unknown): string {
  const id = (record as { id?: unknown } | null)?.id;
  const label =
    typeof id === "number" || (typeof id === "string" && id.trim() !== "")
      ? `btcmap ${String(id)}`
      : `cache index ${index}`;
  return `${label}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Turns cache records into items. A record `normalize` refuses is counted as malformed and
 * listed, never fatal. A place `classify` rejects is out of scope. When two in-scope places
 * build the same `d`, the lower `btcmap-id` wins whatever the cache order, so one `d` never
 * yields two events.
 */
export function buildCatalog(
  raw: readonly unknown[],
  cfg: Pick<Config, "scope" | "headerCoordinate">,
): Catalog {
  const catalog: Catalog = {
    places: [],
    items: new Map(),
    skipped: { "out-of-scope": 0, malformed: 0 },
    duplicates: [],
    malformed: [],
  };
  raw.forEach((record, index) => {
    let place: Place;
    try {
      place = normalize(record as RawPlace);
    } catch (err) {
      catalog.skipped.malformed++;
      catalog.malformed.push(describeMalformed(record, index, err));
      return;
    }
    catalog.places.push(place);

    const category = classify(place, cfg.scope);
    if (category === null) {
      catalog.skipped["out-of-scope"]++;
      return;
    }
    const tags = buildItem(place, category, cfg.headerCoordinate);
    const d = tagValue(tags, "d")!;
    const existing = catalog.items.get(d);
    if (existing === undefined) {
      catalog.items.set(d, tags);
      return;
    }
    const [kept, dropped] = byBtcmapId(tags, existing) < 0 ? [tags, existing] : [existing, tags];
    catalog.items.set(d, kept);
    catalog.duplicates.push({
      osmId: tagValue(dropped, "osm-id")!,
      kept: tagValue(kept, "btcmap-id")!,
      dropped: tagValue(dropped, "btcmap-id")!,
    });
  });
  return catalog;
}

export interface FieldCoverage {
  field: string;
  count: number;
  /** Percentage of the items that carry the field. */
  pct: number;
}

/** For each tag name, how many items carry it at least once; most common first. */
export function fieldCoverage(items: readonly Tags[]): FieldCoverage[] {
  const counts = new Map<string, number>();
  for (const tags of items) {
    for (const name of new Set(tags.map((t) => t[0] ?? ""))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([field, count]) => ({ field, count, pct: (100 * count) / items.length }))
    .sort((a, b) => b.count - a.count || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}
