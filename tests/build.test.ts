import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, type BuildOptions } from "../src/commands/build.js";
import { census } from "../src/commands/census.js";
import { headerAuthor, loadConfig, type Config } from "../src/config.js";
import type { Unsigned } from "../src/deletion.js";
import { contentHash } from "../src/diff.js";
import { checkHeader, fetchHeader } from "../src/header.js";
import type { Tags } from "../src/item.js";
import { codeSpan } from "../src/markdown.js";
import type { RawPlace } from "../src/source/btcmap.js";
import { openState, type State } from "../src/state.js";
import { startStubRelay } from "./stub-relay.js";

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

/** A build with the header injected; `firstRun` is set so an empty state is allowed. */
function run(opts: BuildOptions = {}) {
  return build(cfg, state, { header: header(), firstRun: true, ...opts });
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

    // allowDeletions 0 (the build must find nothing gone), so it is the hold that keeps the item.
    const result = await run({ runId: "r2", allowDeletions: 0 });

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

    const result = await run({ runId: "r1", allowDeletions: 2 });

    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    const section = report.slice(report.indexOf("## Deletions"));
    expect(section).toContain("- `osm-node-555`: `Old Diner` (1 event id)");
    expect(section).toContain("- `osm-node-556`: (no name recorded) (1 event id)");
  });

  it("renders gone and held names and their d as code spans, so markdown in a name stays literal", async () => {
    const name = "*Star* _Bar_ `Tick` ``Two``";
    const span = "``` *Star* _Bar_ `Tick` ``Two`` ```"; // a fence longer than any run inside
    writeCache(FIXTURE.map((p) => (p.id === 103 ? { ...p, lat: null } : p))); // 103 is held
    for (const d of ["osm-node-103", "osm-node-555"]) {
      const tags: Tags = [["d", d], ["name", name]];
      state.markLive(d, contentHash(tags), JSON.stringify(tags), `ev-${d}`, 1);
    }

    const result = await run({ runId: "r1", allowDeletions: 1 });

    const report = readFileSync(join(result.runDir, "report.md"), "utf8");
    const deletions = report.slice(report.indexOf("## Deletions"), report.indexOf("## Held"));
    expect(deletions).toContain(`- \`osm-node-555\`: ${span} (1 event id)`);
    const held = report.slice(report.indexOf("## Held"), report.indexOf("## Skipped"));
    expect(held).toContain(`- \`osm-node-103\`: ${span} (live, kept)`);
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

    const result = await run({ runId: "r1", allowDeletions: 1 });

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

    const result = await run({ runId: "r1", allowDeletions: 2 });

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
    const result = await run({ runId: "r1", allowDeletions: 2 });
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

  describe("--allow-deletions=N", () => {
    /** 100 published restaurants, then a cache that drops the first `n` of them. */
    async function dropped(n: number): Promise<RawPlace[]> {
      const all = restaurants(100);
      writeCache(all);
      publishAll((await run({ runId: "r1" })).runDir);
      expect(state.liveItems().size).toBe(100);
      const remaining = all.slice(n);
      writeCache(remaining, "2026-10-06");
      return remaining;
    }

    /** The names of what is in `out`: the run dirs and anything else build left there. */
    const outEntries = () => readdirSync(cfg.paths.out).sort();
    const refusedFiles = () => outEntries().filter((n) => /^refused-\d{8}T\d{6}Z\.md$/.test(n));

    it("refuses deletions over the guard without the flag, states the count and the exact flag", async () => {
      await dropped(3);

      const refusal = run({ runId: "r2" });

      await expect(refusal).rejects.toThrow(/would delete 3 of 100 live items, more than 2%/);
      await expect(refusal).rejects.toThrow(/rerun with --allow-deletions=3 only if/);
      expect(existsSync(join(cfg.paths.out, "r2"))).toBe(false);
    });

    it("builds over the guard when N equals the gone count", async () => {
      await dropped(3);

      const allowed = await run({ runId: "r2", allowDeletions: 3 });

      expect(allowed.deletions).toBe(3);
      expect(lines(allowed.runDir).filter((e) => e.kind === 5)).toHaveLength(3);
    });

    it("refuses over the guard when N is not the gone count, and names the actual one", async () => {
      await dropped(3);

      for (const wrong of [2, 4, 0, 100]) {
        const refusal = run({ runId: "r2", allowDeletions: wrong });
        await expect(refusal, `N=${wrong}`).rejects.toThrow(
          new RegExp(`--allow-deletions=${wrong} does not match: build would delete 3 of 100 live items`),
        );
        await expect(refusal).rejects.toThrow(/rerun with --allow-deletions=3 only if/);
      }
      expect(existsSync(join(cfg.paths.out, "r2"))).toBe(false);
    });

    it("refuses when N is not the gone count even though the guard would not have tripped", async () => {
      await dropped(2); // 2 of 100 is exactly the guard, so no flag is needed

      const refusal = run({ runId: "r2", allowDeletions: 5 });

      await expect(refusal).rejects.toThrow(/--allow-deletions=5 does not match: build would delete 2 of 100 live items/);
      await expect(refusal).rejects.toThrow(/within the 2% guard/);
      await expect(refusal).rejects.toThrow(/--allow-deletions=2/);
      expect(existsSync(join(cfg.paths.out, "r2"))).toBe(false);
    });

    it("builds within the guard when N equals the gone count, and still without the flag", async () => {
      await dropped(2);

      expect((await run({ runId: "r2", allowDeletions: 2 })).deletions).toBe(2);
      expect((await run({ runId: "r3" })).deletions).toBe(2);
    });

    it("takes 0 as 'expect nothing gone': it builds when nothing is, and refuses when something is", async () => {
      const remaining = await dropped(0);
      expect((await run({ runId: "r2", allowDeletions: 0 })).deletions).toBe(0);

      writeCache(remaining.slice(1), "2026-10-07");
      await expect(run({ runId: "r3", allowDeletions: 0 })).rejects.toThrow(
        /--allow-deletions=0 does not match: build would delete 1 of 100 live items/,
      );
    });

    it("refuses N above 0 when nothing is gone, and says so", async () => {
      await dropped(0);

      await expect(run({ runId: "r2", allowDeletions: 4 })).rejects.toThrow(
        /--allow-deletions=4 does not match: build would delete 0 of 100 live items; rerun without --allow-deletions/,
      );
    });

    it("refuses N above 0 on a pilot or filtered build, which looks for no deletions", async () => {
      writeCache(FIXTURE);
      state.markLive("osm-node-424242", "hash", "[]", "ev-gone", 1);

      await expect(run({ runId: "r1", pilot: 2, allowDeletions: 1 })).rejects.toThrow(
        /--allow-deletions=1 does not match: .*pilot or filtered build looks for no deletions/,
      );
      await expect(run({ runId: "r2", filter: { country: "US" }, allowDeletions: 1 })).rejects.toThrow(
        /pilot or filtered build looks for no deletions/,
      );
      expect(existsSync(cfg.paths.out)).toBe(false);
    });

    it("refuses an N that is not a whole number of at least 0", async () => {
      writeCache(FIXTURE);
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(run({ runId: "r1", allowDeletions: bad }), String(bad)).rejects.toThrow(/allowDeletions/);
      }
      expect(existsSync(cfg.paths.out)).toBe(false);
    });

    it("records the count in the manifest and the report, and null when the flag is absent", async () => {
      await dropped(3);

      const withFlag = await run({ runId: "r2", allowDeletions: 3 });
      const manifest = JSON.parse(readFileSync(join(withFlag.runDir, "manifest.json"), "utf8")) as {
        options: { allowDeletions: number | null };
      };
      expect(manifest.options.allowDeletions).toBe(3);
      expect(readFileSync(join(withFlag.runDir, "report.md"), "utf8")).toContain(
        "- Deletions: looked for; --allow-deletions=3 given",
      );

      const without = await run({ runId: "r3", pilot: 5 });
      const plain = JSON.parse(readFileSync(join(without.runDir, "manifest.json"), "utf8")) as {
        options: { allowDeletions: number | null };
      };
      expect(plain.options.allowDeletions).toBeNull();
    });

    describe("the refusal's list of gone items", () => {
      /** Marks 100 named restaurants live, then drops the first `n` from the cache. */
      async function namedAndDropped(n: number): Promise<void> {
        const all = restaurants(100);
        writeCache(all);
        publishAll((await run({ runId: "r1" })).runDir);
        writeCache(all.slice(n), "2026-10-06");
      }

      it("goes to <paths.out>/refused-<timestamp>.md, which the error message names, and no run dir appears", async () => {
        await namedAndDropped(3);
        const before = outEntries();

        let message = "";
        try {
          await run({ runId: "r2" });
        } catch (err) {
          message = (err as Error).message;
        }

        expect(message).toMatch(/would delete 3 of 100/);
        const files = refusedFiles();
        expect(files).toHaveLength(1);
        expect(message).toContain(`the 3 items it would delete, with their names, are listed in ${join(cfg.paths.out, files[0]!)}`);
        expect(outEntries()).toEqual([...before, files[0]!].sort()); // the refused file, and no r2
        expect(existsSync(join(cfg.paths.out, "r2"))).toBe(false);

        const list = readFileSync(join(cfg.paths.out, files[0]!), "utf8");
        for (const i of [0, 1, 2]) {
          expect(list).toContain(`- \`osm-node-${1000 + i}\`: \`Place ${i}\``);
        }
        expect(list).not.toContain("osm-node-1003");
        expect(list).toMatch(/would delete 3 of 100/);
      });

      it("is written for a count mismatch too, but not when nothing is gone", async () => {
        await namedAndDropped(2);

        await expect(run({ runId: "r2", allowDeletions: 5 })).rejects.toThrow(/listed in .*refused-/);
        expect(readFileSync(join(cfg.paths.out, refusedFiles()[0]!), "utf8")).toContain("`osm-node-1001`: `Place 1`");

        rmSync(join(cfg.paths.out, refusedFiles()[0]!));
        writeCache(restaurants(100), "2026-10-09"); // everything is back: nothing gone
        await expect(run({ runId: "r3", allowDeletions: 5 })).rejects.toThrow(/does not match/);
        expect(refusedFiles()).toEqual([]);
      });

      it("shows an item with no recorded name as such, and keeps markdown in a name literal", async () => {
        writeCache(restaurants(100));
        state.markLive("osm-node-9001", "h", "[]", "e1", 1);
        const starred: Tags = [["d", "osm-node-9002"], ["name", "*Star* _Bar_"]];
        state.markLive("osm-node-9002", contentHash(starred), JSON.stringify(starred), "e2", 1);

        await expect(run({ runId: "r1" })).rejects.toThrow(/listed in/);

        const list = readFileSync(join(cfg.paths.out, refusedFiles()[0]!), "utf8");
        expect(list).toContain("- `osm-node-9001`: (no name recorded)");
        expect(list).toContain("- `osm-node-9002`: `*Star* _Bar_`");
      });

      it("does not hide the refusal if the list cannot be written", async () => {
        await namedAndDropped(3);
        rmSync(cfg.paths.out, { recursive: true });
        writeFileSync(cfg.paths.out, "a file where the out directory should be");

        await expect(run({ runId: "r2" })).rejects.toThrow(
          /would delete 3 of 100 live items.*could not write the list of the 3 items/,
        );
      });
    });
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
    await expect(build(cfg, state, { runId: "r1", header: bad, firstRun: true })).rejects.toThrow(/required/);
    expect(existsSync(cfg.paths.out) ? readdirSync(cfg.paths.out) : []).toEqual([]);
  });

  describe("an empty state", () => {
    it("is refused without firstRun, before reading the header, and nothing is written", async () => {
      writeCache(FIXTURE);
      // No header injected: the refusal must come before the header read.
      const refusal = build(cfg, state, { runId: "r1" });

      await expect(refusal).rejects.toThrow(/holds no items, live or deleted/);
      await expect(refusal).rejects.toThrow(/would publish every place again/);
      await expect(refusal).rejects.toThrow(/restore it from a backup/);
      await expect(refusal).rejects.toThrow(/--first-run/);
      expect(existsSync(join(cfg.paths.out, "r1"))).toBe(false);
    });

    it("builds with firstRun", async () => {
      writeCache(FIXTURE);
      const result = await build(cfg, state, { runId: "r1", header: header(), firstRun: true });
      expect(result.created).toBe(4);
    });

    it("is refused for a pilot too", async () => {
      writeCache(FIXTURE);
      await expect(build(cfg, state, { runId: "r1", header: header(), pilot: 2 })).rejects.toThrow(/--first-run/);
    });
  });

  it("a state that holds items, live or only deleted, needs no firstRun", async () => {
    writeCache(FIXTURE);
    state.markLive("osm-node-101", "old-hash", "[]", "ev-101", 1);
    const withLive = await build(cfg, state, { runId: "r1", header: header() });
    expect(withLive.changed).toBe(1);

    state.markDeleted("osm-node-101", 2);
    expect(state.counts()).toEqual({ live: 0, deleted: 1 });
    const onlyDeleted = await build(cfg, state, { runId: "r2", header: header() });
    expect(onlyDeleted.created).toBe(4);
  });

  it("writes a manifest with the config it was built for, the options, cache path, header id and counts", async () => {
    const cachePath = writeCache(FIXTURE);
    const result = await run({ runId: "r1", filter: { country: "US" }, pilot: 2 });
    const manifest = JSON.parse(readFileSync(join(result.runDir, "manifest.json"), "utf8"));
    expect(manifest).toEqual({
      runId: "r1",
      config: {
        headerCoordinate: cfg.headerCoordinate,
        curatorPubkey: cfg.curatorPubkey,
        relays: { dcosl: NO_RELAY, search: NO_RELAY },
        statePath: ":memory:",
      },
      cachePath,
      headerEventId: "1".repeat(64),
      options: { pilot: 2, filter: { country: "US" }, allowDeletions: null },
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

  describe("report.md changed fields", () => {
    /** `n` published restaurants that all carry an address and a phone. */
    async function published(n: number): Promise<RawPlace[]> {
      const places = restaurants(n).map((p) => ({ ...p, address: "1 Main St", phone: "+1 555 0100" }));
      writeCache(places);
      publishAll((await run({ runId: "r1" })).runDir);
      return places;
    }
    const section = (report: string) => report.slice(report.indexOf("## Changed fields"), report.indexOf("## Deletions"));

    it("counts the changed items per tag: address on 3 items and phone on 1", async () => {
      const before = await published(6);
      writeCache(
        before.map((p, i) => (i < 3 ? { ...p, address: "2 Oak Ave" } : i === 3 ? { ...p, phone: "+1 555 0199" } : p)),
        "2026-10-06",
      );

      const result = await run({ runId: "r2" });

      expect(result).toMatchObject({ created: 0, changed: 4, unchanged: 2 });
      const changed = section(readFileSync(join(result.runDir, "report.md"), "utf8"));
      expect(changed).toMatch(/\| tag \| changed items \|/);
      expect(changed).toMatch(/\| address \| 3 \|\n\| phone \| 1 \|/); // most items first
      expect(changed).not.toMatch(/\| (name|alt|d) \|/);
      expect(changed).toContain("- `osm-node-1000`: `Place 0` (address)");
      expect(changed).toContain("- `osm-node-1003`: `Place 3` (phone)");
      expect(changed).not.toContain("osm-node-1004");
    });

    it("counts a renamed place under name and alt, and an added field as differing", async () => {
      const before = await published(3);
      writeCache(
        before.map((p, i) => (i === 0 ? { ...p, name: "Renamed", website: "https://example.org" } : p)),
        "2026-10-06",
      );

      const result = await run({ runId: "r2" });

      const changed = section(readFileSync(join(result.runDir, "report.md"), "utf8"));
      for (const field of ["alt", "name", "website"]) expect(changed).toContain(`| ${field} | 1 |`);
      expect(changed).toContain("- `osm-node-1000`: `Renamed` (alt, name, website)");
    });

    it("shows at most 10 examples while the table counts every changed item", async () => {
      const before = await published(14);
      writeCache(before.map((p) => ({ ...p, phone: "+1 555 0123" })), "2026-10-06");

      const result = await run({ runId: "r2" });

      expect(result.changed).toBe(14);
      const changed = section(readFileSync(join(result.runDir, "report.md"), "utf8"));
      expect(changed).toContain("| phone | 14 |");
      expect(changed.match(/^- `osm-node-/gm)).toHaveLength(10);
      expect(changed).toContain("osm-node-1009");
      expect(changed).not.toContain("osm-node-1010");
    });

    it("says none when no item changed, and for a first build", async () => {
      await published(3);
      const same = await run({ runId: "r2" });
      expect(section(readFileSync(join(same.runDir, "report.md"), "utf8"))).toMatch(/## Changed fields\n\nnone\n/);

      state.close();
      state = openState(":memory:");
      const first = await run({ runId: "r3" });
      expect(section(readFileSync(join(first.runDir, "report.md"), "utf8"))).toMatch(/## Changed fields\n\nnone\n/);
    });

    it("keeps markdown in a changed item's name literal", async () => {
      const before = await published(1);
      writeCache([{ ...before[0]!, name: "*Star* _Bar_" }], "2026-10-06");

      const result = await run({ runId: "r2" });

      expect(section(readFileSync(join(result.runDir, "report.md"), "utf8"))).toContain(
        "- `osm-node-1000`: `*Star* _Bar_` (alt, name)",
      );
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

describe("codeSpan", () => {
  it.each([
    ["Old Diner", "`Old Diner`"],
    ["a `b` c", "``a `b` c``"],
    ["`start", "`` `start ``"],
    ["end``", "``` end`` ```"],
    [" both ", "`  both  `"],
    ["two\nlines\r\nhere", "`two lines here`"],
  ])("%j becomes %j", (text, expected) => {
    expect(codeSpan(text)).toBe(expected);
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

describe("header reads with relayReadSearch", () => {
  const SEARCH = "include:spam";
  const AUTH_REQUIRED = "auth-required: this relay answers through a web of trust and has no house observer to lend you";
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const coordinate = `39998:${pubkey}:${COORD_D}`;

  /** A loopback relay holding a signed header, which refuses a REQ without `search` like vespa-relay. */
  async function headerRelay(needsSearch: boolean) {
    const signed = finalizeEvent({ kind: 39998, created_at: 1_700_000_000, content: "", tags: header().tags }, secret);
    const filters: Record<string, unknown>[] = [];
    const stub = await startStubRelay(
      () => {},
      (received, ctx) => {
        filters.push(...received);
        if (needsSearch && received.some((f) => typeof f.search !== "string")) return ctx.closed(AUTH_REQUIRED);
        ctx.send(signed);
        ctx.eose();
      },
    );
    return { stub, filters, signed };
  }

  it("fetchHeader adds search to its REQ when given one, and nothing when not", async () => {
    const { stub, filters, signed } = await headerRelay(false);
    try {
      expect(await fetchHeader(stub.url, coordinate, 2000, SEARCH)).toEqual(signed);
      expect(await fetchHeader(stub.url, coordinate, 2000)).toEqual(signed);
    } finally {
      await stub.close();
    }
    expect(filters).toEqual([
      { kinds: [39998], authors: [pubkey], "#d": [COORD_D], search: SEARCH },
      { kinds: [39998], authors: [pubkey], "#d": [COORD_D] },
    ]);
    expect(Object.hasOwn(filters[1]!, "search")).toBe(false);
  });

  it("fetchHeader is refused by a relay that wants search when it sends none", async () => {
    const { stub } = await headerRelay(true);
    try {
      await expect(fetchHeader(stub.url, coordinate, 2000)).rejects.toThrow(/cannot read the header.*auth-required/);
      expect((await fetchHeader(stub.url, coordinate, 2000, SEARCH))?.pubkey).toBe(pubkey);
    } finally {
      await stub.close();
    }
  });

  it("build reads the header with the header relay's entry in relayReadSearch", async () => {
    const { stub, filters } = await headerRelay(true);
    try {
      cfg = {
        ...cfg,
        headerCoordinate: coordinate,
        relays: { dcosl: stub.url, search: NO_RELAY },
        headerRelay: "dcosl",
        relayReadSearch: { dcosl: SEARCH },
      };
      writeCache(FIXTURE);

      const result = await build(cfg, state, { firstRun: true, runId: "r1" });

      expect(result.created).toBe(4);
    } finally {
      await stub.close();
    }
    expect(filters).toEqual([{ kinds: [39998], authors: [pubkey], "#d": [COORD_D], search: SEARCH }]);
  });

  it("build adds no search for a header relay without an entry", async () => {
    const { stub, filters } = await headerRelay(false);
    try {
      // The entry is for the other relay, so the header read stays as it was.
      cfg = {
        ...cfg,
        headerCoordinate: coordinate,
        relays: { dcosl: stub.url, search: NO_RELAY },
        headerRelay: "dcosl",
        relayReadSearch: { search: SEARCH },
      };
      writeCache(FIXTURE);

      await build(cfg, state, { firstRun: true, runId: "r1" });
    } finally {
      await stub.close();
    }
    expect(filters).toEqual([{ kinds: [39998], authors: [pubkey], "#d": [COORD_D] }]);
  });
});
