import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { writeManifest } from "./run-manifest.js";

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

  it("takes --first-run as a flag", () => {
    expect(parseArgs(["--first-run", "--pilot"])).toEqual({
      positional: [],
      pilot: "default",
      allowDeletions: false,
      firstRun: true,
    });
    expect(parseArgs([]).firstRun).toBeUndefined();
  });

  it("splits --relays on commas", () => {
    expect(parseArgs(["--relays", "dcosl, search"]).relays).toEqual(["dcosl", "search"]);
    expect(() => parseArgs(["--relays"])).toThrow(/--relays/);
  });

  it("takes --port with a number from 0 to 65535", () => {
    expect(parseArgs(["--port", "4517"]).port).toBe(4517);
    expect(parseArgs(["--port", "0"]).port).toBe(0);
    expect(parseArgs([]).port).toBeUndefined();
    expect(() => parseArgs(["--port"])).toThrow(/--port/);
    for (const bad of ["abc", "-1", "65536", "80.5", ""]) {
      expect(() => parseArgs(["--port", bad])).toThrow(/--port/);
    }
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

  /** The manifest.json build would write into `runDir` for the config cliEnv writes, curated by `curatorPubkey`. */
  function manifestFor(runDir: string, curatorPubkey: string): void {
    const base = JSON.parse(readFileSync("config.json", "utf8")) as { headerCoordinate: string };
    writeManifest(runDir, {
      headerCoordinate: base.headerCoordinate,
      curatorPubkey,
      relays: { dcosl: "ws://127.0.0.1:9", search: "ws://127.0.0.1:9" },
      paths: { state: join(dir, "state.sqlite") },
    });
  }
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

  it("build on an empty state stops without --first-run, before touching the network", () => {
    const place15 = JSON.parse(readFileSync("tests/fixtures/place-15.json", "utf8")) as unknown;
    mkdirSync(join(dir, "data", "cache"), { recursive: true });
    writeFileSync(join(dir, "data", "cache", "places-2026-10-05.json"), JSON.stringify([place15]));
    const res = cli("build", "--pilot");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/^build: state .*state\.sqlite holds no items, live or deleted/);
    expect(res.stderr).toMatch(/--first-run/);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("only build takes --first-run", () => {
    for (const command of ["census", "sign", "publish", "verify"]) {
      const res = cli(command, "--first-run");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(`${command} does not take --first-run`);
    }
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
      manifestFor(runDir(), pubkey);
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
      manifestFor(runDir(), pubkey);
      writeFileSync(join(runDir(), "unsigned.jsonl"), `${JSON.stringify(unsigned[0])}\n`);
      const res = signCli("run1");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/MISE_KEY_FILE/);
    });
  });

  describe("publish, verify and header:rebroadcast", () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const runDir = () => join(dir, "out", "run1");

    /** A signed run of one item by `secret`, built for a config whose curator is `curator`. */
    function signedRun(curator = pubkey) {
      mkdirSync(runDir(), { recursive: true });
      manifestFor(runDir(), curator);
      const coord = (JSON.parse(readFileSync("config.json", "utf8")) as { headerCoordinate: string }).headerCoordinate;
      const tags = [["d", "osm-node-1"], ["z", coord]];
      const ev = finalizeEvent({ kind: 39999, created_at: 1_700_000_000, content: "", tags }, secret);
      writeFileSync(join(runDir(), "signed.jsonl"), `${JSON.stringify(ev)}\n`);
    }

    const run = (...args: string[]) => cliWith({ curatorPubkey: pubkey }, ...args);

    it("are listed in the usage line", () => {
      expect(cli().stderr).toMatch(/usage: .*publish.*verify.*header:rebroadcast/);
    });

    it("publish needs exactly one run id and takes only --relays", () => {
      for (const args of [[], ["run1", "run2"]]) {
        const res = run("publish", ...args);
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/usage: npm run publish -- <runId> \[--relays a,b\]/);
      }
      const res = run("publish", "run1", "--pilot");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/publish does not take --pilot/);
    });

    it("publish refuses a relay name the config does not have", () => {
      signedRun();
      const res = run("publish", "run1", "--relays", "dcosl,nope");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/unknown relay "nope"/);
    });

    it("publish reports a relay it cannot reach and exits non-zero", () => {
      signedRun();
      const res = run("publish", "run1", "--relays", "dcosl");
      expect(res.status).not.toBe(0);
      expect(res.stdout).toMatch(/^dcosl: sent 0, ok 0, failed 0, skipped 0; cannot connect to ws:\/\/127\.0\.0\.1:9/);
      expect(res.stderr).toMatch(/publish: .*dcosl/);
    });

    it("publish refuses a run signed by someone else before connecting", () => {
      signedRun("b".repeat(64));
      const res = cliWith({ curatorPubkey: "b".repeat(64) }, "publish", "run1");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/signed\.jsonl line 1: signed by [0-9a-f]{64}, not the curator/);
      expect(res.stdout).toBe("");
    });

    it("verify takes no arguments and reports a relay it cannot reach", () => {
      expect(run("verify", "run1").stderr).toMatch(/verify takes no arguments/);
      const res = run("verify");
      expect(res.status).not.toBe(0);
      expect(res.stdout).toMatch(/dcosl: cannot connect to ws:\/\/127\.0\.0\.1:9/);
    });

    it("header:rebroadcast needs one known relay name", () => {
      for (const args of [[], ["search", "dcosl"]]) {
        const res = run("header:rebroadcast", ...args);
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/usage: npm run header:rebroadcast -- <relayName>/);
      }
      const res = run("header:rebroadcast", "nope");
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/unknown relay "nope"/);
    });
  });
});
