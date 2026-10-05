import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCatalog } from "../src/catalog.js";
import type { RelayVerifyResult } from "../src/commands/verify.js";
import { loadConfig, type Config } from "../src/config.js";
import { startConsole, type ConsoleDeps, type ConsoleServer } from "../src/console/server.js";
import { contentHash, diffItems } from "../src/diff.js";
import { tagValue, type Tags } from "../src/item.js";
import { latestCachePath, readCache, type RawPlace } from "../src/source/btcmap.js";
import { openState, type State } from "../src/state.js";

const NO_RELAY = "ws://127.0.0.1:9";
const DCOSL = "wss://dcosl.brainstorm.world";
const SEARCH = "wss://search.brainstorm.world";

const TACO: RawPlace = {
  id: 101,
  osm_id: "node:101",
  name: "Taco Spot",
  lat: 30.2672,
  lon: -97.7431,
  "osm:amenity": "restaurant",
  "osm:cuisine": "Mexican",
  "osm:addr:city": "Austin",
};
const HOP: RawPlace = {
  id: 102,
  osm_id: "way:102",
  name: "Hop Works",
  lat: 45.5152,
  lon: -122.6784,
  "osm:craft": "brewery",
  "osm:addr:city": "Portland",
};
const BEAN: RawPlace = {
  id: 103,
  osm_id: "node:103",
  name: "Bean There",
  lat: 40.7128,
  lon: -74.006,
  "osm:amenity": "cafe",
  "osm:addr:city": "New York",
};
const SEED: RawPlace[] = [TACO, HOP, BEAN];

/** `count` cafes with ids from `first`, spread along one meridian. */
function cafes(count: number, first = 1000): RawPlace[] {
  return Array.from({ length: count }, (_, i) => ({
    id: first + i,
    osm_id: `node:${first + i}`,
    name: `Cafe ${first + i}`,
    lat: 30 + i / 1000,
    lon: -97,
    "osm:amenity": "cafe",
  }));
}

