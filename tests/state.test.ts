import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openState, type State } from "../src/state.js";

const DCOSL = "wss://dcosl.brainstorm.world";
const SEARCH = "wss://search.brainstorm.world";

let state: State;

beforeEach(() => {
  state = openState(":memory:");
});

afterEach(() => {
  state.close();
});

/** A recordResult argument with sensible defaults, so each test names only what it cares about. */
function result(over: Partial<Parameters<State["recordResult"]>[0]> = {}) {
  return {
    eventId: "e1",
    d: "osm-node-1",
    kind: 39999,
    createdAt: 1000,
    runId: "run-1",
    relay: DCOSL,
    ok: true,
    message: "",
    ...over,
  };
}

describe("items", () => {
  it("markLive then liveItems returns it", () => {
    state.markLive("osm-node-1", "hash-a", '[["d","osm-node-1"]]', "e1", 100);

    expect(state.liveItems()).toEqual(
      new Map([
        [
          "osm-node-1",
          {
            d: "osm-node-1",
            contentHash: "hash-a",
            tagsJson: '[["d","osm-node-1"]]',
            latestEventId: "e1",
          },
        ],
      ]),
    );
  });

  it("starts with no live items", () => {
    expect(state.liveItems().size).toBe(0);
  });

  it("markLive again replaces hash and latestEventId, while versionsOf keeps both ids", () => {
    state.recordResult(result({ eventId: "e1", createdAt: 1000 }));
    state.markLive("osm-node-1", "hash-a", "[1]", "e1", 100);
    state.recordResult(result({ eventId: "e2", createdAt: 2000 }));
    state.markLive("osm-node-1", "hash-b", "[2]", "e2", 200);

    const live = state.liveItems();
    expect(live.size).toBe(1);
    expect(live.get("osm-node-1")).toEqual({
      d: "osm-node-1",
      contentHash: "hash-b",
      tagsJson: "[2]",
      latestEventId: "e2",
    });
    expect(state.versionsOf("osm-node-1")).toEqual(["e1", "e2"]);
  });

  it("markDeleted removes from liveItems, and versionsOf is unchanged", () => {
    state.recordResult(result({ eventId: "e1" }));
    state.markLive("osm-node-1", "hash-a", "[1]", "e1", 100);
    state.markLive("osm-node-2", "hash-b", "[2]", "e9", 100);

    state.markDeleted("osm-node-1", 300);

    expect([...state.liveItems().keys()]).toEqual(["osm-node-2"]);
    expect(state.versionsOf("osm-node-1")).toEqual(["e1"]);
  });

  it("markLive after markDeleted brings the item back", () => {
    state.markLive("osm-node-1", "hash-a", "[1]", "e1", 100);
    state.markDeleted("osm-node-1", 200);
    state.markLive("osm-node-1", "hash-c", "[3]", "e3", 300);

    expect(state.liveItems().get("osm-node-1")?.latestEventId).toBe("e3");
  });

  it("markDeleted on an unknown d does nothing", () => {
    state.markDeleted("osm-node-404", 100);

    expect(state.liveItems().size).toBe(0);
  });
});

