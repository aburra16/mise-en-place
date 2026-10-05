import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, fieldCoverage } from "../catalog.js";
import { verify, type RelayVerifyResult } from "../commands/verify.js";
import type { Config } from "../config.js";
import { changedFields, diffItems, parseTags } from "../diff.js";
import { tagValue, type Tags } from "../item.js";
import { latestCachePath, readCache } from "../source/btcmap.js";
import type { State } from "../state.js";

export interface ConsoleDeps {
  /** Reads the relays for `/api/relays`. Tests inject it so no relay is ever contacted. */
  verify?: (cfg: Config, state: State) => Promise<Record<string, RelayVerifyResult>>;
}

export interface ConsoleServer {
  url: string;
  /** Where the server listens: always 127.0.0.1, with the port the OS gave when 0 was asked for. */
  address: AddressInfo;
  /** Stops listening and drops open connections. Safe to call twice. */
  close(): Promise<void>;
}

const HOST = "127.0.0.1";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const EXAMPLES = 50;
/** Tags that are not shown as fields: the list's own plumbing, and `t` which has its own key. */
const HIDDEN_FIELDS = new Set(["d", "z", "g", "t", "alt"]);
const FILTER_FIELDS = ["category", "country", "locality", "cuisine"] as const;

/** A failure that is answered with this HTTP status. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface LiveRow {
  d: string;
  eventId: string;
  tags: Tags;
  /** The first value of each tag name except d, z, g, t and alt. */
  fields: Record<string, string>;
  /** Every `t` value. */
  t: string[];
}

/** Every live item, by `d`, with its tags read. Read per request, so a publish run elsewhere shows up. */
function readLive(state: State): LiveRow[] {
  return [...state.liveItems().values()].map((item) => {
    const tags = parseTags(item.tagsJson);
    const fields = new Map<string, string>();
    for (const [name, value] of tags) {
      if (name !== undefined && value !== undefined && !HIDDEN_FIELDS.has(name) && !fields.has(name)) {
        fields.set(name, value);
      }
    }
    return {
      d: item.d,
      eventId: item.latestEventId,
      tags,
      fields: Object.fromEntries(fields),
      t: tags.filter((tag) => tag[0] === "t").map((tag) => tag[1] ?? ""),
    };
  });
}

/** A whole number from `query`, or `fallback` when it is absent; anything else is a 400. */
function wholeNumber(query: URLSearchParams, name: string, fallback: number, min: number): number {
  const raw = query.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min) {
    throw new HttpError(400, `${name} must be a whole number of at least ${min}, got "${raw}"`);
  }
  return n;
}

function overview(state: State): unknown {
  const live = readLive(state);
  const coverage = Object.fromEntries(fieldCoverage(live.map((row) => row.tags)).map((c) => [c.field, c.pct]));
  const runs = state.runs();
  const lastRunId = runs.at(-1)?.runId;
  return {
    ...state.counts(),
    coverage,
    lastRun:
      lastRunId === undefined
        ? null
        : {
            runId: lastRunId,
            relays: runs.filter((r) => r.runId === lastRunId).map(({ relay, ok, failed }) => ({ relay, ok, failed })),
          },
  };
}

