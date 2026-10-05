import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headerAuthor, loadConfig, type Config } from "../src/config.js";

const COORDINATE =
  "39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:food-and-drink-places";
const HEADER_AUTHOR = "b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450";

let dir: string;
let savedEnv: string | undefined;

/** Writes config.json with some fields overridden into the temp dir and returns its path. */
function tempConfig(overrides: Record<string, unknown>): string {
  const base = JSON.parse(readFileSync("config.json", "utf8")) as Record<string, unknown>;
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ ...base, ...overrides }));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mise-config-"));
  savedEnv = process.env.MISE_CONFIG;
  delete process.env.MISE_CONFIG;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MISE_CONFIG;
  else process.env.MISE_CONFIG = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads config.json and exposes the header coordinate", () => {
    const cfg = loadConfig();
    expect(cfg.headerCoordinate).toBe(COORDINATE);
  });

  it("rejects a malformed coordinate", () => {
    const path = tempConfig({ headerCoordinate: "39998:abc" });
    expect(() => loadConfig(path)).toThrow(/headerCoordinate/);
  });

  it("rejects a curatorPubkey that is not 64 hex chars", () => {
    const path = tempConfig({ curatorPubkey: "<throwaway pubkey>" });
    expect(() => loadConfig(path)).toThrow(/curatorPubkey/);
  });

  it("MISE_CONFIG selects the file", () => {
    process.env.MISE_CONFIG = tempConfig({ relays: { local: "ws://x" }, headerRelay: "local" });
    expect(loadConfig().relays).toEqual({ local: "ws://x" });
  });
});

