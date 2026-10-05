import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, type BuildOptions } from "../src/commands/build.js";
import { census } from "../src/commands/census.js";
import { headerAuthor, loadConfig, type Config } from "../src/config.js";
import type { Unsigned } from "../src/deletion.js";
import { contentHash } from "../src/diff.js";
import { checkHeader, fetchHeader } from "../src/header.js";
import type { Tags } from "../src/item.js";
import type { RawPlace } from "../src/source/btcmap.js";
import { openState, type State } from "../src/state.js";

const place15 = JSON.parse(readFileSync("tests/fixtures/place-15.json", "utf8")) as RawPlace;
const PLACE15_OSM = "node:10011069455";
const PLACE15_D = "osm-node-10011069455";

/** Six raw places: 3 in scope in the US, place 15, a supermarket, and place 15's duplicate. */
const FIXTURE: RawPlace[] = [
  { id: 101, osm_id: "node:101", name: "Taco Spot", lat: 30.2672, lon: -97.7431, "osm:amenity": "restaurant" },
  { id: 102, osm_id: "way:102", name: "Hop Works", lat: 45.5152, lon: -122.6784, "osm:craft": "brewery" },
  // Same osm_id as place 15, higher id, and listed first, so "first wins" would keep the wrong one.
  { ...place15, id: 1500, name: "Gabbani Duplicate" },
  { id: 103, osm_id: "node:103", name: "Bean There", lat: 40.7128, lon: -74.006, "osm:amenity": "cafe" },
  place15,
  { id: 104, osm_id: "node:104", name: "Big Mart", lat: 41.8781, lon: -87.6298, "osm:shop": "supermarket" },
];

const NO_RELAY = "ws://127.0.0.1:9";

let dir: string;
let cfg: Config;
let state: State;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mise-build-"));
  const base = loadConfig("config.json");
  cfg = {
    ...base,
    // Loopback only: if a test ever reached the header read without an injected header, it
    // must fail here rather than read a public relay.
    relays: { dcosl: NO_RELAY, search: NO_RELAY },
    paths: { data: join(dir, "data"), out: join(dir, "out"), state: ":memory:" },
  };
  state = openState(":memory:");
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeCache(records: unknown[], date = "2026-10-05"): string {
  const cacheDir = join(cfg.paths.data, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `places-${date}.json`);
  writeFileSync(path, JSON.stringify(records));
  return path;
}

const COORD_D = loadConfig("config.json").headerCoordinate.split(":")[2]!;

/** A header event as the relay would return it; never fetched from a network in tests. */
function header(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: headerAuthor(cfg.headerCoordinate),
    kind: 39998,
    created_at: 1_700_000_000,
    content: "",
    sig: "2".repeat(128),
    tags: [
      ["d", COORD_D],
      ["names", "food and drink place", "food and drink places"],
      ["required", "name"],
      ["required", "category"],
    ],
    ...over,
  };
}

function run(opts: BuildOptions = {}) {
  return build(cfg, state, { header: header(), ...opts });
}

function lines(runDir: string): Unsigned[] {
  return readFileSync(join(runDir, "unsigned.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Unsigned);
}

const tag = (tags: Tags, name: string) => tags.find((t) => t[0] === name)?.[1];

/** Marks every item of a run live in state, as a publish would. */
function publishAll(runDir: string): void {
  for (const ev of lines(runDir)) {
    if (ev.kind !== 39999) continue;
    const d = tag(ev.tags, "d")!;
    state.markLive(d, contentHash(ev.tags), JSON.stringify(ev.tags), `ev-${d}`, 1);
  }
}

/** `n` in-scope US restaurants with distinct OSM ids. */
function restaurants(n: number): RawPlace[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    osm_id: `node:${1000 + i}`,
    name: `Place ${i}`,
    lat: 30 + i * 0.01,
    lon: -97,
    "osm:amenity": "restaurant",
  }));
}