let dir: string;
let cfg: Config;
let state: State;
let server: ConsoleServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mise-console-"));
  cfg = {
    ...loadConfig("config.json"),
    // Loopback only: a test that reached the default verify must fail here, not read a public relay.
    relays: { dcosl: NO_RELAY, search: NO_RELAY },
    paths: { data: join(dir, "data"), out: join(dir, "out"), state: ":memory:" },
  };
  state = openState(":memory:");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeCache(records: unknown[], date = "2026-10-05"): void {
  const cacheDir = join(cfg.paths.data, "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `places-${date}.json`), JSON.stringify(records));
}

/** Builds `places` the way build does and records each item as live, as publish would. */
function seedLive(places: RawPlace[], into: State = state): Map<string, Tags> {
  const { items } = buildCatalog(places, cfg);
  for (const [d, tags] of items) {
    into.markLive(d, contentHash(tags), JSON.stringify(tags), `ev-${d}`, 1000);
  }
  return items;
}

async function start(deps?: ConsoleDeps): Promise<ConsoleServer> {
  server = await startConsole(cfg, state, 0, deps);
  return server;
}

async function api<T = unknown>(path: string): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${server!.url}${path}`);
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

/** A request with the path exactly as written: fetch would resolve `..` before sending it. */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  const { port } = server!.address;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

interface ItemRow {
  d: string;
  eventId: string;
  fields: Record<string, string>;
  t: string[];
}
interface ItemsBody {
  total: number;
  items: ItemRow[];
}
interface ExampleRow {
  d: string;
  name?: string;
  category?: string;
  locality?: string;
  changedFields?: string[];
}
interface DiffBody {
  cache: string;
  created: number;
  changed: number;
  unchanged: number;
  gone: number;
  examples: { created: ExampleRow[]; changed: ExampleRow[]; gone: ExampleRow[] };
}

const names = (body: ItemsBody) => body.items.map((i) => i.fields.name);

describe("GET /api/overview", () => {
  it("counts live and deleted items and field coverage", async () => {
    seedLive([...SEED, { id: 104, osm_id: "node:104", name: "Closed Cafe", lat: 1, lon: 2, "osm:amenity": "cafe" }]);
    state.markDeleted("osm-node-104", 2000);
    await start();

    const { status, body } = await api<{
      live: number;
      deleted: number;
      coverage: Record<string, number>;
      lastRun: unknown;
    }>("/api/overview");

    expect(status).toBe(200);
    expect(body.live).toBe(3);
    expect(body.deleted).toBe(1);
    expect(body.coverage.name).toBe(100);
    expect(body.coverage.category).toBe(100);
    expect(body.coverage.cuisine).toBeCloseTo(100 / 3, 5);
    expect(body.coverage.locality).toBe(100);
    expect(body.coverage.website).toBeUndefined();
    expect(body.lastRun).toBeNull();
  });

  it("reports an empty list without dividing by zero", async () => {
    await start();
    const { body } = await api<{ live: number; deleted: number; coverage: unknown; lastRun: unknown }>("/api/overview");
    expect(body).toEqual({ live: 0, deleted: 0, coverage: {}, lastRun: null });
  });

  it("lastRun is the latest run id with its per-relay counts", async () => {
    const rec = (eventId: string, runId: string, relay: string, ok: boolean) =>
      state.recordResult({ eventId, d: "osm-node-1", kind: 39999, createdAt: 1000, runId, relay, ok, message: "" });
    rec("e1", "20261001T000000Z", DCOSL, true);
    rec("e2", "20261005T120000Z", DCOSL, true);
    rec("e3", "20261005T120000Z", DCOSL, false);
    rec("e2", "20261005T120000Z", SEARCH, true);
    await start();

    const { body } = await api<{ lastRun: unknown }>("/api/overview");

    expect(body.lastRun).toEqual({
      runId: "20261005T120000Z",
      relays: [
        { relay: DCOSL, ok: 1, failed: 1 },
        { relay: SEARCH, ok: 1, failed: 0 },
      ],
    });
  });
});

describe("GET /api/items", () => {
  it("returns d, event id, fields (first value, without d z g t alt) and t values", async () => {
    seedLive(SEED);
    await start();

    const { body } = await api<ItemsBody>("/api/items?q=taco");

    expect(body.total).toBe(1);
    const [taco] = body.items;
    expect(taco).toMatchObject({ d: "osm-node-101", eventId: "ev-osm-node-101" });
    expect(taco!.fields).toMatchObject({
      name: "Taco Spot",
      category: "restaurant",
      locality: "Austin",
      cuisine: "mexican",
      lat: "30.2672",
      source: "btcmap",
    });
    for (const skipped of ["d", "z", "g", "t", "alt"]) expect(taco!.fields).not.toHaveProperty(skipped);
    expect(taco!.t).toEqual(["restaurant", "mexican", "austin"]);
  });

  it("takes the first value of a tag that appears twice", async () => {
    const tags: Tags = [
      ["d", "osm-node-9"],
      ["z", cfg.headerCoordinate],
      ["name", "Dup"],
      ["cuisine", "thai"],
      ["cuisine", "lao"],
      ["t", "thai"],
      ["t", "lao"],
    ];
    state.markLive("osm-node-9", contentHash(tags), JSON.stringify(tags), "ev-9", 1000);
    await start();

    const { body } = await api<ItemsBody>("/api/items");

    expect(body.items[0]!.fields.cuisine).toBe("thai");
    expect(body.items[0]!.t).toEqual(["thai", "lao"]);
  });

  it("filters by category and by q, a case-insensitive name substring", async () => {
    seedLive(SEED);
    await start();

    expect(names((await api<ItemsBody>("/api/items?category=cafe")).body)).toEqual(["Bean There"]);
    expect(names((await api<ItemsBody>("/api/items?category=CAFE")).body)).toEqual(["Bean There"]);
    expect(names((await api<ItemsBody>("/api/items?q=TACO")).body)).toEqual(["Taco Spot"]);
    expect(names((await api<ItemsBody>("/api/items?q=ac")).body)).toEqual(["Taco Spot"]);
    expect(names((await api<ItemsBody>("/api/items?q=o")).body)).toEqual(["Taco Spot", "Hop Works"]);
    expect(names((await api<ItemsBody>("/api/items?q=o&category=restaurant")).body)).toEqual(["Taco Spot"]);
    expect(names((await api<ItemsBody>("/api/items?q=o&category=cafe")).body)).toEqual([]);
  });

  it("matches q on the name only", async () => {
    seedLive(SEED);
    await start();
    // "austin" is in Taco Spot's locality and t values, not its name.
    expect((await api<ItemsBody>("/api/items?q=austin")).body.total).toBe(0);
  });

  it("filters by country, locality and cuisine as exact, case-insensitive matches", async () => {
    seedLive(SEED);
    await start();

    expect((await api<ItemsBody>("/api/items?country=us")).body.total).toBe(3);
    expect((await api<ItemsBody>("/api/items?country=u")).body.total).toBe(0);
    expect(names((await api<ItemsBody>("/api/items?locality=austin")).body)).toEqual(["Taco Spot"]);
    expect((await api<ItemsBody>("/api/items?locality=aust")).body.total).toBe(0);
    expect(names((await api<ItemsBody>("/api/items?cuisine=MEXICAN")).body)).toEqual(["Taco Spot"]);
    expect(await api<ItemsBody>("/api/items?category=nope").then((r) => r.body)).toEqual({ total: 0, items: [] });
  });

  it("ignores blank filters", async () => {
    seedLive(SEED);
    await start();
    expect((await api<ItemsBody>("/api/items?q=&category=&country=%20")).body.total).toBe(3);
  });

  it("pages by offset and limit and reports the total before paging", async () => {
    seedLive(cafes(30));
    await start();
    const all = [...state.liveItems().keys()];

    const page = (await api<ItemsBody>("/api/items?limit=10&offset=20")).body;
    expect(page.total).toBe(30);
    expect(page.items.map((i) => i.d)).toEqual(all.slice(20, 30));

    const tail = (await api<ItemsBody>("/api/items?limit=10&offset=25")).body;
    expect(tail.total).toBe(30);
    expect(tail.items.map((i) => i.d)).toEqual(all.slice(25));

    const past = (await api<ItemsBody>("/api/items?offset=100")).body;
    expect(past).toEqual({ total: 30, items: [] });
  });

  it("limits to 100 by default and to 500 at most", async () => {
    seedLive(cafes(520));
    await start();

    const byDefault = (await api<ItemsBody>("/api/items")).body;
    expect(byDefault.total).toBe(520);
    expect(byDefault.items).toHaveLength(100);

    const capped = (await api<ItemsBody>("/api/items?limit=1000")).body;
    expect(capped.total).toBe(520);
    expect(capped.items).toHaveLength(500);
  });

  it("refuses a limit or offset that is not a whole number, and a limit below 1", async () => {
    await start();
    for (const query of ["limit=abc", "limit=0", "limit=-5", "limit=2.5", "offset=-1", "offset=x"]) {
      const { status, body } = await api<{ error: string }>(`/api/items?${query}`);
      expect(status, query).toBe(400);
      expect(body.error, query).toMatch(/limit|offset/);
    }
  });

  it("lists an item whose stored tags cannot be read, with no fields, and leaves it off the map", async () => {
    seedLive(SEED);
    state.markLive("osm-node-bad", "h", "not json", "ev-bad", 1000);
    await start();

    const items = (await api<ItemsBody>("/api/items?limit=500")).body;
    expect(items.total).toBe(4);
    expect(items.items.find((i) => i.d === "osm-node-bad")).toEqual({
      d: "osm-node-bad",
      eventId: "ev-bad",
      fields: {},
      t: [],
    });
    expect((await api<unknown[]>("/api/points")).body).toHaveLength(3);
  });
});

describe("GET /api/points", () => {
  it("has one row per live item: d, lat, lon, name, category", async () => {
    seedLive(SEED);
    await start();

    const { status, body } = await api<unknown[][]>("/api/points");

    expect(status).toBe(200);
    expect(body).toHaveLength(state.liveItems().size);
    expect(body).toEqual([
      ["osm-node-101", 30.2672, -97.7431, "Taco Spot", "restaurant"],
      ["osm-node-103", 40.7128, -74.006, "Bean There", "cafe"],
      ["osm-way-102", 45.5152, -122.6784, "Hop Works", "brewery"],
    ]);
  });

  it("does not list a deleted item", async () => {
    seedLive(SEED);
    state.markDeleted("osm-way-102", 2000);
    await start();
    expect((await api<unknown[][]>("/api/points")).body.map((r) => r[0])).toEqual(["osm-node-101", "osm-node-103"]);
  });
});

describe("GET /api/item/:d", () => {
  it("returns the tags, every version id and the latest event id", async () => {
    seedLive(SEED);
    const rec = (eventId: string, createdAt: number) =>
      state.recordResult({
        eventId,
        d: "osm-node-101",
        kind: 39999,
        createdAt,
        runId: "run-1",
        relay: DCOSL,
        ok: true,
        message: "",
      });
    rec("old-version", 500);
    rec("ev-osm-node-101", 1000);
    await start();

    const { status, body } = await api<{ d: string; tags: Tags; versions: string[]; latestEventId: string }>(
      "/api/item/osm-node-101",
    );

    expect(status).toBe(200);
    expect(body.d).toBe("osm-node-101");
    expect(body.latestEventId).toBe("ev-osm-node-101");
    expect(body.versions).toEqual(["old-version", "ev-osm-node-101"]);
    expect(tagValue(body.tags, "name")).toBe("Taco Spot");
    expect(body.tags.filter((t) => t[0] === "z")).toEqual([["z", cfg.headerCoordinate]]);
    expect(body.tags).toEqual(JSON.parse(state.liveItems().get("osm-node-101")!.tagsJson));
  });

  it("is 404 for an unknown d and for a deleted one", async () => {
    seedLive(SEED);
    state.markDeleted("osm-way-102", 2000);
    await start();

    for (const d of ["osm-node-404", "osm-way-102", "", "x/y"]) {
      const res = await api<{ error: string }>(`/api/item/${d}`);
      expect(res.status, d).toBe(404);
      expect(typeof res.body.error).toBe("string");
    }
  });
});

describe("GET /api/diff", () => {
  const NOODLE: RawPlace = { id: 201, osm_id: "node:201", name: "Noodle Bar", lat: 35, lon: -80, "osm:amenity": "cafe" };
  const PLACE_105: RawPlace = { id: 105, osm_id: "node:105", name: "Held Diner", lat: 36, lon: -81, "osm:amenity": "restaurant" };

  it("matches diffItems over the latest cache, with held items never gone", async () => {
    seedLive([...SEED, PLACE_105]);
    writeCache([
      { ...TACO, name: "Taco Spot Two" }, // changed
      BEAN, // unchanged
      NOODLE, // created
      { id: 300, osm_id: "node:300", name: "Big Mart", lat: 41, lon: -87, "osm:shop": "supermarket" }, // out of scope
      { id: 105, osm_id: "node:105", name: "Held Diner" }, // malformed (no lat/lon) but still names its place: held
      // HOP is absent: gone
    ]);
    await start();

    const { status, body } = await api<DiffBody>("/api/diff");

    const catalog = buildCatalog(readCache(latestCachePath(cfg)!), cfg);
    const expected = diffItems(catalog.items, state.liveItems(), { detectGone: true, held: catalog.held });
    expect(catalog.held).toEqual(new Set(["osm-node-105"]));
    expect(status).toBe(200);
    expect(body.cache).toBe("places-2026-10-05.json");
    expect([body.created, body.changed, body.unchanged, body.gone]).toEqual([
      expected.created.length,
      expected.changed.length,
      expected.unchanged,
      expected.gone.length,
    ]);
    expect([body.created, body.changed, body.unchanged, body.gone]).toEqual([1, 1, 1, 1]);
    expect(body.examples.created.map((e) => e.d)).toEqual(["osm-node-201"]);
    expect(body.examples.created[0]).toMatchObject({ name: "Noodle Bar", category: "cafe" });
    expect(body.examples.changed.map((e) => e.d)).toEqual(["osm-node-101"]);
    expect(body.examples.changed[0]!.changedFields).toEqual(["alt", "name"]);
    expect(body.examples.gone).toEqual([{ d: "osm-way-102", name: "Hop Works", category: "brewery", locality: "Portland" }]);
  });

  it("uses the newest cache file", async () => {
    seedLive(SEED);
    writeCache([TACO], "2026-09-01");
    writeCache(SEED, "2026-10-05");
    await start();

    const { body } = await api<DiffBody>("/api/diff");

    expect(body.cache).toBe("places-2026-10-05.json");
    expect([body.created, body.changed, body.unchanged, body.gone]).toEqual([0, 0, 3, 0]);
  });

  it("gives at most 50 examples per class and still counts them all", async () => {
    seedLive(SEED);
    writeCache([...SEED, ...cafes(60)]);
    await start();

    const { body } = await api<DiffBody>("/api/diff");

    expect(body.created).toBe(60);
    expect(body.examples.created).toHaveLength(50);
    expect(body.examples.created.map((e) => e.d)).toEqual(
      [...cafes(60).map((p) => `osm-${String(p.osm_id).replace(":", "-")}`)].sort().slice(0, 50),
    );
  });

  it("is 409 with a hint when there is no cache yet", async () => {
    seedLive(SEED);
    await start();

    const { status, body } = await api<{ error: string }>("/api/diff");

    expect(status).toBe(409);
    expect(body.error).toMatch(/npm run fetch/);
  });

  it("is 500 with the reason when the cache cannot be read", async () => {
    const cacheDir = join(cfg.paths.data, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "places-2026-10-05.json"), "not json");
    await start();

    const { status, body } = await api<{ error: string }>("/api/diff");

    expect(status).toBe(500);
    expect(body.error).toEqual(expect.any(String));
  });
});

describe("GET /api/runs", () => {
  it("is state.runs()", async () => {
    const rec = (eventId: string, runId: string, relay: string, ok: boolean) =>
      state.recordResult({ eventId, d: "osm-node-1", kind: 39999, createdAt: 1000, runId, relay, ok, message: "" });
    rec("e1", "run-1", DCOSL, true);
    rec("e2", "run-1", DCOSL, false);
    rec("e1", "run-1", SEARCH, true);
    await start();

    const { body } = await api<unknown[]>("/api/runs");

    expect(body).toEqual(state.runs());
    expect(body).toHaveLength(2);
    expect((await api<unknown[]>("/api/runs")).status).toBe(200);
  });

  it("is an empty list before any publish", async () => {
    await start();
    expect((await api("/api/runs")).body).toEqual([]);
  });
});

describe("GET /api/relays", () => {
  const clean: RelayVerifyResult = { onRelay: 3, inState: 3, missing: [], extra: [], stale: [], extraCheck: "complete" };

  it("calls the injected verify on request, not at startup, and returns its results", async () => {
    seedLive(SEED);
    const calls: [Config, State][] = [];
    const results = { dcosl: clean, search: { ...clean, onRelay: 2, missing: ["osm-node-101"] } };
    await start({
      verify: async (c, s) => {
        calls.push([c, s]);
        return results;
      },
    });
    expect(calls).toHaveLength(0);

    await api("/api/overview");
    await api("/api/items");
    expect(calls).toHaveLength(0);

    const { status, body } = await api("/api/relays");

    expect(status).toBe(200);
    expect(body).toEqual(results);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(cfg);
    expect(calls[0]![1]).toBe(state);
  });

  it("runs one verify for requests that overlap, and a new one after it finishes", async () => {
    let calls = 0;
    await start({
      verify: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { dcosl: clean };
      },
    });

    const [a, b] = await Promise.all([api("/api/relays"), api("/api/relays")]);
    expect(a.body).toEqual({ dcosl: clean });
    expect(b.body).toEqual({ dcosl: clean });
    expect(calls).toBe(1);

    await api("/api/relays");
    expect(calls).toBe(2);
  });

  it("is 500 with the reason when verify throws", async () => {
    await start({
      verify: async () => {
        throw new Error("boom");
      },
    });
    const { status, body } = await api<{ error: string }>("/api/relays");
    expect(status).toBe(500);
    expect(body.error).toBe("boom");
    // The failure is not cached: the next request tries again.
    expect((await api("/api/relays")).status).toBe(500);
  });

  it("uses the real verify by default, which reports a relay it cannot reach per relay", async () => {
    seedLive(SEED);
    await start();

    const { status, body } = await api<Record<string, RelayVerifyResult>>("/api/relays");

    expect(status).toBe(200);
    expect(Object.keys(body)).toEqual(["dcosl", "search"]);
    expect(body.dcosl!.inState).toBe(3);
    expect(body.dcosl!.error).toEqual(expect.any(String));
  });
});

describe("the server", () => {
  it("binds 127.0.0.1 only", async () => {
    const s = await start();

    expect(s.address.address).toBe("127.0.0.1");
    expect(s.url).toBe(`http://127.0.0.1:${s.address.port}`);
    expect(s.address.port).toBeGreaterThan(0);

    // Not reachable by any other address of this machine either.
    const other = Object.values(networkInterfaces())
      .flat()
      .find((i) => i !== undefined && !i.internal && i.family === "IPv4");
    if (other !== undefined) {
      const outcome = await new Promise<string>((resolve) => {
        const socket = createConnection({ host: other.address, port: s.address.port, timeout: 2000 });
        socket.on("connect", () => {
          socket.destroy();
          resolve("connected");
        });
        socket.on("timeout", () => {
          socket.destroy();
          resolve("timeout");
        });
        socket.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
      });
      expect(outcome).toBe("ECONNREFUSED");
    }
  });

  it("no route writes state: every method but GET is 405", async () => {
    seedLive(SEED);
    let verifyCalls = 0;
    await start({
      verify: async () => {
        verifyCalls++;
        return {};
      },
    });
    const snapshot = () =>
      JSON.stringify([[...state.liveItems()], state.counts(), state.runs(), state.versionsOf("osm-node-101")]);
    const before = snapshot();

    for (const path of ["/", "/api/overview", "/api/relays", "/api/item/osm-node-101", "/api/diff", "/nowhere"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        const res = await fetch(`${server!.url}${path}`, {
          method,
          ...(method === "POST" || method === "PUT" || method === "PATCH" ? { body: "x=1" } : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get("allow"), `${method} ${path}`).toBe("GET");
      }
    }

    expect(snapshot()).toBe(before);
    expect(verifyCalls).toBe(0);
  });

  it("is 404 for an unknown route, and for a known one with extra path", async () => {
    await start();

    for (const path of ["/nope", "/api/nope", "/api", "/api/overview/extra", "/api/item", "/favicon.ico", "/package.json"]) {
      expect((await rawGet(path)).status, path).toBe(404);
    }
    expect(JSON.parse((await rawGet("/api/nope")).body)).toEqual({ error: "not found" });
  });

  it("rejects path traversal, plain and encoded", async () => {
    await start();
    const packageJson = readFileSync("package.json", "utf8");

    const refused = [
      "/../package.json",
      "/%2e%2e/package.json",
      "/%2E%2E/package.json",
      "/..%2fpackage.json",
      "/..%2Fpackage.json",
      "/%2e%2e%2fpackage.json",
      "/..%5cpackage.json",
      "/static/../../package.json",
      "/api/item/..%2f..%2fpackage.json",
      "/api/item/a%2Fb",
      "/./index.html",
      "/%00index.html",
      "/%E0%A4%A",
    ];
    for (const path of refused) {
      const res = await rawGet(path);
      expect(res.status, path).toBe(400);
      expect(res.body, path).not.toContain('"name": "mise-en-place"');
    }
    // Decoded once only: this names a file called "%2e%2e", which is not there.
    const doubled = await rawGet("/%252e%252e/package.json");
    expect(doubled.status).toBe(404);
    expect(doubled.body).not.toBe(packageJson);
  });

  it("close() stops it listening, and calling it again is harmless", async () => {
    const s = await start();
    const url = s.url;
    expect((await fetch(`${url}/api/runs`)).status).toBe(200);

    await s.close();
    await s.close();

    await expect(fetch(`${url}/api/runs`)).rejects.toThrow();
  });

  it("says a port in use is in use", async () => {
    const first = await start();
    await expect(startConsole(cfg, state, first.address.port)).rejects.toThrow(
      new RegExp(`port ${first.address.port} is already in use`),
    );
  });

  it("sends a content type for each file and nosniff on everything", async () => {
    await start();

    for (const [path, type] of [
      ["/", "text/html; charset=utf-8"],
      ["/index.html", "text/html; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/style.css", "text/css; charset=utf-8"],
      ["/api/runs", "application/json; charset=utf-8"],
    ] as const) {
      const res = await fetch(`${server!.url}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      await res.arrayBuffer();
    }
  });

  it("serves the files in src/console/public as they are on disk", async () => {
    await start();
    for (const [path, file] of [
      ["/", "index.html"],
      ["/app.js", "app.js"],
      ["/style.css", "style.css"],
    ] as const) {
      const res = await fetch(`${server!.url}${path}`);
      expect(await res.text(), path).toBe(readFileSync(join("src/console/public", file), "utf8"));
    }
  });
});

describe("the page", () => {
  const html = readFileSync("src/console/public/index.html", "utf8");
  const js = readFileSync("src/console/public/app.js", "utf8");
  const css = readFileSync("src/console/public/style.css", "utf8");

  it("is titled Mise en Place console and has the five sections", () => {
    expect(html).toContain("<title>Mise en Place console</title>");
    for (const [id, heading] of [
      ["overview", "Overview"],
      ["table", "Table"],
      ["map", "Map"],
      ["diff", "Diff"],
      ["runs", "Runs"],
    ]) {
      expect(html, id).toMatch(new RegExp(`<section[^>]*id="${id}"`));
      expect(html, id).toMatch(new RegExp(`<h2[^>]*>${heading}</h2>`));
    }
  });

  it("carries the ODbL attribution in the footer", () => {
    expect(html).toMatch(/<footer[\s\S]*Data © OpenStreetMap contributors, ODbL 1\.0\. Seeded from BTC Map\.[\s\S]*<\/footer>/);
  });

  it("loads Leaflet 1.9.4 and Leaflet.markercluster 1.5.3 from unpkg", () => {
    for (const url of [
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
      "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
      "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css",
      "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
    ]) {
      expect(html).toContain(url);
    }
    expect(html.indexOf("leaflet@1.9.4/dist/leaflet.js")).toBeLessThan(html.indexOf("leaflet.markercluster.js"));
    expect(html.indexOf("leaflet.markercluster.js")).toBeLessThan(html.indexOf("app.js"));
  });

  it("uses OSM tiles with the linked attribution, and never inserts data as HTML", () => {
    expect(js).toContain("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(js).toContain("© OpenStreetMap contributors");
    expect(js).toContain("https://www.openstreetmap.org/copyright");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("breaks only code (the d and id columns) mid-word; other cells wrap at spaces and the table scrolls", () => {
    /** The declarations of the first rule whose selector list is exactly `selector`. */
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/,\s*/g, ",\\s*");
      return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*{([^}]*)}`))?.[1];
    };
    const cells = rule("th, td");
    expect(cells).toBeDefined();
    expect(cells).not.toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-(all|word)/);
    expect(cells).toMatch(/overflow-wrap:\s*normal/);
    expect(rule("td code")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".scroll")).toMatch(/overflow-x:\s*auto/);
    expect(html).toMatch(/<div class="scroll">\s*<table id="items-table">/);
    expect(js).toMatch(/td\(detailLink\(item\.d, h\("code", null, item\.d\)\)\)/);
  });

  it("styles with custom properties, for light and dark, and has a narrow-screen rule", () => {
    expect(css).toMatch(/:root\s*{[^}]*--bg:/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{[^}]*--bg:/);
    expect(css).toMatch(/@media \(max-width: \d+px\)/);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });
});

