import { buildCatalog } from "../catalog.js";
import type { Config } from "../config.js";
import { tagValue } from "../item.js";
import { bullets, coverageTable, duplicateList, samples, table } from "../markdown.js";
import type { Place } from "../place.js";
import { readCache } from "../source/btcmap.js";

/** `[value, count]` pairs, most common first, then by value. */
function counted(values: (string | undefined)[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
}

function osmKeyTable(places: Place[], key: "amenity" | "shop" | "craft", scope: string[]): string {
  const rows = counted(places.map((p) => p[key]));
  if (rows.length === 0) return "none";
  return table([key, "places", "in scope"], rows.map(([v, n]) => [v, n, scope.includes(v) ? "yes" : "no"]));
}

/**
 * A markdown census of a cache file: places by OSM amenity, shop and craft (and whether the
 * value is in the configured scope), the in-scope total by category, skips by reason, field
 * coverage and 20 sample items. Pure: reads the file, touches no network and no state.
 */
export function census(cfg: Config, cachePath: string): string {
  const raw = readCache(cachePath);
  const catalog = buildCatalog(raw, cfg);
  const items = [...catalog.items.values()];
  return [
    "# Census",
    "",
    `- Cache: \`${cachePath}\``,
    `- Records: ${raw.length}`,
    `- In scope: ${catalog.items.size}`,
    "",
    "## In scope by category",
    "",
    items.length === 0
      ? "none"
      : table(["category", "items"], counted(items.map((t) => tagValue(t, "category")))),
    "",
    "## Places by amenity",
    "",
    osmKeyTable(catalog.places, "amenity", cfg.scope.amenity),
    "",
    "## Places by shop",
    "",
    osmKeyTable(catalog.places, "shop", cfg.scope.shop),
    "",
    "## Places by craft",
    "",
    osmKeyTable(catalog.places, "craft", cfg.scope.craft),
    "",
    "## Skipped",
    "",
    table(
      ["reason", "places"],
      [...Object.entries(catalog.skipped), ["duplicate", catalog.duplicates.length]],
    ),
    "",
    "## Duplicates",
    "",
    duplicateList(catalog.duplicates),
    "",
    "## Malformed records",
    "",
    bullets(catalog.malformed),
    "",
    `## Field coverage over the ${items.length} in-scope items`,
    "",
    coverageTable(items),
    "",
    "## Sample items (first 20 by d)",
    "",
    samples(catalog.items),
    "",
  ].join("\n");
}
