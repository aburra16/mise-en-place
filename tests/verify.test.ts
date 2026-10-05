import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verify, verifySummary, type RelayVerifyResult } from "../src/commands/verify.js";
import { loadConfig, type Config } from "../src/config.js";
import { openState, type State } from "../src/state.js";
import { startStubRelay, type StubRelay } from "./stub-relay.js";

// Relays here are stubs on loopback; NIP-11 is never fetched (the page size is injected).

const clean: RelayVerifyResult = {
  onRelay: 3,
  inState: 3,
  missing: [],
  extra: [],
  stale: [],
  extraCheck: "complete",
};

describe("verifySummary", () => {
  it("prints one line per relay and fails nothing when relays and state match", () => {
    expect(verifySummary({ dcosl: clean })).toEqual({
      lines: ["dcosl: on relay 3, in state 3, missing 0, extra 0, stale 0"],
      warnings: [],
      failed: [],
    });
  });

  it("warns about an incomplete extra check without failing the relay", () => {
    const summary = verifySummary({
      dcosl: { ...clean, extraCheck: "incomplete: more than 500 events share created_at 1700000000" },
    });
    expect(summary.warnings).toEqual([
      "dcosl: extra check incomplete: more than 500 events share created_at 1700000000",
    ]);
    expect(summary.failed).toEqual([]);
  });

  it("fails a relay with missing, extra or stale items, and lists them", () => {
    const summary = verifySummary({
      dcosl: { ...clean, missing: ["osm-node-1"] },
      search: { ...clean, extra: ["osm-node-2"], stale: ["osm-node-3"] },
      other: clean,
    });
    expect(summary.failed).toEqual(["dcosl", "search"]);
    expect(summary.lines).toEqual([
      "dcosl: on relay 3, in state 3, missing 1, extra 0, stale 0",
      "  missing: osm-node-1",
      "search: on relay 3, in state 3, missing 0, extra 1, stale 1",
      "  extra: osm-node-2",
      "  stale: osm-node-3",
      "other: on relay 3, in state 3, missing 0, extra 0, stale 0",
    ]);
  });

  it("fails a relay that could not be read", () => {
    const summary = verifySummary({
      dcosl: { ...clean, error: "cannot connect to ws://127.0.0.1:9 (connection failed)" },
    });
    expect(summary.lines).toEqual(["dcosl: cannot connect to ws://127.0.0.1:9 (connection failed)"]);
    expect(summary.failed).toEqual(["dcosl"]);
  });

  it("lists at most 20 values, then how many more", () => {
    const missing = Array.from({ length: 23 }, (_, i) => `d${i}`);
    const { lines } = verifySummary({ dcosl: { ...clean, missing } });
    expect(lines[1]).toBe(`  missing: ${missing.slice(0, 20).join(", ")} and 3 more`);
  });
});

describe("verify", () => {
  const secret = generateSecretKey();
  let state: State;
  let stubs: StubRelay[];

  beforeEach(() => {
    state = openState(":memory:");
    stubs = [];
  });

  afterEach(async () => {
    state.close();
    for (const s of stubs) await s.close();
  });

  it("reports an error instead of a missing item when a #d batch comes back full", async () => {
    const base = loadConfig("config.json");
    // A relay that keeps old versions: every REQ is answered with `limit` versions of one item.
    const relay = await startStubRelay(
      () => {},
      (filters, ctx) => {
        const limit = filters[0]!.limit as number;
        for (let i = 0; i < limit; i++) {
          ctx.send(
            finalizeEvent(
              {
                kind: 39999,
                created_at: 1_700_000_000 - i,
                content: "",
                tags: [["d", "osm-node-1"], ["z", base.headerCoordinate]],
              },
              secret,
            ),
          );
        }
        ctx.eose();
      },
    );
    stubs.push(relay);
    const cfg: Config = { ...base, curatorPubkey: getPublicKey(secret), relays: { dcosl: relay.url }, headerRelay: "dcosl" };
    for (const d of ["osm-node-1", "osm-node-2", "osm-node-3"]) state.markLive(d, "h", "[]", "a".repeat(64), 1);

    const result = await verify(cfg, state, { pageSize: 3 });

    expect(result.dcosl!.error).toMatch(/full page.*cannot tell/);
    expect(result.dcosl!.missing).toEqual([]);
  });
});
