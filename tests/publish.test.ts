import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publish } from "../src/commands/publish.js";
import { loadConfig, type Config } from "../src/config.js";
import { contentHash } from "../src/diff.js";
import { openState, type State } from "../src/state.js";
import { startStubRelay, type StubContext, type StubRelay } from "./stub-relay.js";

// Every relay here is a stub on loopback or the refused port 9: nothing leaves this machine.
const REFUSED = "ws://127.0.0.1:9";

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const COORD = loadConfig("config.json").headerCoordinate;
const T = 1_700_000_000;

let dir: string;
let runDir: string;
let state: State;
let stubs: StubRelay[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mise-publish-"));
  runDir = join(dir, "out", "run1");
  mkdirSync(runDir, { recursive: true });
  state = openState(":memory:");
  stubs = [];
});

afterEach(async () => {
  state.close();
  for (const stub of stubs) await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function stub(onEvent: (ev: NostrEvent, ctx: StubContext) => void): Promise<StubRelay> {
  const s = await startStubRelay(onEvent);
  stubs.push(s);
  return s;
}

const acceptAll = (_: NostrEvent, ctx: StubContext) => ctx.reply(true, "");

function config(relays: Record<string, string>, publishCfg: Partial<Config["publish"]> = {}): Config {
  return {
    ...loadConfig("config.json"),
    curatorPubkey: pubkey,
    relays,
    headerRelay: Object.keys(relays)[0]!,
    publish: { eventsPerSecond: 1000, okTimeoutMs: 2_000, ...publishCfg },
    paths: { data: join(dir, "data"), out: join(dir, "out"), state: ":memory:" },
  };
}

function item(d: string, key = secret, over: Partial<Parameters<typeof finalizeEvent>[0]> = {}): NostrEvent {
  return finalizeEvent(
    { kind: 39999, created_at: T, content: "", tags: [["d", d], ["z", COORD], ["name", `Place ${d}`]], ...over },
    key,
  );
}

function deletion(d: string, ids: string[]): NostrEvent {
  return finalizeEvent(
    {
      kind: 5,
      created_at: T + 1,
      content: "",
      tags: [...ids.map((id) => ["e", id]), ["a", `39999:${pubkey}:${d}`], ["k", "39999"]],
    },
    secret,
  );
}

function writeSigned(lines: unknown[]): void {
  writeFileSync(
    join(runDir, "signed.jsonl"),
    lines.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join(""),
  );
}

describe("publish", () => {
  it("rejected events are recorded as failed and not marked live", async () => {
    const relay = await stub((_, ctx) => ctx.reply(false, "blocked: test"));
    const events = [item("osm-node-1"), item("osm-node-2")];
    writeSigned(events);
    const recordResult = vi.spyOn(state, "recordResult");
    const markLive = vi.spyOn(state, "markLive");

    const result = await publish(config({ dcosl: relay.url }), state, runDir);

    expect(result).toEqual({ dcosl: { sent: 2, ok: 0, failed: 2, skipped: 0 } });
    for (const ev of events) {
      expect(recordResult).toHaveBeenCalledWith({
        eventId: ev.id,
        d: ev.tags[0]![1],
        kind: 39999,
        createdAt: T,
        runId: "run1",
        relay: "dcosl",
        ok: false,
        message: "blocked: test",
      });
      expect(state.acceptedOn(ev.id, "dcosl")).toBe(false);
    }
    expect(markLive).not.toHaveBeenCalled();
    expect(state.liveItems().size).toBe(0);
    expect(state.runs()).toEqual([{ runId: "run1", relay: "dcosl", ok: 0, failed: 2 }]);
  });

  it("marks an item live on its first OK only, and a deletion's item deleted", async () => {
    const [a, b] = [await stub(acceptAll), await stub(acceptAll)];
    const first = item("osm-node-1");
    const gone = deletion("osm-node-7", ["a".repeat(64)]);
    state.markLive("osm-node-7", "h", "[]", "a".repeat(64), 1);
    writeSigned([first, gone]);
    const markLive = vi.spyOn(state, "markLive");
    const markDeleted = vi.spyOn(state, "markDeleted");

    const result = await publish(config({ dcosl: a.url, search: b.url }), state, runDir);

    expect(result.dcosl).toEqual({ sent: 2, ok: 2, failed: 0, skipped: 0 });
    expect(result.search).toEqual({ sent: 2, ok: 2, failed: 0, skipped: 0 });
    expect(markLive).toHaveBeenCalledTimes(1);
    expect(markLive).toHaveBeenCalledWith(
      "osm-node-1",
      contentHash(first.tags),
      JSON.stringify(first.tags),
      first.id,
      T,
    );
    expect(markDeleted).toHaveBeenCalledTimes(1);
    expect(markDeleted).toHaveBeenCalledWith("osm-node-7", T + 1);
    expect([...state.liveItems().keys()]).toEqual(["osm-node-1"]);
    // A deletion is recorded under its item's d, and is not a version of it.
    expect(state.versionsOf("osm-node-7")).toEqual([]);
    expect(state.acceptedOn(gone.id, "dcosl")).toBe(true);
  });

  it("does not mark an item live again when a later run sends it to another relay", async () => {
    const [a, b] = [await stub(acceptAll), await stub(acceptAll)];
    const ev = item("osm-node-1");
    writeSigned([ev]);
    await publish(config({ dcosl: a.url, search: b.url }), state, runDir, ["dcosl"]);
    const markLive = vi.spyOn(state, "markLive");

    const result = await publish(config({ dcosl: a.url, search: b.url }), state, runDir, ["search"]);

    expect(result).toEqual({ search: { sent: 1, ok: 1, failed: 0, skipped: 0 } });
    expect(markLive).not.toHaveBeenCalled();
  });

  it("records each pair as pending before sending it", async () => {
    const log: string[] = [];
    let versionsWhenReceived: string[] = [];
    const ev = item("osm-node-1");
    // The relay takes the event and never answers. Were the process to die now, the version
    // must already be in state, or a later deletion would leave it out.
    const relay = await stub(() => {
      log.push("received");
      versionsWhenReceived = state.versionsOf("osm-node-1");
    });
    writeSigned([ev]);
    const record = state.recordResult.bind(state);
    vi.spyOn(state, "recordResult").mockImplementation((r) => {
      log.push(`recorded ${r.ok ? "ok" : "failed"}: ${r.message}`);
      record(r);
    });

    const result = await publish(config({ dcosl: relay.url }, { okTimeoutMs: 300 }), state, runDir);

    expect(result).toEqual({ dcosl: { sent: 1, ok: 0, failed: 1, skipped: 0 } });
    expect(log).toEqual(["recorded failed: pending", "received", "recorded failed: publish timed out"]);
    expect(versionsWhenReceived).toEqual([ev.id]);
    expect(state.acceptedOn(ev.id, "dcosl")).toBe(false);
  });

  it("waits and retries once on a rate-limited reply", async () => {
    const relay = await stub((_, ctx) =>
      ctx.n === 1 ? ctx.reply(false, "rate-limited: slow down") : ctx.reply(true, ""),
    );
    const ev = item("osm-node-1");
    writeSigned([ev]);
    const started = Date.now();

    const result = await publish(config({ dcosl: relay.url }), state, runDir, undefined, { backoffMs: 150 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(result).toEqual({ dcosl: { sent: 1, ok: 1, failed: 0, skipped: 0 } });
    expect(relay.received.map((e) => e.id)).toEqual([ev.id, ev.id]);
    expect(state.acceptedOn(ev.id, "dcosl")).toBe(true);
    expect(state.liveItems().has("osm-node-1")).toBe(true);
  });

  it("gives up after one retry when the relay stays rate-limited", async () => {
    const relay = await stub((_, ctx) => ctx.reply(false, "rate-limited: still too fast"));
    writeSigned([item("osm-node-1")]);
    const recordResult = vi.spyOn(state, "recordResult");

    const result = await publish(config({ dcosl: relay.url }), state, runDir, undefined, { backoffMs: 10 });

    expect(result).toEqual({ dcosl: { sent: 1, ok: 0, failed: 1, skipped: 0 } });
    expect(relay.received).toHaveLength(2);
    expect(recordResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, message: "rate-limited: still too fast" }),
    );
  });

  it("throttles each relay to eventsPerSecond and keeps file order, items before deletions", async () => {
    const relay = await stub(acceptAll);
    const items = ["osm-node-1", "osm-node-2", "osm-node-3", "osm-node-4", "osm-node-5"].map((d) => item(d));
    const events = [...items, deletion("osm-node-9", ["b".repeat(64)])];
    writeSigned(events);
    const started = Date.now();

    await publish(config({ dcosl: relay.url }, { eventsPerSecond: 20 }), state, runDir);

    // Six sends at 20 per second are at least five 50 ms gaps apart.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(relay.received.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it("publishes to the relays concurrently", async () => {
    const slow = (_: NostrEvent, ctx: StubContext) => setTimeout(() => ctx.reply(true, ""), 150);
    const [a, b] = [await stub(slow), await stub(slow)];
    writeSigned(["osm-node-1", "osm-node-2", "osm-node-3", "osm-node-4"].map((d) => item(d)));
    const started = Date.now();

    await publish(config({ dcosl: a.url, search: b.url }), state, runDir);

    // One after the other would take 8 x 150 ms; side by side about 4 x 150 ms.
    expect(Date.now() - started).toBeLessThan(1_100);
    expect(a.received).toHaveLength(4);
    expect(b.received).toHaveLength(4);
  });

  it("calls onEventSent with a running count after each result", async () => {
    const [a, b] = [await stub(acceptAll), await stub(acceptAll)];
    writeSigned([item("osm-node-1"), item("osm-node-2")]);
    const counts: number[] = [];

    await publish(config({ dcosl: a.url, search: b.url }), state, runDir, undefined, {
      onEventSent: (n) => counts.push(n),
    });

    expect(counts).toEqual([1, 2, 3, 4]);
  });

  it("reports a relay it cannot reach, records nothing for it, and still finishes the others", async () => {
    const relay = await stub(acceptAll);
    writeSigned([item("osm-node-1")]);

    const result = await publish(config({ dcosl: REFUSED, search: relay.url }), state, runDir);

    expect(result.dcosl).toEqual({
      sent: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      error: expect.stringMatching(/cannot connect to ws:\/\/127\.0\.0\.1:9/),
    });
    expect(result.search).toEqual({ sent: 1, ok: 1, failed: 0, skipped: 0 });
    expect(state.runs()).toEqual([{ runId: "run1", relay: "search", ok: 1, failed: 0 }]);
  });

  it("stops sending to a relay that drops the connection, and says so", async () => {
    const relay = await stub((_, ctx) => ctx.socket.terminate());
    writeSigned([item("osm-node-1"), item("osm-node-2"), item("osm-node-3")]);

    const result = await publish(config({ dcosl: relay.url }), state, runDir);

    expect(result.dcosl).toMatchObject({ sent: 1, ok: 0, failed: 1, skipped: 0 });
    expect(result.dcosl!.error).toMatch(/lost the connection to ws:\/\/127\.0\.0\.1:\d+\/? after 1 event/);
    expect(relay.received).toHaveLength(1);
    expect(state.runs()).toEqual([{ runId: "run1", relay: "dcosl", ok: 0, failed: 1 }]);
  });

  it("does not connect to a relay that already accepted every event", async () => {
    const relay = await stub(acceptAll);
    writeSigned([item("osm-node-1")]);
    const cfg = config({ dcosl: relay.url });
    await publish(cfg, state, runDir);
    expect(relay.connections).toBe(1);

    const again = await publish(cfg, state, runDir);

    expect(again).toEqual({ dcosl: { sent: 0, ok: 0, failed: 0, skipped: 1 } });
    expect(relay.connections).toBe(1);
  });

  describe("refuses before sending anything", () => {
    const other = generateSecretKey();
    const good = () => item("osm-node-1");
    const cases: [string, () => unknown[], RegExp][] = [
      ["a broken signature", () => [good(), { ...item("osm-node-2"), sig: "0".repeat(128) }], /line 2: .*signature/],
      ["a tampered tag", () => [{ ...good(), tags: [["d", "osm-node-1"], ["name", "Other"]] }], /line 1: .*signature/],
      ["another author", () => [item("osm-node-1", other)], /line 1: signed by [0-9a-f]{64}, not the curator/],
      [
        "a kind it does not publish",
        () => [good(), item("osm-node-2"), finalizeEvent({ kind: 39998, created_at: T, content: "", tags: [["d", "x"]] }, secret)],
        /line 3: kind 39998/,
      ],
      ["a line that is not JSON", () => [good(), "{nope"], /line 2: not valid JSON/],
      ["a line that is not an event", () => [{ kind: 39999 }], /line 1: not a nostr event/],
      ["an item without a d tag", () => [finalizeEvent({ kind: 39999, created_at: T, content: "", tags: [["z", COORD]] }, secret)], /line 1: .*d tag/],
      [
        "a deletion without an a tag for the curator's item",
        () => [finalizeEvent({ kind: 5, created_at: T, content: "", tags: [["e", "c".repeat(64)], ["k", "39999"]] }, secret)],
        /line 1: .*a tag/,
      ],
      ["the same event twice", () => { const ev = good(); return [ev, ev]; }, /line 2: repeats line 1/],
      ["an item after a deletion", () => [deletion("osm-node-9", ["d".repeat(64)]), good()], /line 2: .*after a deletion/],
    ];

    for (const [name, lines, message] of cases) {
      it(name, async () => {
        const relay = await stub(acceptAll);
        writeSigned(lines());
        const recordResult = vi.spyOn(state, "recordResult");

        await expect(publish(config({ dcosl: relay.url }), state, runDir)).rejects.toThrow(message);

        expect(relay.connections).toBe(0);
        expect(recordResult).not.toHaveBeenCalled();
      });
    }

    it("an unknown relay name", async () => {
      const relay = await stub(acceptAll);
      writeSigned([good()]);
      await expect(publish(config({ dcosl: relay.url }), state, runDir, ["dcosl", "nope"])).rejects.toThrow(
        /unknown relay "nope"; the relays are dcosl/,
      );
      expect(relay.connections).toBe(0);
      expect(state.runs()).toEqual([]);
    });

    it("a run that is not signed yet", async () => {
      await expect(publish(config({ dcosl: REFUSED }), state, runDir)).rejects.toThrow(/npm run sign/);
    });

    it("an empty signed.jsonl", async () => {
      writeSigned([]);
      await expect(publish(config({ dcosl: REFUSED }), state, runDir)).rejects.toThrow(/no events/);
    });
  });
});