describe("build", () => {
  it("first build writes all in-scope items", async () => {
    writeCache(FIXTURE);
    const result = await run({ runId: "r1" });

    expect(result.runDir).toBe(join(cfg.paths.out, "r1"));
    const events = lines(result.runDir);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.kind === 39999 && e.content === "")).toBe(true);
    expect(result).toMatchObject({ created: 4, changed: 0, unchanged: 0, deletions: 0 });
    expect(result.skipped["out-of-scope"]).toBe(1);
    expect(result.duplicates).toEqual([PLACE15_OSM]);

    const kept = events.find((e) => tag(e.tags, "d") === PLACE15_D)!;
    expect(tag(kept.tags, "btcmap-id")).toBe("15");
    expect(tag(kept.tags, "name")).toBe("Gabbani Enoteca");
    expect(events.filter((e) => tag(e.tags, "d") === PLACE15_D)).toHaveLength(1);

    expect(existsSync(join(result.runDir, "report.md"))).toBe(true);
    expect(existsSync(join(result.runDir, "manifest.json"))).toBe(true);
  });

  it("writes items sorted by d, each line {kind, tags, content}", async () => {
    writeCache(FIXTURE);
    const { runDir } = await run({ runId: "r1" });
    const raw = readFileSync(join(runDir, "unsigned.jsonl"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const events = lines(runDir);
    for (const e of events) expect(Object.keys(e)).toEqual(["kind", "tags", "content"]);
    const ds = events.map((e) => tag(e.tags, "d")!);
    expect(ds).toEqual([...ds].sort());
  });

  it("filter country=US builds only US items and emits no deletions", async () => {
    writeCache(FIXTURE);
    // Live items outside the US: place 15 (still in the cache) and one the cache no longer has.
    state.markLive(PLACE15_D, "old-hash", "[]", "ev-15", 1);
    state.markLive("osm-node-424242", "hash", "[]", "ev-gone", 1);

    const result = await run({ runId: "r1", filter: { country: "US" } });

    const events = lines(result.runDir);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.kind === 39999 && tag(e.tags, "country") === "US")).toBe(true);
    expect(result.deletions).toBe(0);
    expect(result.changed).toBe(0);
  });

  it("matches filter values case-insensitively, and filters by category", async () => {
    writeCache(FIXTURE);
    const us = await run({ runId: "r1", filter: { country: "us" } });
    expect(us.created).toBe(3);

    const cafes = await run({ runId: "r2", filter: { category: "CAFE" } });
    expect(lines(cafes.runDir).map((e) => tag(e.tags, "name"))).toEqual(["Bean There"]);

    const both = await run({ runId: "r3", filter: { country: "US", category: "restaurant" } });
    expect(lines(both.runDir).map((e) => tag(e.tags, "name"))).toEqual(["Taco Spot"]);
  });

  it("refuses a filter key other than country and category", async () => {
    writeCache(FIXTURE);
    await expect(run({ runId: "r1", filter: { locality: "Austin" } })).rejects.toThrow(/locality/);
    expect(existsSync(join(cfg.paths.out, "r1"))).toBe(false);
  });

  it("rebuild against state with the same hashes writes zero events", async () => {
    writeCache(FIXTURE);
    publishAll((await run({ runId: "r1" })).runDir);

    const second = await run({ runId: "r2" });
    expect(lines(second.runDir)).toEqual([]);
    expect(readFileSync(join(second.runDir, "unsigned.jsonl"), "utf8")).toBe("");
    expect(second).toMatchObject({ created: 0, changed: 0, unchanged: 4, deletions: 0 });
  });

  it("a changed place becomes a changed item", async () => {
    writeCache(FIXTURE);
    publishAll((await run({ runId: "r1" })).runDir);
    writeCache(
      FIXTURE.map((p) => (p.id === 103 ? { ...p, name: "Bean There Again" } : p)),
      "2026-10-06",
    );

    const second = await run({ runId: "r2" });
    expect(second).toMatchObject({ created: 0, changed: 1, unchanged: 3, deletions: 0 });
    expect(lines(second.runDir).map((e) => tag(e.tags, "name"))).toEqual(["Bean There Again"]);
  });

  it("holds a live item whose record is still in the fetch but malformed: no deletion", async () => {
    writeCache(FIXTURE);
    publishAll((await run({ runId: "r1" })).runDir);
    writeCache(
      FIXTURE.map((p) => (p.id === 103 ? { ...p, lat: null } : p)),
      "2026-10-06",
    );

    // allowDeletions, so it is the hold and not the guard that keeps the item.
    const result = await run({ runId: "r2", allowDeletions: true });

    expect(result.deletions).toBe(0);
    expect(lines(result.runDir).filter((e) => e.kind === 5)).toEqual([]);
    expect(result.skipped.malformed).toBe(1);
    expect(result.held).toEqual(["osm-node-103"]);
    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(report).toMatch(/## Held[\s\S]*osm-node-103/);
  });

  it("counts a malformed record without a readable osm_id as malformed only", async () => {
    writeCache([
      ...FIXTURE,
      { id: 777, name: "No OSM id", lat: 1, lon: 1, "osm:amenity": "cafe" },
      { id: 778, osm_id: "   ", name: "Blank OSM id", lat: 1, lon: 1, "osm:amenity": "cafe" },
      { id: 779, osm_id: 779, name: "Numeric OSM id", lat: 1, lon: 1, "osm:amenity": "cafe" },
    ]);
    const result = await run({ runId: "r1" });
    expect(result.skipped.malformed).toBe(3);
    expect(result.held).toEqual([]);
  });

  it("lists every deletion in the report with the live item's name", async () => {
    writeCache(FIXTURE);
    const named: Tags = [["d", "osm-node-555"], ["name", "Old Diner"]];
    state.markLive("osm-node-555", contentHash(named), JSON.stringify(named), "v1", 1);
    state.markLive("osm-node-556", "hash", "[]", "v2", 1);

    const result = await run({ runId: "r1", allowDeletions: true });

    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    const section = report.slice(report.indexOf("## Deletions"));
    expect(section).toContain("osm-node-555: Old Diner");
    expect(section).toContain("osm-node-556: (no name recorded)");
  });

  it("a place missing from the cache becomes a kind-5 deletion with all its versions", async () => {
    writeCache(FIXTURE);
    const goneD = "osm-node-555";
    for (const [eventId, createdAt] of [["v1", 100], ["v2", 200]] as const) {
      state.recordResult({
        eventId, d: goneD, kind: 39999, createdAt, runId: "old", relay: "wss://x", ok: true, message: "",
      });
    }
    state.markLive(goneD, "hash", "[]", "v2", 200);

    const result = await run({ runId: "r1", allowDeletions: true });

    const events = lines(result.runDir);
    expect(result.deletions).toBe(1);
    expect(events).toHaveLength(5);
    expect(events.at(-1)).toEqual({
      kind: 5,
      tags: [
        ["e", "v1"],
        ["e", "v2"],
        ["a", `39999:${cfg.curatorPubkey}:${goneD}`],
        ["k", "39999"],
      ],
      content: "",
    });
  });

  it("a deletion names the latest event id even when no version of it was recorded", async () => {
    writeCache(FIXTURE);
    state.recordResult({
      eventId: "v1", d: "osm-node-555", kind: 39999, createdAt: 100, runId: "old", relay: "wss://x",
      ok: true, message: "",
    });
    state.markLive("osm-node-555", "hash", "[]", "v3", 300);
    state.markLive("osm-node-556", "hash", "[]", "only", 300);

    const result = await run({ runId: "r1", allowDeletions: true });

    const deletions = lines(result.runDir).filter((e) => e.kind === 5);
    expect(deletions.map((e) => e.tags.filter((t) => t[0] === "e"))).toEqual([
      [["e", "v1"], ["e", "v3"]],
      [["e", "only"]],
    ]);
  });

  it("writes items first, then deletions, each sorted by d", async () => {
    writeCache(FIXTURE);
    state.markLive("osm-node-9", "h", "[]", "e9", 1);
    state.markLive("osm-node-8", "h", "[]", "e8", 1);
    const result = await run({ runId: "r1", allowDeletions: true });
    const kinds = lines(result.runDir).map((e) => e.kind);
    expect(kinds).toEqual([39999, 39999, 39999, 39999, 5, 5]);
    const deletedA = lines(result.runDir)
      .filter((e) => e.kind === 5)
      .map((e) => tag(e.tags, "a"));
    expect(deletedA).toEqual([
      `39999:${cfg.curatorPubkey}:osm-node-8`,
      `39999:${cfg.curatorPubkey}:osm-node-9`,
    ]);
  });

  it("deletions over the guard abort", async () => {
    const all = restaurants(100);
    writeCache(all);
    publishAll((await run({ runId: "r1" })).runDir);
    expect(state.liveItems().size).toBe(100);

    writeCache(all.slice(3), "2026-10-06");
    await expect(run({ runId: "r2" })).rejects.toThrow(/allow-deletions/);
    expect(existsSync(join(cfg.paths.out, "r2"))).toBe(false);

    const allowed = await run({ runId: "r3", allowDeletions: true });
    expect(allowed.deletions).toBe(3);
    expect(lines(allowed.runDir).filter((e) => e.kind === 5)).toHaveLength(3);
  });

  it("allows deletions up to the guard without the flag", async () => {
    const all = restaurants(100);
    writeCache(all);
    publishAll((await run({ runId: "r1" })).runDir);

    writeCache(all.slice(2), "2026-10-06");
    const result = await run({ runId: "r2" });
    expect(result.deletions).toBe(2);
  });

  it("a pilot build selects n items and emits no deletions", async () => {
    writeCache(FIXTURE);
    state.markLive("osm-node-424242", "hash", "[]", "ev-gone", 1);

    const result = await run({ runId: "r1", pilot: 2 });
    const events = lines(result.runDir);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === 39999)).toBe(true);
    expect(result.deletions).toBe(0);
  });

  it("refuses a pilot size that is not a positive integer", async () => {
    writeCache(FIXTURE);
    await expect(run({ runId: "r1", pilot: 0 })).rejects.toThrow(/pilot/);
    await expect(run({ runId: "r2", pilot: 1.5 })).rejects.toThrow(/pilot/);
    await expect(run({ runId: "r3", pilot: Number.NaN })).rejects.toThrow(/pilot/);
  });

  it("refuses a deletionGuardFraction that is not a finite number from 0 to 1", async () => {
    writeCache(FIXTURE);
    for (const bad of [Number.NaN, undefined, -0.1, 2, "0.02"]) {
      cfg = { ...cfg, deletionGuardFraction: bad as number };
      await expect(run({ runId: "r1" })).rejects.toThrow(/deletionGuardFraction/);
    }
    expect(existsSync(cfg.paths.out)).toBe(false);
  });

  it("skips a malformed record instead of aborting the run", async () => {
    writeCache([
      ...FIXTURE,
      { id: 777, name: "No OSM id", lat: 1, lon: 1, "osm:amenity": "cafe" },
      { osm_id: "node:778", name: "No id", lat: 1, lon: 1, "osm:amenity": "cafe" },
      null,
    ]);
    const result = await run({ runId: "r1" });

    expect(result.created).toBe(4);
    expect(result.skipped.malformed).toBe(3);
    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(report).toContain("btcmap 777");
    expect(report).toContain("cache index 7");
    expect(report).toContain("cache index 8");
  });

  it("refuses to overwrite an existing run dir", async () => {
    writeCache(FIXTURE);
    const first = await run({ runId: "r1" });
    const before = readFileSync(join(first.runDir, "unsigned.jsonl"), "utf8");

    await expect(run({ runId: "r1" })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(first.runDir, "unsigned.jsonl"), "utf8")).toBe(before);
  });

  it("refuses an existing run dir before reading the header", async () => {
    writeCache(FIXTURE);
    await run({ runId: "r1" });
    await expect(build(cfg, state, { runId: "r1" })).rejects.toThrow(/already exists/);
  });

  it("refuses a run id that is not a plain directory name", async () => {
    writeCache(FIXTURE);
    await expect(run({ runId: "../escape" })).rejects.toThrow(/run id/);
    await expect(run({ runId: ".." })).rejects.toThrow(/run id/);
  });

  it("names the run by UTC time, with -pilot for a pilot build", async () => {
    writeCache(FIXTURE);
    const full = await run();
    expect(basename(full.runDir)).toMatch(/^\d{8}T\d{6}Z$/);
    const pilot = await run({ pilot: 1 });
    expect(basename(pilot.runDir)).toMatch(/^\d{8}T\d{6}Z-pilot$/);
  });

  it("fails without a cache, before reading the header", async () => {
    await expect(build(cfg, state, { runId: "r1" })).rejects.toThrow(/npm run fetch/);
  });

  it("stops on a header that fails the check and writes nothing", async () => {
    writeCache(FIXTURE);
    const bad = header({ tags: [["d", COORD_D], ["required", "name"]] });
    await expect(build(cfg, state, { runId: "r1", header: bad })).rejects.toThrow(/required/);
    expect(existsSync(cfg.paths.out) ? readdirSync(cfg.paths.out) : []).toEqual([]);
  });

  it("writes a manifest with the options, cache path, header id and counts", async () => {
    const cachePath = writeCache(FIXTURE);
    const result = await run({ runId: "r1", filter: { country: "US" }, pilot: 2 });
    const manifest = JSON.parse(readFileSync(join(result.runDir, "manifest.json"), "utf8"));
    expect(manifest).toEqual({
      runId: "r1",
      cachePath,
      headerEventId: "1".repeat(64),
      options: { pilot: 2, filter: { country: "US" }, allowDeletions: false },
      counts: {
        created: 2,
        changed: 0,
        unchanged: 0,
        deletions: 0,
        skipped: { "out-of-scope": 1, malformed: 0 },
        duplicates: 1,
        held: 0,
      },
    });
  });

  it("writes a report with counts, skips, duplicates, coverage and samples", async () => {
    writeCache(FIXTURE);
    const { runDir } = await run({ runId: "r1" });
    const report = readFileSync(join(runDir, "report.md"), "utf8");
    expect(report).toMatch(/\| created \| 4 \|/);
    expect(report).toMatch(/\| out-of-scope \| 1 \|/);
    expect(report).toContain(`${PLACE15_OSM}: kept btcmap 15, dropped btcmap 1500`);
    expect(report).toMatch(/\| name \| 4 \| 100\.0% \|/);
    expect(report).toMatch(/\| website \| 1 \| 25\.0% \|/);
    expect(report).toContain('["d","osm-node-101"]');
  });
});

