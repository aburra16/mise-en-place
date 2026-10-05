import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import * as nip19 from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build, type BuildOptions } from "../../src/commands/build.js";
import { rebroadcastHeader } from "../../src/commands/header-rebroadcast.js";
import { publish, type RelayPublishResult } from "../../src/commands/publish.js";
import { sign } from "../../src/commands/sign.js";
import { verify } from "../../src/commands/verify.js";
import { loadConfig, type Config } from "../../src/config.js";
import { fetchHeader } from "../../src/header.js";
import { tagValue } from "../../src/item.js";
import { connectRelay, queryAll } from "../../src/relay.js";
import type { RawPlace } from "../../src/source/btcmap.js";
import { openState, type State } from "../../src/state.js";
import { startNak } from "./nak.js";

// Everything here talks to `nak serve` on loopback only: never a public relay. Two relays, as
// in production: nak refuses a kind 5 whose events are already gone ("blocked: nothing to
// delete"), so two relay names on one nak cannot stand in for two relays.
const DCOSL_PORT = 10599;
const SEARCH_PORT = 10598;
/** A fresh relay for each rebroadcast test, so it starts without the header. */
const TARGET_PORT = 10596;

const headerSecret = generateSecretKey();
const HEADER_D = "food-and-drink-places";
const COORD = `39998:${getPublicKey(headerSecret)}:${HEADER_D}`;

let dcoslNak: { url: string; stop(): Promise<void> };
let searchNak: { url: string; stop(): Promise<void> };
let header: NostrEvent;

beforeAll(async () => {
  dcoslNak = await startNak(DCOSL_PORT);
  searchNak = await startNak(SEARCH_PORT);
  header = finalizeEvent(
    {
      kind: 39998,
      created_at: Math.floor(Date.now() / 1000) - 100_000,
      content: "",
      tags: [
        ["d", HEADER_D],
        ["names", "food and drink place", "food and drink places"],
        ["required", "name"],
        ["required", "category"],
      ],
    },
    headerSecret,
  );
  const relay = await connectRelay(dcoslNak.url, 5_000);
  try {
    await relay.publish(header);
  } finally {
    relay.close();
  }
}, 20_000);

afterAll(async () => {
  await dcoslNak?.stop();
  await searchNak?.stop();
});

/** Throws unless every relay in `cfg` is on loopback, so no test can reach a public relay. */
function assertLoopback(cfg: Config): void {
  for (const [name, url] of Object.entries(cfg.relays)) {
    if (new URL(url).hostname !== "127.0.0.1") throw new Error(`test relay ${name} is not on loopback: ${url}`);
  }
}

interface World {
  dir: string;
  cfg: Config;
  state: State;
  keyPath: string;
}

/**
 * A fresh curator key, state file and run directory. Each test signs with its own key, and
 * verify filters by author, so tests sharing the one in-memory relay never see each other.
 */
