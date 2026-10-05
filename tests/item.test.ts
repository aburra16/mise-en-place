import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  acceptsBitcoin,
  buildItem,
  countryOf,
  deriveT,
  dTag,
  geohashes,
  type Tags,
} from "../src/item.js";
import type { Place } from "../src/place.js";
import { normalize, type RawPlace } from "../src/source/btcmap.js";

const COORD = loadConfig("config.json").headerCoordinate;
const fixture = JSON.parse(readFileSync("tests/fixtures/place-15.json", "utf8")) as RawPlace;

/** A bare place in the open ocean, so country-coder finds no country for it. */
function place(over: Partial<Place> = {}): Place {
  return {
    sourceId: "7",
    osmId: "node:7",
    name: "X",
    lat: -40,
    lon: -140,
    payment: {},
    ...over,
  };
}

const names = (tags: Tags): string[] => tags.map((t) => t[0] ?? "");
const first = (tags: Tags, name: string): string | undefined => tags.find((t) => t[0] === name)?.[1];

describe("dTag", () => {
  it("prefixes osm- and replaces the colon with a dash", () => {
    expect(dTag("node:1")).toBe("osm-node-1");
    expect(dTag("way:25")).toBe("osm-way-25");
  });
});

describe("geohashes", () => {
  it("returns the 9, 6, 5 and 4 character geohashes", () => {
    expect(geohashes(46.0042728, 8.9502477)).toEqual(["u0nmewv67", "u0nmew", "u0nme", "u0nm"]);
  });
});

describe("acceptsBitcoin", () => {
  it.each([
    [{ lightning: "yes", onchain: "yes" }, "both"],
    [{ lightning: "yes", onchain: "no" }, "lightning"],
    [{ lightning: "no", onchain: "yes" }, "onchain"],
    [{ lightningContactless: "yes" }, "lightning"],
    [{ lightningContactless: "yes", onchain: "yes" }, "both"],
    [{ lightning: "no", onchain: "no" }, "yes"],
    [{}, "yes"],
    [{ lightning: "Yes", onchain: "true" }, "yes"],
  ] as const)("%j gives %s", (payment, expected) => {
    expect(acceptsBitcoin(payment)).toBe(expected);
  });
});

describe("countryOf", () => {
  it("resolves from the coordinates", () => {
    expect(countryOf(place({ lat: 46.0042728, lon: 8.9502477 }))).toBe("CH");
  });

  it("prefers the coordinates over the addr tag", () => {
    expect(countryOf(place({ lat: 46.0042728, lon: 8.9502477, countryTag: "IT" }))).toBe("CH");
  });

  it("resolves a territory to its own code, not its sovereign's", () => {
    expect(countryOf(place({ lat: 18.4, lon: -66.1 }))).toBe("PR");
  });

  it("falls back to the addr tag where country-coder finds nothing", () => {
    expect(countryOf(place({ countryTag: "US" }))).toBe("US");
  });

  it("is undefined with neither", () => {
    expect(countryOf(place())).toBeUndefined();
  });
});

describe("deriveT", () => {
  it("replaces underscores, keeps every cuisine, lowercases and dedupes in order", () => {
    expect(deriveT("fast_food", "burger;Burger;fries", "Austin")).toEqual([
      "fast food",
      "burger",
      "fries",
      "austin",
    ]);
  });

  it("works with no cuisine and no locality", () => {
    expect(deriveT("cafe", undefined, undefined)).toEqual(["cafe"]);
  });

  it("drops empty cuisine parts and trims the rest", () => {
    expect(deriveT("bar", " ;Pizza ; ;Italian;", undefined)).toEqual(["bar", "pizza", "italian"]);
  });

  it("dedupes a cuisine that repeats the category or the locality", () => {
    expect(deriveT("cafe", "cafe", "Cafe")).toEqual(["cafe"]);
  });
});