describe("events", () => {
  it("acceptedOn is true only for ok=true results on that relay", () => {
    state.recordResult(result({ eventId: "e1", relay: DCOSL, ok: true }));
    state.recordResult(result({ eventId: "e1", relay: SEARCH, ok: false, message: "blocked: no" }));
    state.recordResult(result({ eventId: "e2", relay: DCOSL, ok: false, message: "rate-limited" }));

    expect(state.acceptedOn("e1", DCOSL)).toBe(true);
    expect(state.acceptedOn("e1", SEARCH)).toBe(false);
    expect(state.acceptedOn("e2", DCOSL)).toBe(false);
    expect(state.acceptedOn("e2", SEARCH)).toBe(false);
    expect(state.acceptedOn("never-seen", DCOSL)).toBe(false);
  });

  it("acceptedAnywhere is true once any relay has accepted the event", () => {
    state.recordResult(result({ eventId: "e1", relay: SEARCH, ok: false, message: "pending" }));
    expect(state.acceptedAnywhere("e1")).toBe(false);

    state.recordResult(result({ eventId: "e1", relay: DCOSL, ok: true }));
    expect(state.acceptedAnywhere("e1")).toBe(true);
    expect(state.acceptedAnywhere("never-seen")).toBe(false);
  });

  it("recording the same event and relay again updates ok instead of adding a row", () => {
    state.recordResult(result({ eventId: "e1", relay: DCOSL, ok: false, message: "timeout", runId: "run-1" }));
    state.recordResult(result({ eventId: "e1", relay: DCOSL, ok: true, message: "", runId: "run-2" }));

    expect(state.acceptedOn("e1", DCOSL)).toBe(true);
    expect(state.versionsOf("osm-node-1")).toEqual(["e1"]);
    expect(state.runs()).toEqual([{ runId: "run-2", relay: DCOSL, ok: 1, failed: 0 }]);
  });

  it("a later failure overwrites an earlier acceptance of the same pair", () => {
    state.recordResult(result({ eventId: "e1", ok: true }));
    state.recordResult(result({ eventId: "e1", ok: false, message: "dropped" }));

    expect(state.acceptedOn("e1", DCOSL)).toBe(false);
  });

  it("versionsOf lists distinct kind 39999 ids across relays, ok or not, oldest first", () => {
    state.recordResult(result({ eventId: "bb", createdAt: 2000, relay: DCOSL }));
    state.recordResult(result({ eventId: "bb", createdAt: 2000, relay: SEARCH, ok: false, message: "x" }));
    state.recordResult(result({ eventId: "aa", createdAt: 2000, relay: DCOSL }));
    state.recordResult(result({ eventId: "zz", createdAt: 1000, relay: SEARCH, ok: false, message: "x" }));
    state.recordResult(result({ eventId: "del", kind: 5, createdAt: 500, relay: DCOSL }));
    state.recordResult(result({ eventId: "other", d: "osm-node-2", createdAt: 100, relay: DCOSL }));

    expect(state.versionsOf("osm-node-1")).toEqual(["zz", "aa", "bb"]);
    expect(state.versionsOf("osm-node-2")).toEqual(["other"]);
    expect(state.versionsOf("osm-node-3")).toEqual([]);
  });

  it("versionsOf returns an id once even if relays were told different created_at values", () => {
    state.recordResult(result({ eventId: "e1", createdAt: 1000, relay: DCOSL }));
    state.recordResult(result({ eventId: "e1", createdAt: 1001, relay: SEARCH }));

    expect(state.versionsOf("osm-node-1")).toEqual(["e1"]);
  });

  it("runs aggregates ok and failed per run and relay", () => {
    state.recordResult(result({ eventId: "e1", runId: "run-1", relay: DCOSL, ok: true }));
    state.recordResult(result({ eventId: "e2", runId: "run-1", relay: DCOSL, ok: true }));
    state.recordResult(result({ eventId: "e3", runId: "run-1", relay: DCOSL, ok: false, message: "x" }));
    state.recordResult(result({ eventId: "e1", runId: "run-1", relay: SEARCH, ok: false, message: "x" }));
    state.recordResult(result({ eventId: "e4", runId: "run-2", relay: SEARCH, ok: true }));

    expect(state.runs()).toEqual([
      { runId: "run-1", relay: DCOSL, ok: 2, failed: 1 },
      { runId: "run-1", relay: SEARCH, ok: 0, failed: 1 },
      { runId: "run-2", relay: SEARCH, ok: 1, failed: 0 },
    ]);
  });

  it("runs is empty before anything is recorded", () => {
    expect(state.runs()).toEqual([]);
  });
});

describe("openState on a file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mise-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the missing parent directories", () => {
    const path = join(dir, "nested", "state", "state.sqlite");

    const s = openState(path);
    s.close();

    expect(statSync(join(dir, "nested", "state")).isDirectory()).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
  });

  it("keeps data when the same file is reopened", () => {
    const path = join(dir, "state", "state.sqlite");

    const first = openState(path);
    first.recordResult(result({ eventId: "e1" }));
    first.markLive("osm-node-1", "hash-a", "[1]", "e1", 100);
    first.close();

    const second = openState(path);
    try {
      expect(second.liveItems().get("osm-node-1")?.contentHash).toBe("hash-a");
      expect(second.versionsOf("osm-node-1")).toEqual(["e1"]);
      expect(second.acceptedOn("e1", DCOSL)).toBe(true);
    } finally {
      second.close();
    }
  });

  it("uses WAL for a file database", () => {
    const path = join(dir, "state.sqlite");
    openState(path).close();

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      raw.close();
    }
  });

  it("sets first_seen once and moves last_changed on every markLive and markDeleted", () => {
    const path = join(dir, "state.sqlite");
    const s = openState(path);
    s.markLive("osm-node-1", "hash-a", "[1]", "e1", 100);
    s.markLive("osm-node-1", "hash-b", "[2]", "e2", 200);
    s.markDeleted("osm-node-1", 300);
    s.close();

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT * FROM items WHERE d = ?").get("osm-node-1")).toEqual({
        d: "osm-node-1",
        status: "deleted",
        content_hash: "hash-b",
        tags_json: "[2]",
        latest_event_id: "e2",
        first_seen: 100,
        last_changed: 300,
      });
    } finally {
      raw.close();
    }
  });

  it("rejects a status other than live or deleted", () => {
    const path = join(dir, "state.sqlite");
    openState(path).close();

    const raw = new Database(path);
    try {
      expect(() =>
        raw
          .prepare("INSERT INTO items VALUES ('d', 'gone', 'h', '[]', 'e', 1, 1)")
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      raw.close();
    }
  });
});
