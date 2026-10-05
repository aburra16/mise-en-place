import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
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

  /**
   * Runs the CLI with a temp config (config.json with relays on loopback, paths in the temp
   * dir, then `overrides`). No network. `MISE_KEY_FILE` points into the temp dir unless `env`
   * says otherwise, so no test can reach the real key file.
   */
  function cliEnv(overrides: Record<string, unknown>, env: Record<string, string>, ...args: string[]) {
    const base = JSON.parse(readFileSync("config.json", "utf8")) as Record<string, unknown>;
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ...base,
        relays: { dcosl: "ws://127.0.0.1:9", search: "ws://127.0.0.1:9" },
        paths: { data: join(dir, "data"), out: join(dir, "out"), state: join(dir, "state.sqlite") },
        ...overrides,
      }),
    );
    return spawnSync("node_modules/.bin/tsx", ["src/cli.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, MISE_KEY_FILE: join(dir, "absent.key"), ...env, MISE_CONFIG: configPath },
    });
  }

  const cliWith = (overrides: Record<string, unknown>, ...args: string[]) => cliEnv(overrides, {}, ...args);
  const cli = (...args: string[]) => cliWith({}, ...args);

  it("exits non-zero with a usage line for an unknown command", () => {
    const res = cli("frobnicate");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/usage: .*fetch.*census.*build.*sign/);
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

  it("build --pilot with no pilotSize in the config stops instead of running a full build", () => {
    const res = cliWith({ pilotSize: undefined }, "build", "--pilot");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/pilotSize must be a positive integer/);
  });

  it("build with no deletionGuardFraction in the config stops", () => {
    const res = cliWith({ deletionGuardFraction: undefined }, "build");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/deletionGuardFraction must be/);
  });

  it("build stops without a cache before touching the network", () => {
    const res = cli("build", "--pilot");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/npm run fetch/);
  });

  describe("sign", () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const hexSecret = bytesToHex(secret);
    const keyFile = () => join(dir, "curator.key");
    const runDir = () => join(dir, "out", "run1");
    const unsigned = [
      { kind: 39999, tags: [["d", "osm-node-1"], ["name", "Taco Spot"]], content: "" },
      { kind: 5, tags: [["e", "a".repeat(64)], ["k", "39999"]], content: "" },
    ];

    function setUp(keyText: string, mode = 0o600) {
      writeFileSync(keyFile(), `${keyText}\n`);
      chmodSync(keyFile(), mode);
      mkdirSync(runDir(), { recursive: true });
      writeFileSync(join(runDir(), "unsigned.jsonl"), unsigned.map((e) => `${JSON.stringify(e)}\n`).join(""));
    }

    const signCli = (...args: string[]) =>
      cliEnv({ curatorPubkey: pubkey }, { MISE_KEY_FILE: keyFile() }, "sign", ...args);

    function expectNoSecret(text: string) {
      expect(text).not.toContain("nsec1");
      expect(text).not.toContain("ncryptsec1");
      expect(text).not.toContain(hexSecret);
    }

    it("signs a run, then prints the pubkey in hex and npub and the count, with no secret", () => {
      setUp(nip19.nsecEncode(secret));
      const res = signCli("run1");
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(pubkey);
      expect(res.stdout).toContain(nip19.npubEncode(pubkey));
      expect(res.stdout).toMatch(/signed 2 events/);
      expectNoSecret(res.stdout);
      const events = readFileSync(join(runDir(), "signed.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as Event);
      expect(events).toHaveLength(2);
      expect(events.every((e) => verifyEvent(e) && e.pubkey === pubkey)).toBe(true);
    });

    it("needs exactly one run id", () => {
      setUp(nip19.nsecEncode(secret));
      for (const args of [[], ["run1", "run2"]]) {
        const res = signCli(...args);
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/usage: npm run sign -- <runId>/);
      }
      expect(existsSync(join(runDir(), "signed.jsonl"))).toBe(false);
    });

    it("refuses a run id that is not a plain directory name", () => {
      setUp(nip19.nsecEncode(secret));
      for (const id of ["../out/run1", "out/run1", "..", "/abs/run1"]) {
        const res = signCli(id);
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/plain directory name/);
      }
    });

    it("refuses an option it does not take", () => {
      setUp(nip19.nsecEncode(secret));
      const res = signCli("run1", "--pilot");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/sign does not take --pilot/);
    });

    it("refuses a key file that others can read, without the secret in the output", () => {
      setUp(nip19.nsecEncode(secret), 0o644);
      const res = signCli("run1");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/mode.*chmod 600/s);
      expectNoSecret(res.stderr + res.stdout);
      expect(existsSync(join(runDir(), "signed.jsonl"))).toBe(false);
    });

    it("stops for an ncryptsec when there is no terminal, with no secret in the output", () => {
      setUp(nip49.encrypt(secret, "correct horse battery staple", 2));
      const res = signCli("run1");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/ncryptsec needs an interactive terminal: run npm run sign yourself/);
      expectNoSecret(res.stderr + res.stdout);
      expect(res.stderr + res.stdout).not.toContain("correct horse");
      expect(existsSync(join(runDir(), "signed.jsonl"))).toBe(false);
    });

    it("names MISE_KEY_FILE when the key file is missing", () => {
      mkdirSync(runDir(), { recursive: true });
      writeFileSync(join(runDir(), "unsigned.jsonl"), `${JSON.stringify(unsigned[0])}\n`);
      const res = signCli("run1");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/MISE_KEY_FILE/);
    });
  });
});
