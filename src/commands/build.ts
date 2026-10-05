import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NostrEvent } from "nostr-tools/core";
import { buildCatalog, type Catalog } from "../catalog.js";
import { readSearch, type Config } from "../config.js";
import { deletionFor, type Unsigned } from "../deletion.js";
import { diffItems } from "../diff.js";
import { checkHeader, fetchHeader } from "../header.js";
import { tagValue, type Tags } from "../item.js";
import { configIdentity } from "../manifest.js";
import { bullets, codeSpan, coverageTable, duplicateList, samples, table } from "../markdown.js";
import { selectPilot } from "../pilot.js";
import { latestCachePath, readCache } from "../source/btcmap.js";
import type { LiveItem, State } from "../state.js";

export interface BuildOptions {
  /** Build only this many items, chosen by `selectPilot`. Never emits deletions. */
  pilot?: number;
  /** `country` and/or `category`, matched case-insensitively. Never emits deletions. */
  filter?: Record<string, string>;
  /** Let deletions past the guard (`deletionGuardFraction` of live items) through. */
  allowDeletions?: boolean;
  /** Allow a state that holds no items, live or deleted: the very first import only. */
  firstRun?: boolean;
  /** Defaults to `YYYYMMDDTHHMMSSZ` (UTC), plus `-pilot` for a pilot build. */
  runId?: string;
  /** The header event; when absent it is read from `cfg.headerRelay`. Tests inject it. */
  header?: NostrEvent;
}

export interface BuildResult {
  runDir: string;
  created: number;
  changed: number;
  unchanged: number;
  deletions: number;
  skipped: Record<string, number>;
  /** OSM ids that more than one BTC Map place carried; the lowest `btcmap-id` was kept. */
  duplicates: string[];
  /** `d` of each malformed record that still names its place: never deleted, sorted. */
  held: string[];
}

const ITEM_KIND = 39999;
const FILTER_KEYS = ["country", "category"];
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `<paths.out>/<runId>`. A run id is a plain directory name: it cannot be empty, hold a
 * separator, or start with a dot, so it can never point outside `paths.out`.
 */
export function runDirFor(cfg: Config, runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`run id "${runId}" must be a plain directory name`);
  return join(cfg.paths.out, runId);
}

