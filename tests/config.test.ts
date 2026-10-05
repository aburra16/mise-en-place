import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headerAuthor, loadConfig } from "../src/config.js";

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
    process.env.MISE_CONFIG = tempConfig({ relays: { local: "ws://x" } });
    expect(loadConfig().relays).toEqual({ local: "ws://x" });
  });
});

describe("headerAuthor", () => {
  it("extracts the pubkey", () => {
    const cfg = loadConfig();
    expect(headerAuthor(cfg.headerCoordinate)).toBe(HEADER_AUTHOR);
  });
});