describe("buildItem", () => {
  it("builds exactly the expected tags for place 15", () => {
    expect(buildItem(normalize(fixture), "restaurant", COORD)).toEqual([
      ["d", "osm-node-10011069455"],
      ["z", COORD],
      ["name", "Gabbani Enoteca"],
      ["category", "restaurant"],
      ["address", "1 Piazza Cioccaro Lugano 6900"],
      ["locality", "Lugano"],
      ["postal-code", "6900"],
      ["country", "CH"],
      ["osm-id", "node:10011069455"],
      ["lat", "46.0042728"],
      ["lon", "8.9502477"],
      ["website", "https://www.gabbani.com/home/"],
      ["phone", "+41 91 911 30 80"],
      ["accepts-bitcoin", "lightning"],
      ["btcmap-id", "15"],
      ["source", "btcmap"],
      ["license", "ODbL-1.0"],
      ["g", "u0nmewv67"],
      ["g", "u0nmew"],
      ["g", "u0nme"],
      ["g", "u0nm"],
      ["t", "restaurant"],
      ["t", "lugano"],
      ["alt", "Food and drink place: Gabbani Enoteca, Lugano"],
    ]);
  });

  it("takes the first cuisine value, lowercased, and keeps them all in t", () => {
    const tags = buildItem(place({ cuisine: " Pizza;Italian", city: "Rome" }), "restaurant", COORD);
    expect(tags.filter((t) => t[0] === "cuisine")).toEqual([["cuisine", "pizza"]]);
    const t = tags.filter((x) => x[0] === "t").map((x) => x[1]);
    expect(t).toEqual(["restaurant", "pizza", "italian", "rome"]);
  });

  it("skips an empty leading cuisine part instead of writing an empty tag", () => {
    const tags = buildItem(place({ cuisine: ";Italian" }), "restaurant", COORD);
    expect(first(tags, "cuisine")).toBe("italian");
    expect(tags.every((t) => t.every((v) => v !== ""))).toBe(true);
  });

  it("follows the spec section 5 field order for a fully populated place", () => {
    const full = place({
      osmId: "way:42",
      name: "Full",
      lat: 46.0042728,
      lon: 8.9502477,
      address: "1 Main St",
      city: "Lugano",
      state: "TI",
      postcode: "6900",
      countryTag: "CH",
      cuisine: "pizza;italian",
      website: "https://example.com",
      phone: "+41 1",
      openingHours: "Mo-Su 09:00-18:00",
      description: "A place",
      image: "https://example.com/a.jpg",
      payment: { lightning: "yes", onchain: "yes" },
    });
    expect(names(buildItem(full, "restaurant", COORD))).toEqual([
      "d", "z", "name", "category", "address", "locality", "region", "postal-code", "country",
      "cuisine", "osm-id", "lat", "lon", "website", "phone", "opening-hours", "description",
      "image", "accepts-bitcoin", "btcmap-id", "source", "license",
      "g", "g", "g", "g", "t", "t", "t", "t", "alt",
    ]);
  });

  it("maps each source field to its tag", () => {
    const tags = buildItem(
      place({
        sourceId: "99",
        osmId: "relation:5",
        name: "Mapped",
        address: "A",
        city: "L",
        state: "R",
        postcode: "P",
        openingHours: "24/7",
        description: "D",
      }),
      "fast_food",
      COORD,
    );
    expect(first(tags, "d")).toBe("osm-relation-5");
    expect(first(tags, "z")).toBe(COORD);
    expect(first(tags, "category")).toBe("fast_food");
    expect(first(tags, "address")).toBe("A");
    expect(first(tags, "locality")).toBe("L");
    expect(first(tags, "region")).toBe("R");
    expect(first(tags, "postal-code")).toBe("P");
    expect(first(tags, "osm-id")).toBe("relation:5");
    expect(first(tags, "opening-hours")).toBe("24/7");
    expect(first(tags, "description")).toBe("D");
    expect(first(tags, "btcmap-id")).toBe("99");
    expect(first(tags, "source")).toBe("btcmap");
    expect(first(tags, "license")).toBe("ODbL-1.0");
    expect(tags.filter((t) => t[0] === "t")[0]).toEqual(["t", "fast food"]);
  });

  it("emits exactly one z and no list, b, p, e, a or i tags", () => {
    const tags = buildItem(normalize(fixture), "restaurant", COORD);
    expect(tags.filter((t) => t[0] === "z")).toHaveLength(1);
    expect(names(tags).filter((n) => ["b", "p", "e", "a", "i"].includes(n))).toEqual([]);
  });

  it("omits missing fields and never writes an empty value", () => {
    const tags = buildItem(place(), "cafe", COORD);
    expect(names(tags)).toEqual([
      "d", "z", "name", "category", "osm-id", "lat", "lon", "accepts-bitcoin", "btcmap-id",
      "source", "license", "g", "g", "g", "g", "t", "alt",
    ]);
    expect(tags.every((t) => t.length === 2 && t.every((v) => v !== ""))).toBe(true);
  });

  it("keeps an https image and drops an http one", () => {
    expect(first(buildItem(place({ image: "https://a.example/x.jpg" }), "cafe", COORD), "image")).toBe(
      "https://a.example/x.jpg",
    );
    expect(first(buildItem(place({ image: "http://a.example/x.jpg" }), "cafe", COORD), "image"))
      .toBeUndefined();
  });

  it("writes the website verbatim, whatever its scheme", () => {
    expect(first(buildItem(place({ website: "http://a.example" }), "cafe", COORD), "website")).toBe(
      "http://a.example",
    );
  });

  it("writes alt without a locality as the name alone", () => {
    const tags = buildItem(place({ name: "X" }), "cafe", COORD);
    expect(tags.at(-1)).toEqual(["alt", "Food and drink place: X"]);
  });

  it("falls back to the addr tag for the country in open ocean, and omits it without one", () => {
    expect(buildItem(place({ countryTag: "US" }), "cafe", COORD)).toContainEqual(["country", "US"]);
    expect(first(buildItem(place(), "cafe", COORD), "country")).toBeUndefined();
  });

  it("gives a territory its own country code", () => {
    expect(first(buildItem(place({ lat: 18.4, lon: -66.1 }), "cafe", COORD), "country")).toBe("PR");
  });

  it("throws for a place with no name, which classify never lets through", () => {
    expect(() => buildItem(place({ name: undefined }), "cafe", COORD)).toThrow(/no name/);
  });
});