describe("loadConfig field checks", () => {
  /** The message loadConfig throws for config.json with `overrides`; fails if it accepts. */
  function rejection(overrides: Record<string, unknown>): { path: string; message: string } {
    const path = tempConfig(overrides);
    try {
      loadConfig(path);
    } catch (err) {
      return { path, message: (err as Error).message };
    }
    throw new Error(`loadConfig accepted ${JSON.stringify(overrides)}`);
  }

  const base = () => JSON.parse(readFileSync("config.json", "utf8")) as Record<string, any>;

  it.each([
    ["relays missing", { relays: undefined }, "relays"],
    ["relays empty", { relays: {} }, "relays"],
    ["relays an array", { relays: ["wss://a"] }, "relays"],
    ["a relay that is not ws or wss", { relays: { dcosl: "https://dcosl.brainstorm.world" } }, "relays.dcosl"],
    ["a relay that is not a string", { relays: { dcosl: 7 } }, "relays.dcosl"],
    ["a relay that is not a URL", { relays: { dcosl: "wss://" } }, "relays.dcosl"],
    ["headerRelay not a relay name", { headerRelay: "nope" }, "headerRelay"],
    ["headerRelay missing", { headerRelay: undefined }, "headerRelay"],
    ["pilotSize missing", { pilotSize: undefined }, "pilotSize"],
    ["pilotSize zero", { pilotSize: 0 }, "pilotSize"],
    ["pilotSize fractional", { pilotSize: 1.5 }, "pilotSize"],
    ["pilotSize a string", { pilotSize: "150" }, "pilotSize"],
    ["deletionGuardFraction missing", { deletionGuardFraction: undefined }, "deletionGuardFraction"],
    ["deletionGuardFraction null", { deletionGuardFraction: null }, "deletionGuardFraction"],
    ["deletionGuardFraction negative", { deletionGuardFraction: -0.01 }, "deletionGuardFraction"],
    ["deletionGuardFraction above 1", { deletionGuardFraction: 1.5 }, "deletionGuardFraction"],
    ["deletionGuardFraction a string", { deletionGuardFraction: "0.02" }, "deletionGuardFraction"],
    ["publish missing", { publish: undefined }, "publish"],
    ["publish.eventsPerSecond zero", { publish: { eventsPerSecond: 0, okTimeoutMs: 10000 } }, "publish.eventsPerSecond"],
    ["publish.okTimeoutMs zero", { publish: { eventsPerSecond: 5, okTimeoutMs: 0 } }, "publish.okTimeoutMs"],
    ["publish.okTimeoutMs missing", { publish: { eventsPerSecond: 5 } }, "publish.okTimeoutMs"],
    ["paths missing", { paths: undefined }, "paths"],
    ["paths.data empty", { paths: { data: "", out: "out", state: "s.sqlite" } }, "paths.data"],
    ["paths.out missing", { paths: { data: "data", state: "s.sqlite" } }, "paths.out"],
    ["paths.state not a string", { paths: { data: "data", out: "out", state: 1 } }, "paths.state"],
    ["scope missing", { scope: undefined }, "scope"],
    ["scope.amenity missing", { scope: { shop: [], craft: [] } }, "scope.amenity"],
    ["scope.shop not an array", { scope: { amenity: [], shop: "bakery", craft: [] } }, "scope.shop"],
    ["scope.craft with a non-string", { scope: { amenity: [], shop: [], craft: ["brewery", 3] } }, "scope.craft"],
    ["btcmapFields missing", { btcmapFields: undefined }, "btcmapFields"],
    ["btcmapFields empty", { btcmapFields: [] }, "btcmapFields"],
    ["btcmapFields with a non-string", { btcmapFields: ["id", null] }, "btcmapFields"],
  ])("rejects %s, naming the field and the file", (_label, overrides, field) => {
    const { path, message } = rejection(overrides);
    expect(message).toContain(path);
    expect(message).toContain(`${field} `);
  });

  it("accepts deletionGuardFraction 0 and 1, and empty scope lists", () => {
    expect(loadConfig(tempConfig({ deletionGuardFraction: 0 })).deletionGuardFraction).toBe(0);
    expect(loadConfig(tempConfig({ deletionGuardFraction: 1 })).deletionGuardFraction).toBe(1);
    const scope = { amenity: [], shop: [], craft: ["brewery"] };
    expect(loadConfig(tempConfig({ scope })).scope).toEqual(scope);
  });

  it("names the file in a JSON syntax error", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, '{ "headerCoordinate": ');
    expect(() => loadConfig(path)).toThrow(path);
  });

  it("rejects a file that is not a JSON object", () => {
    const path = join(dir, "array.json");
    writeFileSync(path, "[]");
    expect(() => loadConfig(path)).toThrow(path);
  });

  it("keeps config.rehearsal.example.json valid apart from its placeholder pubkey", () => {
    const example = JSON.parse(readFileSync("config.rehearsal.example.json", "utf8")) as Record<string, unknown>;
    expect(example.curatorPubkey).toBe("<throwaway pubkey>");
    const path = join(dir, "rehearsal.json");
    writeFileSync(path, JSON.stringify({ ...example, curatorPubkey: "a".repeat(64) }));
    const cfg = loadConfig(path);
    expect(cfg.relays[cfg.headerRelay]).toMatch(/^ws:\/\/localhost:/);
    // Same scope and fields as the real config, so a rehearsal exercises the real mapping.
    expect(cfg.scope).toEqual(base().scope);
    expect(cfg.btcmapFields).toEqual(base().btcmapFields);
  });

  it("keeps every rehearsal path under state/rehearsal/, apart from the real data, out and state", () => {
    const example = JSON.parse(readFileSync("config.rehearsal.example.json", "utf8")) as Config;
    expect(example.paths).toEqual({
      data: "state/rehearsal/data",
      out: "state/rehearsal/out",
      state: "state/rehearsal/state.sqlite",
    });
    for (const path of Object.values(example.paths)) expect(path.startsWith("state/rehearsal/")).toBe(true);
    for (const key of ["data", "out", "state"] as const) expect(example.paths[key]).not.toBe(base().paths[key]);
    expect(example.relays).toEqual({ local: "ws://localhost:10547" });
  });
});

describe("headerAuthor", () => {
  it("extracts the pubkey", () => {
    const cfg = loadConfig();
    expect(headerAuthor(cfg.headerCoordinate)).toBe(HEADER_AUTHOR);
  });
});
