import type { Config } from "./config.js";
import type { Place } from "./place.js";

/**
 * The `category` for a place, or null when it is out of scope. A place needs a name. The
 * first of amenity, shop and craft whose value is in its config list decides the category,
 * so an out-of-scope amenity does not stop an in-scope shop from matching.
 */
export function classify(place: Place, scope: Config["scope"]): string | null {
  if (place.name === undefined) return null;
  if (place.amenity !== undefined && scope.amenity.includes(place.amenity)) return place.amenity;
  if (place.shop !== undefined && scope.shop.includes(place.shop)) return place.shop;
  if (place.craft !== undefined && scope.craft.includes(place.craft)) return place.craft;
  return null;
}