describe("npm run console", () => {
  /** A config file in `dir` with its state at `<dir>/state.sqlite`, loopback relays, and no real key. */
  function writeConfig(): string {
    const base = JSON.parse(readFileSync("config.json", "utf8")) as Record<string, unknown>;
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ...base,
        relays: { dcosl: NO_RELAY, search: NO_RELAY },
        paths: { data: join(dir, "data"), out: join(dir, "out"), state: join(dir, "state.sqlite") },
      }),
    );
    return configPath;
  }

  const env = (configPath: string) => ({ ...process.env, MISE_CONFIG: configPath, MISE_KEY_FILE: join(dir, "absent.key") });

  it("starts on the given port, prints the url, serves the state and stops on Ctrl-C", async () => {
    const configPath = writeConfig();
    const fileState = openState(join(dir, "state.sqlite"));
    seedLive(SEED, fileState);
    fileState.close();

    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "console", "--port", "0"], {
      env: env(configPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no url printed; stdout: ${out}; stderr: ${err}`)), 15000);
        child.stdout.on("data", (c: Buffer) => {
          out += c.toString();
          const m = /http:\/\/127\.0\.0\.1:\d+/.exec(out);
          if (m !== null) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        });
        child.on("exit", () => reject(new Error(`exited early; stdout: ${out}; stderr: ${err}`)));
      });

      const overview = (await (await fetch(`${url}/api/overview`)).json()) as { live: number };
      expect(overview.live).toBe(3);

      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      child.kill("SIGINT");
      expect(await exited).toBe(0);
      expect(err).toBe("");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30000);

  it("takes no arguments and no option but --port", () => {
    const configPath = writeConfig();
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "console", ...args], {
        encoding: "utf8",
        env: env(configPath),
      });

    const extra = run("somewhere");
    expect(extra.status).not.toBe(0);
    expect(extra.stderr).toMatch(/console takes no arguments, got somewhere/);

    const option = run("--pilot");
    expect(option.status).not.toBe(0);
    expect(option.stderr).toMatch(/console does not take --pilot/);
  }, 30000);
});
