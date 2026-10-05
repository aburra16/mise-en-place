import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Place } from "../src/place.js";
import { classify } from "../src/scope.js";

const { scope } = loadConfig("config.json");

function place(over: Partial<Place>): Place {
  return { sourceId: "1", osmId: "node:1", name: "X", lat: 0, lon: 0, payment: {}, ...over };
}

describe("classify", () => {
  it("returns the amenity for an in-scope amenity", () => {
    expect(classify(place({ amenity: "restaurant" }), scope)).toBe("restaurant");
  });

  it("lets amenity win over shop", () => {
    expect(classify(place({ amenity: "cafe", shop: "bakery" }), scope)).toBe("cafe");
  });

  it("uses shop when the amenity is out of scope", () => {
    expect(classify(place({ amenity: "atm", shop: "bakery" }), scope)).toBe("bakery");
  });

  it("uses craft when amenity and shop are absent", () => {
    expect(classify(place({ craft: "brewery" }), scope)).toBe("brewery");
  });

  it("excludes supermarket and convenience shops", () => {
    expect(classify(place({ shop: "supermarket" }), scope)).toBeNull();
    expect(classify(place({ shop: "convenience" }), scope)).toBeNull();
  });

  it("excludes caterer and marketplace", () => {
    expect(classify(place({ craft: "caterer" }), scope)).toBeNull();
    expect(classify(place({ amenity: "marketplace" }), scope)).toBeNull();
  });

  it("excludes a place with no name, even a restaurant", () => {
    expect(classify(place({ amenity: "restaurant", name: undefined }), scope)).toBeNull();
  });
});