function newWorld(relays?: Record<string, string>): World {
  const dir = mkdtempSync(join(tmpdir(), "mise-pipeline-"));
  const secret = generateSecretKey();
  const keyPath = join(dir, "curator.key");
  writeFileSync(keyPath, `${nip19.nsecEncode(secret)}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const cfg: Config = {
    ...loadConfig("config.json"),
    headerCoordinate: COORD,
    curatorPubkey: getPublicKey(secret),
    relays: relays ?? { dcosl: dcoslNak.url, search: searchNak.url },
    headerRelay: "dcosl",
    publish: { eventsPerSecond: 1000, okTimeoutMs: 5_000 },
    paths: { data: join(dir, "data"), out: join(dir, "out"), state: join(dir, "state.sqlite") },
  };
  assertLoopback(cfg);
  return { dir, cfg, state: openState(cfg.paths.state), keyPath };
}

let w: World;

beforeEach(() => {
  w = newWorld();
});

afterEach(() => {
  w.state.close();
  rmSync(w.dir, { recursive: true, force: true });
});

/** `n` in-scope US restaurants with distinct OSM ids. */
function restaurants(n: number): RawPlace[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 2000 + i,
    osm_id: `node:${2000 + i}`,
    name: `Diner ${i}`,
    lat: 30 + i * 0.01,
    lon: -97,
    "osm:amenity": "restaurant",
  }));
}

const PLACES = restaurants(6);
const dOf = (place: RawPlace) => `osm-${String(place.osm_id).replace(":", "-")}`;

function writeCache(cfg: Config, records: RawPlace[]): void {
  const cacheDir = join(cfg.paths.data, "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "places-2026-10-05.json"), JSON.stringify(records));
}

function signedEvents(runDir: string): NostrEvent[] {
  return readFileSync(join(runDir, "signed.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as NostrEvent);
}

/** Every sign gets a later created_at than the one before, as wall-clock runs would. */
let clock = Math.floor(Date.now() / 1000) - 50_000;

async function buildAndSign(cache: RawPlace[], runId: string, opts: BuildOptions = {}) {
  writeCache(w.cfg, cache);
  const built = await build(w.cfg, w.state, { runId, ...opts });
  await sign(w.cfg, built.runDir, { keyPath: w.keyPath, now: () => ++clock });
  return { built, runDir: built.runDir, events: signedEvents(built.runDir) };
}

type Count = "sent" | "ok" | "failed" | "skipped";
const total = (r: Record<string, RelayPublishResult>, key: Count) =>
  Object.values(r).reduce((sum, x) => sum + x[key], 0);

async function expectCleanVerify(inState: number): Promise<void> {
  const result = await verify(w.cfg, w.state);
  expect(Object.keys(result).sort()).toEqual(["dcosl", "search"]);
  for (const r of Object.values(result)) {
    expect(r).toEqual({ onRelay: inState, inState, missing: [], extra: [], stale: [] });
  }
}

describe("pipeline against nak serve", () => {
  it("full cycle: build, sign, publish and verify leave every item live and nothing missing", async () => {
    const { built, runDir, events } = await buildAndSign(PLACES, "r1");
    expect(built.created).toBe(6);

    const result = await publish(w.cfg, w.state, runDir);
    expect(result).toEqual({
      dcosl: { sent: 6, ok: 6, failed: 0, skipped: 0 },
      search: { sent: 6, ok: 6, failed: 0, skipped: 0 },
    });

    const live = w.state.liveItems();
    expect([...live.keys()]).toEqual(PLACES.map(dOf).sort());
    for (const ev of events) {
      const item = live.get(tagValue(ev.tags, "d")!)!;
      expect(item.latestEventId).toBe(ev.id);
      expect(item.tagsJson).toBe(JSON.stringify(ev.tags));
    }
    await expectCleanVerify(6);
  });

  it("rebuild is a no-op", async () => {
    const first = await buildAndSign(PLACES, "r1");
    await publish(w.cfg, w.state, first.runDir);

    writeCache(w.cfg, PLACES);
    const second = await build(w.cfg, w.state, { runId: "r2" });
    expect(second).toMatchObject({ created: 0, changed: 0, unchanged: 6, deletions: 0 });
    expect(readFileSync(join(second.runDir, "unsigned.jsonl"), "utf8")).toBe("");
  });

  it("a changed place republishes only that item, and state keeps both versions", async () => {
    const first = await buildAndSign(PLACES, "r1");
    await publish(w.cfg, w.state, first.runDir);
    const d = dOf(PLACES[2]!);
    const oldId = first.events.find((e) => tagValue(e.tags, "d") === d)!.id;

    const renamed = PLACES.map((p, i) => (i === 2 ? { ...p, name: "Diner Two Renamed" } : p));
    const second = await buildAndSign(renamed, "r2");
    expect(second.built).toMatchObject({ created: 0, changed: 1, unchanged: 5 });
    expect(second.events).toHaveLength(1);
    const newId = second.events[0]!.id;

    const result = await publish(w.cfg, w.state, second.runDir);
    expect(total(result, "sent")).toBe(2);
    expect(total(result, "ok")).toBe(2);
    expect(w.state.versionsOf(d)).toEqual([oldId, newId]);
    expect(w.state.liveItems().get(d)!.latestEventId).toBe(newId);
    await expectCleanVerify(6);
  });

  it("a removed place is deleted with every version", async () => {
    const first = await buildAndSign(PLACES, "r1");
    await publish(w.cfg, w.state, first.runDir);
    const renamed = PLACES.map((p, i) => (i === 2 ? { ...p, name: "Diner Two Renamed" } : p));
    const second = await buildAndSign(renamed, "r2");
    await publish(w.cfg, w.state, second.runDir);
    const d = dOf(PLACES[2]!);
    const versions = w.state.versionsOf(d);
    expect(versions).toHaveLength(2);

    const without = PLACES.filter((_, i) => i !== 2);
    const third = await buildAndSign(without, "r3", { allowDeletions: true });
    expect(third.built.deletions).toBe(1);
    const deletion = third.events.find((e) => e.kind === 5)!;
    expect(deletion.tags.filter((t) => t[0] === "e").map((t) => t[1])).toEqual(versions);
    expect(deletion.tags).toContainEqual(["a", `39999:${w.cfg.curatorPubkey}:${d}`]);

    const result = await publish(w.cfg, w.state, third.runDir);
    expect(total(result, "ok")).toBe(2);

    for (const url of [dcoslNak.url, searchNak.url]) {
      const onRelay = await queryAll(url, { kinds: [39999], authors: [w.cfg.curatorPubkey] });
      expect(onRelay.map((e) => tagValue(e.tags, "d"))).not.toContain(d);
      expect(onRelay).toHaveLength(5);
    }
    expect(w.state.liveItems().has(d)).toBe(false);
    await expectCleanVerify(5);
  });

  it("interrupted publish resumes: the rerun sends only what was not accepted", async () => {
    const { runDir } = await buildAndSign(PLACES, "r1");
    const pairs = PLACES.length * 2;
    const half = pairs / 2;

    await expect(
      publish(w.cfg, w.state, runDir, undefined, {
        onEventSent: (n) => {
          if (n >= half) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    const firstOk = w.state.runs().reduce((sum, r) => sum + r.ok, 0);
    expect(firstOk).toBeGreaterThanOrEqual(half);
    expect(firstOk).toBeLessThan(pairs);

    const second = await publish(w.cfg, w.state, runDir);
    expect(total(second, "skipped")).toBe(firstOk);
    expect(total(second, "sent")).toBe(pairs - firstOk);
    expect(total(second, "ok")).toBe(pairs - firstOk);
    expect(total(second, "failed")).toBe(0);
    expect(w.state.liveItems().size).toBe(6);
    await expectCleanVerify(6);

    const third = await publish(w.cfg, w.state, runDir);
    expect(total(third, "skipped")).toBe(pairs);
    expect(total(third, "sent")).toBe(0);
  });

  it("verify lists items missing from a relay, extra on it, and stale versions", async () => {
    const first = await buildAndSign(PLACES, "r1");
    await publish(w.cfg, w.state, first.runDir);
    const [a, b] = [dOf(PLACES[0]!), dOf(PLACES[1]!)];
    const tagsOf = (d: string) => first.events.find((e) => tagValue(e.tags, "d") === d)!.tags;

    w.state.markLive("osm-node-999", "h", "[]", "f".repeat(64), 1); // in state, never published
    w.state.markDeleted(a, 1); // on the relay, no longer live in state
    w.state.markLive(b, "h", JSON.stringify(tagsOf(b)), "e".repeat(64), 1); // state expects another id

    const result = await verify(w.cfg, w.state);
    for (const r of Object.values(result)) {
      expect(r).toEqual({ onRelay: 6, inState: 6, missing: ["osm-node-999"], extra: [a], stale: [b] });
    }
  });

  it("header rebroadcast copies the event byte for byte", async () => {
    const target = await startNak(TARGET_PORT);
    try {
      const world = newWorld({ dcosl: dcoslNak.url, search: target.url });
      try {
        expect(await fetchHeader(target.url, COORD)).toBeNull();
        const result = await rebroadcastHeader(world.cfg, "search");
        expect(result).toMatchObject({ ok: true, eventId: header.id });
        const copied = await fetchHeader(target.url, COORD);
        // Every field, id and sig included. (The relay picks its own key order on the wire.)
        expect(copied).toEqual(header);

        await expect(rebroadcastHeader(world.cfg, "dcosl")).rejects.toThrow(/dcosl is the header relay/);
        await expect(rebroadcastHeader(world.cfg, "nope")).rejects.toThrow(/unknown relay "nope"/);
      } finally {
        world.state.close();
        rmSync(world.dir, { recursive: true, force: true });
      }
    } finally {
      await target.stop();
    }
  });

  describe("cli", () => {
    function cli(...args: string[]) {
      const configPath = join(w.dir, "config.json");
      writeFileSync(configPath, JSON.stringify(w.cfg));
      return spawnSync("node_modules/.bin/tsx", ["src/cli.ts", ...args], {
        encoding: "utf8",
        env: { ...process.env, MISE_CONFIG: configPath, MISE_KEY_FILE: join(w.dir, "absent.key") },
      });
    }

    it("publish and verify print a line per relay and exit 0 when everything matches", async () => {
      await buildAndSign(PLACES, "r1");

      const pub = cli("publish", "r1");
      expect(pub.stderr).toBe("");
      expect(pub.status).toBe(0);
      expect(pub.stdout).toContain("dcosl: sent 6, ok 6, failed 0, skipped 0");
      expect(pub.stdout).toContain("search: sent 6, ok 6, failed 0, skipped 0");

      const again = cli("publish", "r1", "--relays", "search");
      expect(again.status).toBe(0);
      expect(again.stdout).toBe("search: sent 0, ok 0, failed 0, skipped 6\n");

      const ver = cli("verify");
      expect(ver.stderr).toBe("");
      expect(ver.status).toBe(0);
      expect(ver.stdout).toContain("dcosl: on relay 6, in state 6, missing 0, extra 0, stale 0");
      expect(ver.stdout).toContain("search: on relay 6, in state 6, missing 0, extra 0, stale 0");
    }, 30_000);

    it("verify exits non-zero and names what is missing", async () => {
      const { runDir } = await buildAndSign(PLACES, "r1");
      await publish(w.cfg, w.state, runDir);
      w.state.markLive("osm-node-999", "h", "[]", "f".repeat(64), 1);

      const ver = cli("verify");
      expect(ver.status).not.toBe(0);
      expect(ver.stdout).toContain("dcosl: on relay 6, in state 7, missing 1, extra 0, stale 0");
      expect(ver.stdout).toContain("missing: osm-node-999");
      expect(ver.stderr).toMatch(/verify: .*dcosl, search/);
    }, 30_000);

    it("header:rebroadcast copies the header and prints its id", async () => {
      const target = await startNak(TARGET_PORT);
      try {
        w.cfg = { ...w.cfg, relays: { dcosl: dcoslNak.url, search: target.url } };
        expect(await fetchHeader(target.url, COORD)).toBeNull();
        const res = cli("header:rebroadcast", "search");
        expect(res.stderr).toBe("");
        expect(res.status).toBe(0);
        expect(res.stdout).toContain(header.id);
        expect((await fetchHeader(target.url, COORD))?.sig).toBe(header.sig);
      } finally {
        await target.stop();
      }
    }, 30_000);
  });
});