function items(state: State, query: URLSearchParams): unknown {
  const limit = Math.min(wholeNumber(query, "limit", DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = wholeNumber(query, "offset", 0, 0);
  const q = (query.get("q") ?? "").trim().toLowerCase();
  const exact = FILTER_FIELDS.flatMap((name) => {
    const value = (query.get(name) ?? "").trim().toLowerCase();
    return value === "" ? [] : [[name, value] as const];
  });

  const matching = readLive(state).filter(
    (row) =>
      (q === "" || (row.fields.name ?? "").toLowerCase().includes(q)) &&
      exact.every(([name, value]) => (row.fields[name] ?? "").toLowerCase() === value),
  );
  return {
    total: matching.length,
    items: matching.slice(offset, offset + limit).map(({ d, eventId, fields, t }) => ({ d, eventId, fields, t })),
  };
}

const coordinate = (value: string | undefined): number =>
  value === undefined || value.trim() === "" ? NaN : Number(value);

/** `[d, lat, lon, name, category]` per live item. One whose coordinates cannot be read cannot be placed, so it is left out. */
function points(state: State): unknown[] {
  const rows: unknown[] = [];
  for (const { d, fields } of readLive(state)) {
    const lat = coordinate(fields.lat);
    const lon = coordinate(fields.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) rows.push([d, lat, lon, fields.name ?? "", fields.category ?? ""]);
  }
  return rows;
}

function item(state: State, d: string): unknown {
  const live = state.liveItems().get(d);
  if (live === undefined) throw new HttpError(404, `no live item ${d}`);
  return { d, tags: parseTags(live.tagsJson), versions: state.versionsOf(d), latestEventId: live.latestEventId };
}

interface Example {
  d: string;
  name?: string;
  category?: string;
  locality?: string;
  /** For a changed item: the tag names whose values differ from the live item's. */
  changedFields?: string[];
}

function example(d: string, tags: Tags, changed?: string[]): Example {
  const out: Example = { d };
  for (const key of ["name", "category", "locality"] as const) {
    const value = tagValue(tags, key);
    if (value !== undefined) out[key] = value;
  }
  if (changed !== undefined) out.changedFields = changed;
  return out;
}

/**
 * What the next full build would do against the latest cache. It builds the catalog and
 * diffs it exactly as `build` does, with deletions looked for and unreadable-but-present
 * records held, so this page and `npm run build` cannot disagree.
 */
function diff(cfg: Config, state: State): unknown {
  const cachePath = latestCachePath(cfg);
  if (cachePath === null) throw new HttpError(409, "no cache yet; run npm run fetch first");
  const catalog = buildCatalog(readCache(cachePath), cfg);
  const live = state.liveItems();
  const d = diffItems(catalog.items, live, { detectGone: true, held: catalog.held });
  return {
    cache: basename(cachePath),
    created: d.created.length,
    changed: d.changed.length,
    unchanged: d.unchanged,
    gone: d.gone.length,
    examples: {
      created: d.created.slice(0, EXAMPLES).map((tags) => example(tagValue(tags, "d") ?? "", tags)),
      changed: d.changed.slice(0, EXAMPLES).map((tags) => {
        const dTag = tagValue(tags, "d") ?? "";
        return example(dTag, tags, changedFields(parseTags(live.get(dTag)?.tagsJson ?? "[]"), tags));
      }),
      gone: d.gone.slice(0, EXAMPLES).map((dTag) => example(dTag, parseTags(live.get(dTag)?.tagsJson ?? "[]"))),
    },
  };
}

/** The path's segments, decoded, or an error if any could be used to reach outside the public files. */
function segmentsOf(rawPath: string): string[] {
  if (!rawPath.startsWith("/")) throw new HttpError(400, "bad path");
  return rawPath
    .slice(1)
    .split("/")
    .map((raw) => {
      let segment: string;
      try {
        segment = decodeURIComponent(raw);
      } catch {
        throw new HttpError(400, "bad path");
      }
      if (segment === "." || segment === ".." || /[/\\\0]/.test(segment)) throw new HttpError(400, "bad path");
      return segment;
    });
}

function staticFile(segments: string[]): { type: string; body: Buffer } {
  const name = segments.length === 1 ? segments[0] || "index.html" : undefined;
  const type = name === undefined ? undefined : CONTENT_TYPES[extname(name)];
  if (name === undefined || type === undefined) throw new HttpError(404, "not found");
  const file = join(PUBLIC_DIR, name);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, "not found");
  return { type, body: readFileSync(file) };
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, noCache: boolean): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": noCache ? "no-store" : "no-cache",
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body), true);

/**
 * Starts the read-only console on 127.0.0.1 (port 0 lets the OS choose). It serves the page
 * from `public/` and a JSON API over `state` and the latest cache; no route writes anything,
 * and any method but GET is refused. `/api/relays` reads the relays only when asked, and
 * requests that overlap share one read.
 */
export function startConsole(
  cfg: Config,
  state: State,
  port = 4517,
  deps: ConsoleDeps = {},
): Promise<ConsoleServer> {
  const verifyRelays = deps.verify ?? verify;
  let relaysInFlight: Promise<Record<string, RelayVerifyResult>> | null = null;
  const relays = (): Promise<Record<string, RelayVerifyResult>> => {
    relaysInFlight ??= verifyRelays(cfg, state).finally(() => {
      relaysInFlight = null;
    });
    return relaysInFlight;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      throw new HttpError(405, "this console is read-only; use GET");
    }
    const target = req.url ?? "/";
    const queryStart = target.indexOf("?");
    const rawPath = queryStart < 0 ? target : target.slice(0, queryStart);
    const query = new URLSearchParams(queryStart < 0 ? "" : target.slice(queryStart + 1));
    const segments = segmentsOf(rawPath);

    if (segments[0] !== "api") {
      const file = staticFile(segments);
      send(res, 200, file.type, file.body, false);
      return;
    }
    const [, route, ...rest] = segments;
    if (route === "item" && rest.length === 1 && rest[0] !== "") {
      sendJson(res, 200, item(state, rest[0]!));
    } else if (rest.length > 0) {
      throw new HttpError(404, "not found");
    } else if (route === "overview") {
      sendJson(res, 200, overview(state));
    } else if (route === "items") {
      sendJson(res, 200, items(state, query));
    } else if (route === "points") {
      sendJson(res, 200, points(state));
    } else if (route === "diff") {
      sendJson(res, 200, diff(cfg, state));
    } else if (route === "runs") {
      sendJson(res, 200, state.runs());
    } else if (route === "relays") {
      sendJson(res, 200, await relays());
    } else {
      throw new HttpError(404, "not found");
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        res.destroy();
      } else if ((req.url ?? "").startsWith("/api/") || status === 405) {
        sendJson(res, status, { error: message });
      } else {
        send(res, status, "text/plain; charset=utf-8", `${message}\n`, true);
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use; pass another with --port N`)
          : err,
      );
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      let closing: Promise<void> | undefined;
      resolve({
        url: `http://${HOST}:${address.port}`,
        address,
        close() {
          closing ??= new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          });
          return closing;
        },
      });
    });
  });
}