/** `2026-10-05T16:22:33.123Z` becomes `20261005T162233Z`. */
function timestampId(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/**
 * The guard must never fail open: `gone > NaN` is false, so a missing fraction would let
 * every deletion through. loadConfig checks this too; build does not rely on it.
 */
function checkGuard(cfg: Config): void {
  const f: unknown = cfg.deletionGuardFraction;
  if (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > 1) {
    throw new Error(`deletionGuardFraction must be a number from 0 to 1, got ${String(f)}`);
  }
}

function checkOptions(opts: BuildOptions): void {
  if (opts.pilot !== undefined && !(Number.isInteger(opts.pilot) && opts.pilot > 0)) {
    throw new Error(`pilot must be a positive integer, got ${opts.pilot}`);
  }
  for (const [key, value] of Object.entries(opts.filter ?? {})) {
    if (!FILTER_KEYS.includes(key)) {
      throw new Error(`cannot filter on "${key}"; the filter keys are ${FILTER_KEYS.join(" and ")}`);
    }
    if (value.trim() === "") throw new Error(`filter ${key} has an empty value`);
  }
}

function matches(tags: Tags, filter: Record<string, string>): boolean {
  return Object.entries(filter).every(
    ([key, value]) => tagValue(tags, key)?.toLowerCase() === value.trim().toLowerCase(),
  );
}

function headerRelayUrl(cfg: Config): string {
  const url = cfg.relays[cfg.headerRelay];
  if (url === undefined) throw new Error(`headerRelay "${cfg.headerRelay}" is not one of the relays`);
  return url;
}

/**
 * State is the only record of what was published. A lost or replaced state file reads as empty,
 * and a build on it would publish every place again as new and never delete the old versions.
 * So an empty state is refused unless the caller says this is the very first import.
 */
function checkFirstRun(cfg: Config, state: State, firstRun: boolean): void {
  const { live, deleted } = state.counts();
  if (live + deleted > 0 || firstRun) return;
  throw new Error(
    `state ${cfg.paths.state} holds no items, live or deleted. If anything was published before, the ` +
      "state file was lost or replaced, and this build would publish every place again; restore it " +
      "from a backup (see README, Backups). For the very first import, run build again with --first-run",
  );
}

/**
 * Claims `runDir` (mkdir fails if it exists) and writes each file through a temp name, so a
 * crash never leaves a truncated file. On a write error the half-written run is removed.
 */
function writeRun(runDir: string, files: [name: string, data: string][]): void {
  mkdirSync(dirname(runDir), { recursive: true });
  mkdirSync(runDir);
  try {
    for (const [name, data] of files) {
      const path = join(runDir, name);
      writeFileSync(`${path}.tmp`, data);
      renameSync(`${path}.tmp`, path);
    }
  } catch (err) {
    rmSync(runDir, { recursive: true, force: true });
    throw err;
  }
}

interface ReportInput {
  runId: string;
  cachePath: string;
  header: NostrEvent;
  opts: BuildOptions;
  filter: Record<string, string>;
  detectGone: boolean;
  catalog: Catalog;
  built: Map<string, Tags>;
  live: Map<string, LiveItem>;
  deletions: { d: string; eventIds: number }[];
  result: BuildResult;
}

/**
 * `d: name` for the report, from a live item's stored tags. Both are code spans, so markdown
 * in a name cannot garble the review before signing.
 */
function liveLabel(d: string, item: LiveItem | undefined): string {
  let name: unknown;
  try {
    const tags: unknown = JSON.parse(item?.tagsJson ?? "[]");
    name = Array.isArray(tags)
      ? (tags as unknown[]).find((t): t is string[] => Array.isArray(t) && t[0] === "name")?.[1]
      : undefined;
  } catch {
    // Unreadable tags read as no name; the d still identifies the item.
  }
  return `${codeSpan(d)}: ${typeof name === "string" && name !== "" ? codeSpan(name) : "(no name recorded)"}`;
}

function renderReport(r: ReportInput): string {
  const filter = Object.entries(r.filter).map(([k, v]) => `${k}=${v}`);
  const deletionNote = !r.detectGone
    ? "not looked for (filtered or pilot build)"
    : r.opts.allowDeletions
      ? "looked for; --allow-deletions given"
      : "looked for";
  const eventCount = r.result.created + r.result.changed + r.result.deletions;
  return [
    `# Build ${r.runId}`,
    "",
    `- Cache: \`${r.cachePath}\``,
    `- Header: \`${r.header.id}\``,
    `- Pilot: ${r.opts.pilot ?? "no"}`,
    `- Filter: ${filter.length > 0 ? filter.join(", ") : "none"}`,
    `- Deletions: ${deletionNote}`,
    `- In scope: ${r.catalog.items.size}; built for this run: ${r.built.size}`,
    "",
    "## Events",
    "",
    table(
      ["class", "count"],
      [
        ["created", r.result.created],
        ["changed", r.result.changed],
        ["unchanged", r.result.unchanged],
        ["deletions", r.result.deletions],
      ],
    ),
    "",
    `\`unsigned.jsonl\` holds ${eventCount} events: created and changed items, then deletions. ` +
      "Unchanged items are not republished.",
    "",
    "## Deletions",
    "",
    !r.detectGone
      ? "not looked for (filtered or pilot build)"
      : bullets(
          r.deletions.map(
            ({ d, eventIds }) => `${liveLabel(d, r.live.get(d))} (${eventIds} event id${eventIds === 1 ? "" : "s"})`,
          ),
        ),
    "",
    "## Held",
    "",
    "Malformed records that still name their place. They are never deleted.",
    "",
    bullets(r.result.held.map((d) => (r.live.has(d) ? `${liveLabel(d, r.live.get(d))} (live, kept)` : codeSpan(d)))),
    "",
    "## Skipped",
    "",
    table(["reason", "places"], Object.entries(r.result.skipped)),
    "",
    "## Duplicates",
    "",
    duplicateList(r.catalog.duplicates),
    "",
    "## Malformed records",
    "",
    bullets(r.catalog.malformed),
    "",
    `## Field coverage over the ${r.built.size} built items`,
    "",
    coverageTable([...r.built.values()]),
    "",
    "## Sample items (first 20 by d)",
    "",
    samples(r.built),
    "",
  ].join("\n");
}

/**
 * Builds the next run from the latest cache: checks the header, builds and deduplicates the
 * items, applies the filter and pilot, diffs against state and writes
 * `<paths.out>/<runId>/{unsigned.jsonl,manifest.json,report.md}`. Only a full build (no filter,
 * no pilot) looks for deletions, and more of them than the guard allows abort the build unless
 * `allowDeletions` is set. A state with no items at all is refused unless `firstRun` is set
 * (checkFirstRun). Nothing is written when it throws.
 */
export async function build(cfg: Config, state: State, opts: BuildOptions = {}): Promise<BuildResult> {
  checkGuard(cfg);
  checkOptions(opts);
  const filter = opts.filter ?? {};
  const detectGone = Object.keys(filter).length === 0 && opts.pilot === undefined;

  const runId = opts.runId ?? `${timestampId(new Date())}${opts.pilot !== undefined ? "-pilot" : ""}`;
  const runDir = runDirFor(cfg, runId);
  if (existsSync(runDir)) throw new Error(`${runDir} already exists; a run is never overwritten`);

  const cachePath = latestCachePath(cfg);
  if (cachePath === null) {
    throw new Error(`no cache in ${join(cfg.paths.data, "cache")}; run npm run fetch first`);
  }

  checkFirstRun(cfg, state, opts.firstRun ?? false);

  const header =
    opts.header ??
    (await fetchHeader(headerRelayUrl(cfg), cfg.headerCoordinate, undefined, readSearch(cfg, cfg.headerRelay)));
  checkHeader(header, cfg.headerCoordinate);

  const catalog = buildCatalog(readCache(cachePath), cfg);
  let chosen = [...catalog.items.values()].filter((tags) => matches(tags, filter));
  if (opts.pilot !== undefined) chosen = selectPilot(chosen, opts.pilot);
  const built = new Map(chosen.map((tags) => [tagValue(tags, "d")!, tags]));

  const live = state.liveItems();
  const diff = diffItems(built, live, { detectGone, held: catalog.held });
  if (diff.gone.length > cfg.deletionGuardFraction * live.size && !opts.allowDeletions) {
    throw new Error(
      `build would delete ${diff.gone.length} of ${live.size} live items, more than ` +
        `${Number((cfg.deletionGuardFraction * 100).toFixed(2))}%; check the latest fetch, and rerun with ` +
        "--allow-deletions only if the deletions are real",
    );
  }

  // Every recorded version, plus the latest id in case a crash kept it out of the events table.
  const deletions = diff.gone.map((d) =>
    deletionFor(d, [...state.versionsOf(d), live.get(d)!.latestEventId], cfg.curatorPubkey),
  );
  const events: Unsigned[] = [
    ...[...diff.created, ...diff.changed].map((tags) => ({ kind: ITEM_KIND, tags, content: "" })),
    ...deletions,
  ];

  const result: BuildResult = {
    runDir,
    created: diff.created.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged,
    deletions: deletions.length,
    skipped: { ...catalog.skipped },
    duplicates: [...new Set(catalog.duplicates.map((x) => x.osmId))].sort(),
    held: [...catalog.held].sort(),
  };
  const manifest = {
    runId,
    // sign and publish refuse the run under any other config (checkRunConfig).
    config: configIdentity(cfg),
    cachePath,
    headerEventId: header.id,
    options: {
      pilot: opts.pilot ?? null,
      filter: Object.keys(filter).length > 0 ? filter : null,
      allowDeletions: opts.allowDeletions ?? false,
    },
    counts: {
      created: result.created,
      changed: result.changed,
      unchanged: result.unchanged,
      deletions: result.deletions,
      skipped: result.skipped,
      duplicates: catalog.duplicates.length,
      held: result.held.length,
    },
  };

  writeRun(runDir, [
    ["report.md", renderReport({
        runId,
        cachePath,
        header,
        opts,
        filter,
        detectGone,
        catalog,
        built,
        live,
        deletions: deletions.map((del, i) => ({
          d: diff.gone[i]!,
          eventIds: del.tags.filter((t) => t[0] === "e").length,
        })),
        result,
      }),],
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["unsigned.jsonl", events.map((e) => `${JSON.stringify(e)}\n`).join("")],
  ]);
  return result;
}
