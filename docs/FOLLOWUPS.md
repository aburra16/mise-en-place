# Follow-ups

Known, deliberately deferred items from the build of the importer (2026-10-05). None blocks the pilot. Items marked "before full import" should land before plan Task 12.

## Before the full import

- `build --allow-deletions` is a blanket switch. Bind it to the count (`--allow-deletions=N` must equal the gone count) so a habitual flag can't wave through a mass deletion caused by a source format change.
- `report.md` reports changed items as a single count. Add per-tag change counts, which the console already computes as `changedFields`, so a BTC Map reformat that would republish thousands of items is visible before signing.
- `build` does not warn about earlier runs that were built or signed but never published (for example, a pilot built but not published, followed by a full build).

## Pilot checks (spec §5, §7.2)

- Do `t` values containing spaces (`fast food`, `san francisco`) match in NIP-50 search on `wss://search.brainstorm.world`? If not, hyphenate them in `deriveT`.
- Does `verify`'s `#d` + `#z` batch read work on vespa-relay, and does the search relay accept kind 5? The tests used `nak serve` for both relays.

## Docs

- README restore step: delete `state.sqlite-wal` and `state.sqlite-shm` before copying a backup back. The `.backup` command is safe either way.
- `docs/plans/…` still shows the old rehearsal state path (`state/rehearsal.sqlite`).

## Robustness

- `verify` reports an `error` instead of listing extras if a relay ignores NIP-09 and holds a full page of events across one batch of deleted ds.
- The console's "raw event" link shows the stored tags and version ids, not the signed event. State does not keep `sig` or `created_at`.
- `sign`: a second concurrent `sign` of the same run could overwrite `signed.jsonl` between the check and the rename. Use an exclusive create.
- The TTY passphrase prompt has no automated test, because the input and output streams are hard-coded.
- Country codes come from country-coder at territory level, which can give user-assigned codes: Kosovo `XK`, Ceuta `EA`. None occur in the 2026-10-05 data.
- A `d` of the form `osm-<type>-<id>` is not namespaced per list. A second list under the same curator key would collide.

## Console polish

- Add a favicon link, so the browser console shows no 404.
- `/api/item/:d` reads the whole live table.
- `/api/diff` rebuilds from the cache on every load.
- The diff page doesn't flag when the deletion guard would trip.
- Add a persistent server `error` listener.
- 500 responses echo `err.message`.
- The console opens state read-write. A read-only connection would make "read-only" structural.
- The page loads data once, so new runs only appear after a reload.
- The debounce timer resets paging.
