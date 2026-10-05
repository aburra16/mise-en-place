import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import {
  fetchPlaces,
  latestCachePath,
  normalize,
  placesUrl,
  readCache,
  type RawPlace,
} from "../src/source/btcmap.js";

const place15 = JSON.parse(readFileSync("tests/fixtures/place-15.json", "utf8")) as RawPlace;

let dir: string;
let cfg: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mise-btcmap-"));
  const base = loadConfig("config.json");
  cfg = { ...base, paths: { ...base.paths, data: dir } };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cacheDir = () => join(dir, "cache");

/** Names of the files in the cache dir; empty when the dir was never created. */
function cacheFiles(): string[] {
  try {
    return readdirSync(cacheDir()).sort();
  } catch {
    return [];
  }
}

/** A stand-in for `fetch`: never touches the network. */
function stubFetch(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

/** `n` minimal raw places, enough for counting. */
const rawPlaces = (n: number): RawPlace[] => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

function seedCache(date: string, records: RawPlace[]): string {
  mkdirSync(cacheDir(), { recursive: true });
  const path = join(cacheDir(), `places-${date}.json`);
  writeFileSync(path, JSON.stringify(records));
  return path;
}

describe("normalize", () => {
  it("maps place 15", () => {
    const p = normalize(place15);
    expect(p.sourceId).toBe("15");
    expect(p.osmId).toBe("node:10011069455");
    expect(p.name).toBe("Gabbani Enoteca");
    expect(p.lat).toBe(46.0042728);
    expect(p.lon).toBe(8.9502477);
    expect(p.amenity).toBe("restaurant");
    expect(p.city).toBe("Lugano");
    expect(p.postcode).toBe("6900");
    expect(p.payment.lightning).toBe("yes");
    expect(p.payment.onchain).toBe("no");
    expect(p.payment.lightningContactless).toBe("no");
    expect(p.cuisine).toBeUndefined();
  });

  it("maps the renamed OSM tags", () => {
    const p = normalize({
      ...place15,
      opening_hours: "Mo-Su 08:00-22:00",
      "osm:addr:state": "TI",
      "osm:addr:country": "CH",
      "osm:cuisine": "pizza;italian",
      "osm:shop": "bakery",
      "osm:craft": "brewery",
    });
    expect(p.openingHours).toBe("Mo-Su 08:00-22:00");
    expect(p.state).toBe("TI");
    expect(p.countryTag).toBe("CH");
    expect(p.cuisine).toBe("pizza;italian");
    expect(p.shop).toBe("bakery");
    expect(p.craft).toBe("brewery");
  });

  it("trims and drops blank strings", () => {
    const p = normalize({ ...place15, name: "  X  ", address: "   " });
    expect(p.name).toBe("X");
    expect(p.address).toBeUndefined();
  });

  it("refuses a record without the fields a Place cannot do without", () => {
    expect(() => normalize({ ...place15, osm_id: "  " })).toThrow(/osm_id/);
    expect(() => normalize({ ...place15, id: undefined })).toThrow(/without an id/);
    expect(() => normalize({ ...place15, lat: "46.0" })).toThrow(/lat/);
    expect(() => normalize({ ...place15, lon: undefined })).toThrow(/lon/);
  });
});

describe("placesUrl", () => {
  it("encodes colons", () => {
    const url = placesUrl(["id", "osm:amenity"]);
    expect(url).toContain("fields=");
    expect(url).toContain("osm%3Aamenity");
    expect(url).not.toContain("osm:");
  });

  it("joins the fields with commas", () => {
    expect(placesUrl(["id", "lat", "osm:shop"])).toBe(
      "https://api.btcmap.org/v4/places?fields=id,lat,osm%3Ashop",
    );
  });
});

describe("fetchPlaces", () => {
  it("writes a dated cache", async () => {
    const seen: string[] = [];
    const result = await fetchPlaces(cfg, {
      fetchImpl: stubFetch(200, [place15, place15, place15], seen),
      today: "2026-10-05",
    });
    const path = join(dir, "cache", "places-2026-10-05.json");
    expect(result).toEqual({ path, count: 3 });
    expect(readCache(path)).toHaveLength(3);
    expect(seen).toEqual([placesUrl(cfg.btcmapFields)]);
    expect(cacheFiles()).toEqual(["places-2026-10-05.json"]);
  });

  it("refuses a non-200", async () => {
    await expect(
      fetchPlaces(cfg, { fetchImpl: stubFetch(503, { error: "down" }), today: "2026-10-05" }),
    ).rejects.toThrow(/HTTP 503/);
    expect(cacheFiles()).toEqual([]);
  });

  it("refuses a non-array body", async () => {
    await expect(
      fetchPlaces(cfg, { fetchImpl: stubFetch(200, { places: [] }), today: "2026-10-05" }),
    ).rejects.toThrow(/array/);
    expect(cacheFiles()).toEqual([]);
  });

  it("refuses an empty array, even with no earlier cache", async () => {
    await expect(
      fetchPlaces(cfg, { fetchImpl: stubFetch(200, []), today: "2026-10-05" }),
    ).rejects.toThrow(/BTC Map returned no places; refusing to write the cache/);
    expect(cacheFiles()).toEqual([]);
  });

  it("refuses an empty array when there is an earlier cache", async () => {
    seedCache("2026-10-04", rawPlaces(1));
    await expect(
      fetchPlaces(cfg, { fetchImpl: stubFetch(200, []), today: "2026-10-05" }),
    ).rejects.toThrow(/no places/);
    expect(cacheFiles()).toEqual(["places-2026-10-04.json"]);
  });

  it("gives up after timeoutMs when BTC Map never answers, and writes nothing", async () => {
    let signal: AbortSignal | undefined;
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(signal!.reason));
      })) as typeof fetch;
    const started = Date.now();

    await expect(
      fetchPlaces(cfg, { fetchImpl: hanging, today: "2026-10-05", timeoutMs: 50 }),
    ).rejects.toThrow("BTC Map did not answer within 0.05 s; nothing was written");

    expect(signal).toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cacheFiles()).toEqual([]);
  });

  it("gives up when the body stalls past timeoutMs", async () => {
    const stalling = ((_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("[1,"));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;

    await expect(
      fetchPlaces(cfg, { fetchImpl: stalling, today: "2026-10-05", timeoutMs: 50 }),
    ).rejects.toThrow("BTC Map did not answer within 0.05 s; nothing was written");
    expect(cacheFiles()).toEqual([]);
  });

  it("allows 120 s by default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await fetchPlaces(cfg, { fetchImpl: stubFetch(200, rawPlaces(1)), today: "2026-10-05" });
      expect(timeout).toHaveBeenCalledWith(120_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("refuses a shrunken fetch", async () => {
    const old = seedCache("2026-10-04", rawPlaces(1000));
    const before = readFileSync(old, "utf8");
    await expect(
      fetchPlaces(cfg, { fetchImpl: stubFetch(200, rawPlaces(400)), today: "2026-10-05" }),
    ).rejects.toThrow(/fewer than half/);
    expect(readFileSync(old, "utf8")).toBe(before);
    expect(cacheFiles()).toEqual(["places-2026-10-04.json"]);
  });

  it("accepts a fetch of exactly half the previous count", async () => {
    seedCache("2026-10-04", rawPlaces(1000));
    const result = await fetchPlaces(cfg, {
      fetchImpl: stubFetch(200, rawPlaces(500)),
      today: "2026-10-05",
    });
    expect(result.count).toBe(500);
    expect(cacheFiles()).toEqual(["places-2026-10-04.json", "places-2026-10-05.json"]);
  });

  it("leaves no temp file behind", async () => {
    await fetchPlaces(cfg, { fetchImpl: stubFetch(200, rawPlaces(2)), today: "2026-10-05" });
    expect(cacheFiles().some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("latestCachePath", () => {
  it("is null when there is no cache", () => {
    expect(latestCachePath(cfg)).toBeNull();
    mkdirSync(cacheDir(), { recursive: true });
    expect(latestCachePath(cfg)).toBeNull();
  });

  it("picks the newest dated cache and ignores other files", () => {
    seedCache("2026-09-30", rawPlaces(1));
    const newest = seedCache("2026-10-05", rawPlaces(1));
    seedCache("2026-10-01", rawPlaces(1));
    writeFileSync(join(cacheDir(), "places-2026-12-31.json.tmp"), "[]");
    writeFileSync(join(cacheDir(), "notes.json"), "[]");
    expect(latestCachePath(cfg)).toBe(newest);
  });
});

describe("readCache", () => {
  it("rejects a file that is not an array", () => {
    mkdirSync(cacheDir(), { recursive: true });
    const path = join(cacheDir(), "places-2026-10-05.json");
    writeFileSync(path, "{}");
    expect(() => readCache(path)).toThrow(/array/);
  });
});
