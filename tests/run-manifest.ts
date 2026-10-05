import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../src/config.js";

type Identity = Pick<Config, "headerCoordinate" | "curatorPubkey" | "relays"> & { paths: Pick<Config["paths"], "state"> };

/**
 * Writes `<runDir>/manifest.json` with the config block `build` records for `cfg`, then
 * `over` on top of it, so a test can stand in for a run built with another config.
 */
export function writeManifest(runDir: string, cfg: Identity, over: Record<string, unknown> = {}): void {
  mkdirSync(runDir, { recursive: true });
  const config = {
    headerCoordinate: cfg.headerCoordinate,
    curatorPubkey: cfg.curatorPubkey,
    relays: cfg.relays,
    statePath: cfg.paths.state,
    ...over,
  };
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify({ runId: basename(runDir), config }, null, 2)}\n`);
}