describe("checkHeader", () => {
  const coord = () => cfg.headerCoordinate;

  it("accepts the expected header, in any required order and with descriptions", () => {
    expect(() => checkHeader(header(), coord())).not.toThrow();
    const reordered = header({
      tags: [["d", COORD_D], ["required", "category", "OSM category"], ["required", "name"]],
    });
    expect(() => checkHeader(reordered, coord())).not.toThrow();
  });

  it("checkHeader rejects a header whose required set changed", () => {
    const fewer = header({ tags: [["d", COORD_D], ["required", "name"]] });
    const more = header({
      tags: [["d", COORD_D], ["required", "name"], ["required", "category"], ["required", "address"]],
    });
    expect(() => checkHeader(fewer, coord())).toThrow(/required/);
    expect(() => checkHeader(more, coord())).toThrow(/required/);
  });

  it("rejects a missing header, a wrong author, a wrong d and a wrong kind", () => {
    expect(() => checkHeader(null, coord())).toThrow(/not found/);
    expect(() => checkHeader(header({ pubkey: "f".repeat(64) }), coord())).toThrow(/author/);
    expect(() =>
      checkHeader(header({ tags: [["d", "other"], ["required", "name"], ["required", "category"]] }), coord()),
    ).toThrow(/d is "other"/);
    expect(() => checkHeader(header({ kind: 39999 }), coord())).toThrow(/kind/);
  });
});

