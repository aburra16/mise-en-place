# Mise en Place

Mise en Place fills a nostr DList called "Food and Drink Places" with the food and drink businesses listed on BTC Map. Each place becomes one kind 39999 item under the list's header, signed by the Mise en Place curator account. It is developer tooling: a command-line pipeline (fetch, build, sign, publish, verify) and a local, read-only console for inspecting the list.

## The list

- Header coordinate: `39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:food-and-drink-places` (signed by Avi; this tool never signs a header).
- Curator: `npub1f00dy9eqw53patfe8g96ajw9xq3casvjc25umw78w4963se40djqwxgrq8` (hex `4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64`).
- Relays: `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world`.

These values live in `config.json`.

## Requirements

Node 22 or later. Install the exact versions in `package-lock.json`:

```bash
npm ci
```

`nak` (https://github.com/fiatjaf/nak) is needed for the tests, the rehearsal, and the check of an `nsec` key file in Key setup.

## Key setup

Avi writes the curator key himself, as an `nsec` or a NIP-49 `ncryptsec`. The key never goes in the repo, on a command line or in a chat. The tool reads it from `~/.config/mise-en-place/curator.key`, or from the file named by `MISE_KEY_FILE`. It refuses a file that others can read, and a key whose public key is not the curator's.

Create the directory:

```bash
mkdir -p ~/.config/mise-en-place && chmod 700 ~/.config/mise-en-place
```

Copy the key to the clipboard, then write it to the file and restrict it:

```bash
pbpaste > ~/.config/mise-en-place/curator.key && chmod 600 ~/.config/mise-en-place/curator.key
```

Then clear the clipboard, so the key does not stay there:

```bash
pbcopy < /dev/null
```

For an `nsec` only, check that the file holds the curator's key. This must print `4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64`:

```bash
nak key public < ~/.config/mise-en-place/curator.key
```

Skip that check for an `ncryptsec`: nak does not decrypt it, so it checks nothing and prints the `ncryptsec` itself to the terminal. `sign` covers it instead: it derives the public key from the decrypted key, refuses a key that is not the curator's, and prints the pubkey and npub it signed with.

With an `ncryptsec`, `sign` asks for the passphrase at a terminal prompt. It never takes the passphrase as an argument and refuses to run without a terminal.

## Pipeline

Every step writes files the next one reads, so any stage can be inspected before the next begins. Run the commands from the repo root.

1. `fetch` reads the BTC Map API and writes `data/cache/places-<date>.json`. It refuses a response that is not a list, an empty list, or one less than half the size of the last cache, and gives up after 120 s.

   ```bash
   npm run fetch
   ```

2. `census` reads the newest cache and prints category counts, the in-scope total, field coverage, skipped places with reasons and 20 sample items. It writes nothing.

   ```bash
   npm run census
   ```

   To keep the output, redirect it; `--silent` keeps npm's own lines out of the file:

   ```bash
   npm run --silent census > census.md
   ```

3. `build` reads the newest cache, `state/state.sqlite` and the header on dcosl, and stops if the header is missing or its `required` fields changed. It also stops when the state file holds no items at all, unless given `--first-run` (see Backups). It writes `out/<runId>/unsigned.jsonl` (new and changed items, then deletions), `out/<runId>/manifest.json` and `out/<runId>/report.md`. It prints the run directory; `<runId>` is its last part. A run is never overwritten.

   `manifest.json` records the config the run was built with: the header coordinate, the curator pubkey, the relays and the state file. `sign` and `publish` refuse a run whose record differs from the config they load, and name the field that differs.

   ```bash
   npm run build
   ```

   Review `out/<runId>/report.md` before signing. It lists counts by class, the deletions, held places, skipped places, field coverage and sample items.

4. `sign` reads `out/<runId>/unsigned.jsonl` and the key file, and writes `out/<runId>/signed.jsonl`. It is the only step that loads the key. It signs kinds 39999 and 5 only.

   ```bash
   npm run sign -- <runId>
   ```

5. `publish` reads `out/<runId>/signed.jsonl`, sends each event to every relay at 5 events per second per relay (`publish.eventsPerSecond` in `config.json`) and records every event id and each relay's answer in `state/state.sqlite`. It prints `<relay>: <n>/<total>` to stderr every 500 events on each relay. A relay that drops the connection, or lets 20 events in a row go unanswered within `publish.okTimeoutMs`, is given up on and reported with an error, while the others carry on. Events a relay already accepted are not sent again, so after a failure the same command retries the rest. `--relays dcosl,search` limits it to the named relays.

   ```bash
   npm run publish -- <runId>
   ```

   Back up the state file after every publish (see Backups).

6. `verify` reads `state/state.sqlite` and each relay, and compares them. It writes nothing and exits non-zero if a relay and state do not match: an item live in state but `missing` from the relay, a `stale` version on the relay, or an `extra` item on the relay that is not live in state.

   ```bash
   npm run verify
   ```

   It asks each relay for every live item and every deleted item by name, so `missing`, `stale` and a deleted item still on a relay (reported as `extra`) are exact however large the list. Extras that state never recorded at all can only be found by listing everything the relay holds, page by page. Paging cannot step past one `created_at` shared by more than a page of events, and `sign` gives every event of a run the same `created_at`. So after a run larger than one page (the relay's NIP-11 `max_limit`, at most 10000, or 500 when the relay publishes none), verify prints `warning: <relay>: extra check incomplete: ...`. The warning means only that the listing could not see every event; deleted items were still checked exactly, and the warning alone does not fail verify. `nak serve` publishes no `max_limit`, so a full-size rehearsal shows it too.

`npm run header:rebroadcast -- <relayName>` is a separate step: it copies Avi's signed header, byte for byte, from the header relay (dcosl) to the named relay, for example `search`. It needs no key and does not touch state; it refuses if the named relay is the header relay.

```bash
npm run header:rebroadcast -- search
```

## Pilot, full import and monthly refresh

Pilot (spec section 7.2): after `header:rebroadcast`, build about 150 US items spread across categories and states, then sign, publish and verify. A pilot or filtered build never emits deletions. The option `--pilot N` sets another size. `--filter` takes two keys only, `country` and `category`, for example `--filter category=cafe`. The pilot is the very first import, so it is the one build that needs `--first-run`:

```bash
npm run build -- --pilot --filter country=US --first-run
```

Full import and monthly refresh (spec section 7.3) use the same sequence:

```
fetch, build, review report.md, sign, publish, verify
```

- Only changed places are republished. A place is changed when its item tags differ from the last published version (a hash of the tags; `created_at` is not part of it). Unchanged places are not touched.
- A place that is no longer in the latest fetch, or no longer in scope, gets a kind 5 deletion. The deletion names every version of the item ever recorded, with one `e` tag per event id, plus the `a` tag and `["k","39999"]`.
- The deletion guard: if the deletions would exceed 2% of live items, `build` aborts. This protects against a bad fetch. Check the fetch, and rerun with `--allow-deletions` only if the deletions are real.

  ```bash
  npm run build -- --allow-deletions
  ```

- A place whose record is present but malformed is held, not deleted. It is listed under "Held" in the report, and an item already live for it stays live.

## Backups

`state/state.sqlite` is the only record of what was published: every event id, which relay accepted it, and which items are live or deleted. If it is lost, `build` would publish every place again as new and could never delete the old versions. So `build` refuses a state file that holds no items, live or deleted, unless given `--first-run`. Pass that flag for the very first import (the pilot) only; at any other time, restore the latest backup instead.

After each publish, back up the state file:

```bash
mkdir -p state/backups && sqlite3 state/state.sqlite ".backup state/backups/state-$(date +%Y-%m-%d).sqlite"
```

When no command is running, a plain copy works too:

```bash
mkdir -p state/backups && cp state/state.sqlite state/backups/state-$(date +%Y-%m-%d).sqlite
```

`state/` is gitignored, so these backups exist only in this checkout. Keep copies outside the repo as well, on another disk or machine. To restore, copy the latest backup to `state/state.sqlite` and run `verify` before the next build.

## Rehearsal

Do this before anything touches a public relay (spec section 7.1). The rehearsal uses an isolated local relay, a throwaway key, and its own cache, runs and state file, all under `state/rehearsal/` (`data`, `out` and `state.sqlite`). It cannot reach a public relay, and it cannot touch production data: the real commands read `data/`, `out/` and `state/state.sqlite`, never these. A rehearsal run is also refused by `sign` and `publish` under the real config, because its manifest records the rehearsal config.

1. Start a local relay in a separate terminal. It listens on `ws://localhost:10547` and keeps events in memory.

   ```bash
   nak serve
   ```

2. Generate a throwaway key. The key file must hold an `nsec`, so encode what `nak key generate` prints. Keep the file, so any stray event could still be deleted. The first line creates the key directory, as in Key setup.

   ```bash
   mkdir -p ~/.config/mise-en-place && chmod 700 ~/.config/mise-en-place
   (umask 077; nak key generate | nak encode nsec > ~/.config/mise-en-place/rehearsal.key)
   ```

3. Print its public key.

   ```bash
   nak key public < ~/.config/mise-en-place/rehearsal.key
   ```

4. Copy the example config, then set `curatorPubkey` in `config.rehearsal.json` to that public key. The file is gitignored. Keep its `paths` under `state/rehearsal/`.

   ```bash
   cp config.rehearsal.example.json config.rehearsal.json
   ```

5. Copy Avi's header to the local relay only:

   ```bash
   nak req -k 39998 -a b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450 -d food-and-drink-places wss://dcosl.brainstorm.world | nak event ws://localhost:10547
   ```

6. Give the rehearsal its own cache. Copy the real one into the rehearsal data directory:

   ```bash
   mkdir -p state/rehearsal/data/cache && cp data/cache/places-<date>.json state/rehearsal/data/cache/
   ```

   or fetch a fresh one straight into it:

   ```bash
   MISE_CONFIG=config.rehearsal.json npm run fetch
   ```

7. Run every command with `MISE_CONFIG=config.rehearsal.json`, `fetch` and `census` included, since the rehearsal reads its own cache. `sign` also needs `MISE_KEY_FILE`. The rehearsal state starts empty, so the first `build` needs `--first-run`:

   ```bash
   MISE_CONFIG=config.rehearsal.json npm run build -- --first-run
   ```

   ```bash
   MISE_CONFIG=config.rehearsal.json MISE_KEY_FILE=~/.config/mise-en-place/rehearsal.key npm run sign -- <runId>
   ```

   Run `publish` and `verify` with `MISE_CONFIG` set, and `sign` with the run id that `build` printed. Each `build` writes a new run directory.

8. Check three things: `verify` matches, a second `build` writes 0 events, and a simulated change and a simulated deletion behave correctly. To simulate them, copy the newest rehearsal cache to a file named for a later date (`places-YYYY-MM-DD.json`) inside `state/rehearsal/data/cache/`, edit one place and remove another in the copy, and run the rehearsal `build`. Edit only that copy. It sits in the rehearsal's own cache, so the simulation cannot touch production data: a real `build` reads `data/cache/` and never this directory. Delete the copy afterwards, because the newest cache is the one every rehearsal run reads.

Never publish to a public relay from a test or a rehearsal.

## Console

```bash
npm run console
```

This serves a single page on `127.0.0.1:4517`; `-- --port N` changes the port. It is read-only: it reads state and the relays and refuses any request but GET. Writes happen only through the CLI, so the key never meets the browser. It has no trust filter and no item cap. It shows an overview with counts per relay set against state, a table with search and filters, a map, the diff the next build would produce, and the publish history per run. The map loads Leaflet and OSM tiles from the internet.

To inspect a rehearsal, start it with `MISE_CONFIG=config.rehearsal.json`.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

The integration tests spawn `nak serve` on loopback ports 10596 to 10599 and never touch a public relay.

## What this tool does not do

- It does not register the list in Brainstorm-UI's `dictionary.config.json` (with `"search": true`). That is a PR by Vinney.
- It does not lift Brainstorm's 500-item read cap, so Brainstorm shows at most 500 of these items for now.
- It does not write Tapestry Tags for cuisine. For now the `t` tags carry category, cuisines and city.
- It does not publish the curator's kind 0 profile or set its bot flag.

## Attribution and licence

Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0). Seeded from BTC Map (btcmap.org).

- OpenStreetMap copyright: https://www.openstreetmap.org/copyright
- ODbL 1.0: https://opendatacommons.org/licenses/odbl/1-0/

Every item carries `osm-id`, `source` and `license` tags. Fetched data and built output (`data/`, `out/`, `state/`) are not committed, so the repo holds code and config, not an ODbL extract.

The code is MIT; see `LICENSE`.

## Import log

| Date | Run | Created | Changed | Deleted | Relays | Notes |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |
