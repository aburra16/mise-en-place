import * as nip19 from "nostr-tools/nip19";
import { givenOptions, parseArgs, type CliArgs } from "./args.js";
import { build, runDirFor } from "./commands/build.js";
import { census } from "./commands/census.js";
import { rebroadcastHeader } from "./commands/header-rebroadcast.js";
import { publish, type RelayPublishResult } from "./commands/publish.js";
import { sign } from "./commands/sign.js";
import { verify, verifySummary, type RelayVerifyResult } from "./commands/verify.js";
import { loadConfig } from "./config.js";
import { startConsole } from "./console/server.js";
import { fetchPlaces, latestCachePath } from "./source/btcmap.js";
import { openState } from "./state.js";

type Command = (args: CliArgs) => Promise<void>;

/** Refuses any option outside `allowed`. */
function allowOptions(name: string, args: CliArgs, allowed: string[] = []): void {
  const refused = givenOptions(args).filter((o) => !allowed.includes(o));
  if (refused.length > 0) throw new Error(`${name} does not take ${refused.join(", ")}`);
}

/** Refuses positional arguments and any option outside `allowed`. */
function only(name: string, args: CliArgs, allowed: string[] = []): void {
  if (args.positional.length > 0) throw new Error(`${name} takes no arguments, got ${args.positional.join(" ")}`);
  allowOptions(name, args, allowed);
}

/** Commands by script name. */
const commands = new Map<string, Command>([
  [
    "fetch",
    async (args) => {
      only("fetch", args);
      const { path, count } = await fetchPlaces(loadConfig());
      console.log(`wrote ${count} places to ${path}`);
    },
  ],
  [
    "census",
    async (args) => {
      only("census", args);
      const cfg = loadConfig();
      const path = latestCachePath(cfg);
      if (path === null) throw new Error("no cache yet; run npm run fetch first");
      process.stdout.write(census(cfg, path));
    },
  ],
  [
    "build",
    async (args) => {
      only("build", args, ["--pilot", "--filter", "--allow-deletions", "--first-run"]);
      const cfg = loadConfig();
      const state = openState(cfg.paths.state);
      try {
        const r = await build(cfg, state, {
          pilot: args.pilot === "default" ? cfg.pilotSize : args.pilot,
          filter: args.filter,
          allowDeletions: args.allowDeletions,
          firstRun: args.firstRun,
        });
        const skipped = Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(", ");
        console.log(`wrote ${r.runDir}`);
        console.log(
          `created ${r.created}, changed ${r.changed}, unchanged ${r.unchanged}, deletions ${r.deletions}`,
        );
        console.log(`skipped: ${skipped}`);
        if (r.duplicates.length > 0) console.log(`duplicate osm ids: ${r.duplicates.join(", ")}`);
        if (r.held.length > 0) console.log(`held (malformed, never deleted): ${r.held.join(", ")}`);
        console.log(`review ${r.runDir}/report.md before signing`);
      } finally {
        state.close();
      }
    },
  ],
  [
    "sign",
    async (args) => {
      allowOptions("sign", args);
      const [runId, ...extra] = args.positional;
      if (runId === undefined || extra.length > 0) throw new Error("usage: npm run sign -- <runId>");
      const cfg = loadConfig();
      const runDir = runDirFor(cfg, runId);
      const r = await sign(cfg, runDir);
      console.log(`signed ${r.signed} events into ${runDir}/signed.jsonl`);
      console.log(`signer pubkey ${r.pubkey}`);
      console.log(`signer npub   ${nip19.npubEncode(r.pubkey)}`);
    },
  ],
  [
    "publish",
    async (args) => {
      allowOptions("publish", args, ["--relays"]);
      const [runId, ...extra] = args.positional;
      if (runId === undefined || extra.length > 0) {
        throw new Error("usage: npm run publish -- <runId> [--relays a,b]");
      }
      const cfg = loadConfig();
      const runDir = runDirFor(cfg, runId);
      const state = openState(cfg.paths.state);
      let results: Record<string, RelayPublishResult>;
      try {
        results = await publish(cfg, state, runDir, args.relays);
      } finally {
        state.close();
      }
      for (const [name, r] of Object.entries(results)) {
        const line = `${name}: sent ${r.sent}, ok ${r.ok}, failed ${r.failed}, skipped ${r.skipped}`;
        console.log(r.error === undefined ? line : `${line}; ${r.error}`);
      }
      const short = Object.entries(results)
        .filter(([, r]) => r.failed > 0 || r.error !== undefined)
        .map(([name]) => name);
      if (short.length > 0) {
        throw new Error(`not every event was accepted on ${short.join(", ")}; run publish again to retry the rest`);
      }
    },
  ],
  [
    "verify",
    async (args) => {
      only("verify", args);
      const cfg = loadConfig();
      const state = openState(cfg.paths.state);
      let results: Record<string, RelayVerifyResult>;
      try {
        results = await verify(cfg, state);
      } finally {
        state.close();
      }
      const { lines, warnings, failed } = verifySummary(results);
      for (const line of lines) console.log(line);
      for (const warning of warnings) console.warn(`warning: ${warning}`);
      if (failed.length > 0) throw new Error(`relays and state do not match on ${failed.join(", ")}`);
    },
  ],
  [
    "header:rebroadcast",
    async (args) => {
      allowOptions("header:rebroadcast", args);
      const [name, ...extra] = args.positional;
      if (name === undefined || extra.length > 0) {
        throw new Error("usage: npm run header:rebroadcast -- <relayName>");
      }
      const r = await rebroadcastHeader(loadConfig(), name);
      if (!r.ok) throw new Error(`${name} refused header ${r.eventId}: ${r.message}`);
      console.log(`copied header ${r.eventId} to ${name}${r.message === "" ? "" : ` (${r.message})`}`);
    },
  ],
  [
    "console",
    async (args) => {
      only("console", args, ["--port"]);
      const cfg = loadConfig();
      const state = openState(cfg.paths.state);
      try {
        const server = await startConsole(cfg, state, args.port);
        try {
          console.log(`console at ${server.url} (read-only; Ctrl-C to stop)`);
          await new Promise<void>((resolve) => {
            process.once("SIGINT", resolve);
            process.once("SIGTERM", resolve);
          });
        } finally {
          await server.close();
        }
      } finally {
        state.close();
      }
    },
  ],
]);

const USAGE = `usage: npm run <${[...commands.keys()].join("|")}> -- [options]`;

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : commands.get(name);
  if (command === undefined) {
    console.error(name === undefined ? "no command given" : `unknown command: ${name}`);
    console.error(USAGE);
    return 2;
  }
  try {
    await command(parseArgs(rest));
    return 0;
  } catch (err) {
    console.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
