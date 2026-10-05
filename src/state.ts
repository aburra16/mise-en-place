import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface LiveItem {
  d: string;
  contentHash: string;
  tagsJson: string;
  latestEventId: string;
}

export interface State {
  liveItems(): Map<string, LiveItem>;
  /** Every kind-39999 event id ever recorded for `d`, on any relay, ok or not. Oldest first. */
  versionsOf(d: string): string[];
  acceptedOn(eventId: string, relay: string): boolean;
  /** True once any relay has accepted `eventId`: publish acts on an event's first OK only. */
  acceptedAnywhere(eventId: string): boolean;
  recordResult(r: {
    eventId: string;
    d: string;
    kind: number;
    createdAt: number;
    runId: string;
    relay: string;
    ok: boolean;
    message: string;
  }): void;
  markLive(d: string, contentHash: string, tagsJson: string, eventId: string, at: number): void;
  markDeleted(d: string, at: number): void;
  runs(): { runId: string; relay: string; ok: number; failed: number }[];
  close(): void;
}

const ITEM_KIND = 39999;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  d TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('live', 'deleted')),
  content_hash TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  latest_event_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_changed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT NOT NULL,
  d TEXT NOT NULL,
  kind INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  relay TEXT NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (event_id, relay)
);
CREATE INDEX IF NOT EXISTS events_d ON events (d);
`;

/**
 * Opens (creating if needed) the publish ledger at `path`; ":memory:" is allowed.
 * For a file path the parent directory is created and WAL is enabled.
 * Timestamps are unix seconds.
 */
export function openState(path: string): State {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    if (!inMemory) db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
  } catch (err) {
    db.close();
    throw err;
  }

  const selectLive = db.prepare(
    `SELECT d, content_hash AS contentHash, tags_json AS tagsJson, latest_event_id AS latestEventId
       FROM items WHERE status = 'live' ORDER BY d`,
  );
  const selectVersions = db.prepare(
    `SELECT event_id AS eventId FROM events
      WHERE d = ? AND kind = ${ITEM_KIND}
      GROUP BY event_id ORDER BY MIN(created_at), event_id`,
  );
  const selectAccepted = db.prepare(
    "SELECT 1 FROM events WHERE event_id = ? AND relay = ? AND ok = 1",
  );
  const selectAcceptedAnywhere = db.prepare("SELECT 1 FROM events WHERE event_id = ? AND ok = 1 LIMIT 1");
  const upsertEvent = db.prepare(
    `INSERT INTO events (event_id, d, kind, created_at, run_id, relay, ok, message)
     VALUES (@eventId, @d, @kind, @createdAt, @runId, @relay, @ok, @message)
     ON CONFLICT (event_id, relay) DO UPDATE SET
       ok = excluded.ok, message = excluded.message, run_id = excluded.run_id`,
  );
  const upsertLive = db.prepare(
    `INSERT INTO items (d, status, content_hash, tags_json, latest_event_id, first_seen, last_changed)
     VALUES (@d, 'live', @contentHash, @tagsJson, @eventId, @at, @at)
     ON CONFLICT (d) DO UPDATE SET
       status = 'live',
       content_hash = excluded.content_hash,
       tags_json = excluded.tags_json,
       latest_event_id = excluded.latest_event_id,
       last_changed = excluded.last_changed`,
  );
  const updateDeleted = db.prepare(
    "UPDATE items SET status = 'deleted', last_changed = ? WHERE d = ?",
  );
  const selectRuns = db.prepare(
    `SELECT run_id AS runId, relay, SUM(ok = 1) AS ok, SUM(ok = 0) AS failed
       FROM events GROUP BY run_id, relay ORDER BY run_id, relay`,
  );

  return {
    liveItems() {
      const items = new Map<string, LiveItem>();
      for (const row of selectLive.all() as LiveItem[]) items.set(row.d, row);
      return items;
    },
    versionsOf(d) {
      return (selectVersions.all(d) as { eventId: string }[]).map((row) => row.eventId);
    },
    acceptedOn(eventId, relay) {
      return selectAccepted.get(eventId, relay) !== undefined;
    },
    acceptedAnywhere(eventId) {
      return selectAcceptedAnywhere.get(eventId) !== undefined;
    },
    recordResult(r) {
      upsertEvent.run({ ...r, ok: r.ok ? 1 : 0 });
    },
    markLive(d, contentHash, tagsJson, eventId, at) {
      upsertLive.run({ d, contentHash, tagsJson, eventId, at });
    },
    markDeleted(d, at) {
      updateDeleted.run(at, d);
    },
    runs() {
      return selectRuns.all() as { runId: string; relay: string; ok: number; failed: number }[];
    },
    close() {
      db.close();
    },
  };
}
