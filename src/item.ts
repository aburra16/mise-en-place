import { iso1A2Code } from "@rapideditor/country-coder";
import ngeohash from "ngeohash";
import type { Place } from "./place.js";

export type Tags = string[][];

/** The `d` tag for an OSM id: `node:1` becomes `osm-node-1`. */
export function dTag(osmId: string): string {
  return `osm-${osmId.replaceAll(":", "-")}`;
}

/** Geohashes at 9 characters, then its prefixes of 6, 5 and 4. */
export function geohashes(lat: number, lon: number): string[] {
  const full = ngeohash.encode(lat, lon, 9);
  return [full, full.slice(0, 6), full.slice(0, 5), full.slice(0, 4)];
}

/**
 * Only the exact value `yes` counts. A place on BTC Map accepts bitcoin, so when neither
 * rail is confirmed the answer is the generic `yes`.
 */
export function acceptsBitcoin(p: Place["payment"]): "both" | "lightning" | "onchain" | "yes" {
  const lightning = p.lightning === "yes" || p.lightningContactless === "yes";
  const onchain = p.onchain === "yes";
  if (lightning && onchain) return "both";
  if (lightning) return "lightning";
  if (onchain) return "onchain";
  return "yes";
}

/**
 * ISO 3166-1 alpha-2 code from the coordinates, at territory level so Puerto Rico is `PR`
 * and not `US`. Where country-coder finds nothing, the place's own addr tag; else undefined.
 */
export function countryOf(place: Place): string | undefined {
  return iso1A2Code([place.lon, place.lat], { level: "territory" }) ?? place.countryTag;
}

/** The `;`-separated cuisine values: trimmed, lowercased, empty parts dropped. */
function cuisineValues(cuisine: string | undefined): string[] {
  if (cuisine === undefined) return [];
  return cuisine
    .split(";")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");
}

/**
 * The `t` values: the category with `_` as a space, every cuisine value, then the locality.
 * Lowercased, deduplicated, original order kept.
 */
export function deriveT(
  category: string,
  cuisine: string | undefined,
  locality: string | undefined,
): string[] {
  const all = [category.replaceAll("_", " "), ...cuisineValues(cuisine), locality ?? ""]
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");
  return [...new Set(all)];
}

/**
 * The tags of a kind 39999 item, in the order of spec section 5. A field with no value is
 * omitted. Call it only for a place `classify` accepted, which guarantees a name.
 */
export function buildItem(place: Place, category: string, headerCoordinate: string): Tags {
  if (place.name === undefined) {
    throw new Error(`place ${place.osmId} has no name; classify it out of scope first`);
  }
  const tags: Tags = [];
  const add = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") tags.push([name, value]);
  };

  add("d", dTag(place.osmId));
  add("z", headerCoordinate);
  add("name", place.name);
  add("category", category);
  add("address", place.address);
  add("locality", place.city);
  add("region", place.state);
  add("postal-code", place.postcode);
  add("country", countryOf(place));
  add("cuisine", cuisineValues(place.cuisine)[0]);
  add("osm-id", place.osmId);
  add("lat", String(place.lat));
  add("lon", String(place.lon));
  add("website", place.website);
  add("phone", place.phone);
  add("opening-hours", place.openingHours);
  add("description", place.description);
  add("image", place.image?.startsWith("https://") ? place.image : undefined);
  add("accepts-bitcoin", acceptsBitcoin(place.payment));
  add("btcmap-id", place.sourceId);
  add("source", "btcmap");
  add("license", "ODbL-1.0");
  for (const g of geohashes(place.lat, place.lon)) add("g", g);
  for (const t of deriveT(category, place.cuisine, place.city)) add("t", t);
  add(
    "alt",
    place.city === undefined
      ? `Food and drink place: ${place.name}`
      : `Food and drink place: ${place.name}, ${place.city}`,
  );
  return tags;
}