describe("census", () => {
  it("reports counts by amenity, shop and craft, the in-scope total, coverage and skips", () => {
    const path = writeCache([...FIXTURE, { id: 9, osm_id: "node:9", lat: 1, lon: 1, "osm:amenity": "atm" }, null]);
    const md = census(cfg, path);
    expect(md).toMatch(/\| restaurant \| 3 \| yes \|/);
    expect(md).toMatch(/\| atm \| 1 \| no \|/);
    expect(md).toMatch(/\| supermarket \| 1 \| no \|/);
    expect(md).toMatch(/\| brewery \| 1 \| yes \|/);
    expect(md).toContain("In scope: 4");
    expect(md).toMatch(/\| out-of-scope \| 2 \|/);
    expect(md).toMatch(/\| malformed \| 1 \|/);
    expect(md).toMatch(/\| duplicate \| 1 \|/);
    expect(md).toMatch(/\| name \| 4 \| 100\.0% \|/);
  });
});

describe("fetchHeader", () => {
  // Loopback only: port 9 refuses the connection, so nothing leaves this machine.
  it("rejects cleanly, with no uncaught error, when the relay is unreachable", async () => {
    await expect(fetchHeader(NO_RELAY, cfg.headerCoordinate, 2000)).rejects.toThrow(
      /cannot read the header: cannot connect to ws:\/\/127\.0\.0\.1:9/,
    );
    // Give a stray socket error event the chance to surface inside this test.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
