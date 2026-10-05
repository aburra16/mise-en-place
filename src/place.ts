/**
 * A source-neutral place record. Every string field is already trimmed, and an
 * empty string is never present: an absent value is `undefined`.
 */
export interface Place {
  sourceId: string;
  osmId: string;
  name?: string;
  lat: number;
  lon: number;
  address?: string;
  city?: string;
  state?: string;
  postcode?: string;
  countryTag?: string;
  amenity?: string;
  shop?: string;
  craft?: string;
  /** Raw OSM value, e.g. "pizza;italian". */
  cuisine?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  description?: string;
  image?: string;
  payment: { lightning?: string; onchain?: string; lightningContactless?: string };
}
