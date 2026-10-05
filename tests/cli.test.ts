import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("defaults to no options", () => {
    expect(parseArgs([])).toEqual({ positional: [], allowDeletions: false });
  });

  it("takes --pilot with or without a size", () => {
    expect(parseArgs(["--pilot"]).pilot).toBe("default");
    expect(parseArgs(["--pilot", "20"]).pilot).toBe(20);
    expect(parseArgs(["--pilot", "--allow-deletions"])).toEqual({
      positional: [],
      pilot: "default",
      allowDeletions: true,
    });
  });

  it("refuses a pilot size of 0", () => {
    expect(() => parseArgs(["--pilot", "0"])).toThrow(/--pilot/);
  });

  it("collects repeated --filter key=value pairs", () => {
    expect(parseArgs(["--filter", "country=US", "--filter", "category=cafe"]).filter).toEqual({
      country: "US",
      category: "cafe",
    });
  });

  it("refuses a --filter without key=value, or a key given twice", () => {
    expect(() => parseArgs(["--filter"])).toThrow(/key=value/);
    expect(() => parseArgs(["--filter", "country"])).toThrow(/key=value/);
    expect(() => parseArgs(["--filter", "=US"])).toThrow(/key=value/);
    expect(() => parseArgs(["--filter", "country=US", "--filter", "country=CA"])).toThrow(/twice/);
  });

  it("splits --relays on commas", () => {
    expect(parseArgs(["--relays", "dcosl, search"]).relays).toEqual(["dcosl", "search"]);
    expect(() => parseArgs(["--relays"])).toThrow(/--relays/);
  });

  it("keeps positional arguments and refuses unknown options", () => {
    expect(parseArgs(["out/r1"]).positional).toEqual(["out/r1"]);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option --bogus/);
  });
});

describe("cli", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mise-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the CLI with a temp config whose paths point into the temp dir. No network. */
  function cli(...args: string[]) {
    const base = JSON.parse(readFileSync("config.json", "utf8")) as Record<string, unknown>;
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ...base,
        relays: { dcosl: "ws://127.0.0.1:9", search: "ws://127.0.0.1:9" },
        paths: { data: join(dir, "data"), out: join(dir, "out"), state: join(dir, "state.sqlite") },
      }),
    );
    return spawnSync("node_modules/.bin/tsx", ["src/cli.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, MISE_CONFIG: configPath },
    });
  }

  it("exits non-zero with a usage line for an unknown command", () => {
    const res = cli("frobnicate");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/usage: .*fetch.*census.*build/);
  });

  it("exits non-zero with a usage line for no command", () => {
    const res = cli();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/usage:/);
  });

  it("refuses an option the command does not take", () => {
    const res = cli("census", "--pilot");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/census does not take --pilot/);
  });

  it("census prints markdown for the latest cache", () => {
    const place15 = JSON.parse(readFileSync("tests/fixtures/place-15.json", "utf8")) as unknown;
    mkdirSync(join(dir, "data", "cache"), { recursive: true });
    writeFileSync(join(dir, "data", "cache", "places-2026-10-05.json"), JSON.stringify([place15]));
    const res = cli("census");
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("In scope: 1");
  });

  it("build stops without a cache before touching the network", () => {
    const res = cli("build", "--pilot");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/npm run fetch/);
  });
});
