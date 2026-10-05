# Mise en Place: food and drink DList importer (design)

Status: approved by Avi, 2026-10-05.
Source brief: `BTCMAP_FOOD_DLIST_HANDOFF.md` (Claude desktop session, 2026-10-05), plus the decisions and findings recorded here.

## 1. Purpose

Fill the published DList `Food and Drink Places` with the food and drink businesses on BTC Map, signed by the Mise en Place curator account, and keep the list current as BTC Map changes. The first consumer is brainstorm.world (Dictionary and list search). Later consumers may be other nostr apps, for example a web-of-trust restaurant review app.

This is developer tooling: command-line scripts plus a local, read-only console for inspecting the list. It is not a user-facing app.

### Success criteria

- Every in-scope BTC Map place exists on `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world` as one kind 39999 item under the header, signed by the curator.
- Running the tool again publishes only places that changed, and deletes (kind 5) places that left BTC Map or left scope.
- Every event id ever published is recorded, so any deletion can name all versions.
- No secret appears in the repo, a log, a shell history line or a command-line argument.
- Avi can see the whole list, its coverage, and the pending diff against BTC Map in the console, without trust filtering or item caps.

## 2. Fixed facts (verified 2026-10-05)

| Fact | Value | How verified |
|---|---|---|
| Header coordinate | `39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:food-and-drink-places` | Read back from dcosl; id `21e5b848…8648` |
| Header `required` | `name`, `category` | Same read |
| Header self-pointing `b` | present | Same read |
| Header display hints | title=name, summary=address, image=image, link=website | Same read |
| Curator pubkey | `4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64` | Handoff, Avi |
| Curator rank, house view | 7 (Brainstorm's line is 2) | Live read of house TA `78ed0837…` on `wss://scores.brainstorm.world` |
| BTC Map places | 29,693, fetched in one 16.7 MB request in 3 s | Live |
| Places with an OSM id | all of them; no duplicates | Census |
| Square merchants | 8,683, all tagged `payment:lightning:operator=square`, all with OSM ids | Census |

These values live in `config.json` and are checked at run time (§ 6.4). Nothing is hardcoded in code.

## 3. Decisions

### Settled by Avi

- **Source:** BTC Map REST API v4. Square merchants are included like any other place.
- **Scope:** food and drink places. Supermarkets and convenience stores are excluded.
- **Signer:** the Mise en Place curator key for items and deletions. The header stays Avi's; this tool never signs it.
- **Relays:** publish to both `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world`. The search relay does not currently mirror dcosl, and it is what Brainstorm's search reads. Avi's signed header is rebroadcast to the search relay unchanged.
- **Deletions:** NIP-09 kind 5.
- **`t` tags:** added for searchability (category, cuisines, locality). Tapestry Tags for cuisine come later, once their shape (including any parent and child hierarchy) is decided.
- **Pilot:** about 150 places spread across the United States.
- **Profile (kind 0) and `bot: true`:** deferred. The goal right now is a working, indexable list.
- **Registration in Brainstorm-UI:** Avi will raise it with Vinney after the list is built.
- **Repo:** `aburra16/mise-en-place`, public.

### Defaults taken here (Avi did not object)

- Stack: Node 20+ and TypeScript; `nostr-tools` for keys, NIP-19, NIP-49 and signing; `@rapideditor/country-coder` (ISC) for offline country lookup; `ngeohash` (MIT); `better-sqlite3` for state.
- Breweries, wineries and distilleries (OSM `craft=*`) are in. Caterers and marketplaces are out.
- One `cuisine` field value; `verified_at` is not carried.
- `country` is computed offline from coordinates, so no extra API calls are made.
- The field name `category` stays, because the header is already signed with it.
- A full fetch on every run (3 s) rather than `updated_since` incremental sync. It is simpler, and diffing against local state gives the same result.

## 4. Scope

A place is in scope when it has a non-empty `name` and any of the following, checked in this order (the first match sets `category`):

1. `osm:amenity` ∈ restaurant, cafe, fast_food, bar, pub, biergarten, food_court, ice_cream
2. `osm:shop` ∈ bakery, pastry, confectionery, chocolate, deli, cheese, butcher, seafood, greengrocer, farm, dairy, spices, coffee, tea, wine, alcohol, beverages, health_food
3. `osm:craft` ∈ brewery, winery, distillery

Census, 2026-10-05: 7,854 places from rules 1 and 2, plus about 106 from rule 3. 2,847 of them are Square merchants.

The lists live in `config.json` so the scope can change without a code change. A place that later stops matching is treated as a deletion (§ 7.3).

## 5. Item shape

Kind 39999. Tags in this order. A field with no value is omitted, never written empty. Order matters because Tapestry's Items read keeps the first 20 properties and every reader takes the first value of a field.

| Tag | Source | Rule |
|---|---|---|
| `d` | `osm_id` | `osm-` + id with `:` replaced by `-`, e.g. `osm-node-10011069455` |
| `z` | config | The header coordinate. Exactly one `z`. |
| `name` | `name` | Verbatim |
| `category` | § 4 | Verbatim OSM value, e.g. `fast_food` |
| `address` | `address` | Verbatim |
| `locality` | `osm:addr:city` | Verbatim |
| `region` | `osm:addr:state` | Verbatim |
| `postal-code` | `osm:addr:postcode` | Verbatim |
| `country` | `lat`, `lon` | ISO 3166-1 alpha-2 from country-coder. If country-coder finds none, fall back to `osm:addr:country`; if that is empty too, omit. |
| `cuisine` | `osm:cuisine` | First `;`-separated value, trimmed, lowercased |
| `osm-id` | `osm_id` | Verbatim, e.g. `node:10011069455` |
| `lat`, `lon` | `lat`, `lon` | As strings, as received |
| `website` | `website` | Verbatim (BTC Map validates it as a URL) |
| `phone` | `phone` | Verbatim |
| `opening-hours` | `opening_hours` | Verbatim OSM syntax |
| `description` | `description` | Verbatim, when present (6% of places) |
| `image` | `image` | Only if it starts with `https://` |
| `accepts-bitcoin` | payment tags | See below |
| `btcmap-id` | `id` | As a string |
| `source` | constant | `btcmap` |
| `license` | constant | `ODbL-1.0` |
| `g` × 4 | `lat`, `lon` | Geohash at 9 characters, then prefixes of 6, 5 and 4 |
| `t` × n | derived | Category with `_` as a space; every cuisine value; locality. Lowercased, deduplicated, original order kept. |
| `alt` | derived | `Food and drink place: <name>, <locality>`, or `<name>` alone without a locality |

**`accepts-bitcoin`:**
- **Lightning:** `osm:payment:lightning` or `osm:payment:lightning_contactless` equals `yes`.
- **On-chain:** `osm:payment:onchain` equals `yes`.
- **Result:** `both` when both are true, `lightning` or `onchain` when only one is, and `yes` otherwise. A place being on BTC Map means it accepts bitcoin.
- **`no` values are common** (for example lightning `yes` with on-chain `no`), so only the exact value `yes` counts.

**Test fixture:** BTC Map place 15 (Gabbani Enoteca).
- The geohash at 46.0042728, 8.9502477 must be `u0nmewv67`.
- The expected item is the handoff's § 4.3 example, plus `country` `CH` and the `t` tags.

**Open check in the pilot:** do `t` values with spaces (`fast food`, `san francisco`) tokenize so that Brainstorm's search relay matches them? If they don't, switch to hyphenated values before the full import.

## 6. Architecture

```
BTC Map API ──fetch──▶ data/cache/places-<date>.json   (raw, never edited)
                              │
                         census / build  (pure, no keys, no network)
                              │
                 ┌────────────┴────────────┐
       out/<run>/unsigned.jsonl     out/<run>/report.md
                              │
                           sign   (only step that loads the key)
                              │
                     out/<run>/signed.jsonl
                              │
                          publish ──▶ dcosl + search relays
                              │
                       state/state.sqlite  (every event id, per-relay result)
                              │
                     console (localhost, read-only)
```

### 6.1 Units

- **`source/btcmap.ts`:** fetches all places with the fields the mapping needs into a dated cache file, then normalizes each raw record into a source-neutral `Place`. This is the only file that knows BTC Map. A later source, such as Overpass for all OSM restaurants, would be a second adapter that produces `Place` records. The item builder doesn't change.
- **`scope.ts`:** decides whether a `Place` is in scope and what its `category` is, using the config lists.
- **`item.ts`:** turns a `Place` into an unsigned item's tags (§ 5). Pure and deterministic.
- **`diff.ts`:** compares built items with state. Each item is new, changed, unchanged or gone. "Changed" means the hash of the tags differs (`created_at` excluded). Unchanged items are never republished, because republishing would orphan any votes on the old event id.
- **`deletion.ts`:** builds a kind 5 for a gone item. It carries `["e", <id>]` for every version in state, plus `["a", "39999:<curator>:<d>"]` and `["k", "39999"]`. The `e` tags matter because dcosl runs strfry 1.0.4, which honors only `e`.
- **`sign.ts`:**
  - loads the key (§ 6.4) and checks that the derived pubkey equals `config.curatorPubkey`, stopping on mismatch;
  - signs `unsigned.jsonl` into `signed.jsonl`;
  - stamps `created_at` at signing time.
- **`publish.ts`:**
  - sends `signed.jsonl` to each configured relay, throttled (default 5 events/s per relay);
  - backs off on `rate-limited` and similar replies;
  - records every `OK` result per relay in state;
  - is resumable: it skips events a relay already accepted;
  - publishes deletions last in a run.
- **`verify.ts`:** reads back from each relay with `{"kinds":[39999],"authors":[curator],"#z":[coord]}`, paginating with `until`. It compares counts and ids with state and lists anything missing or extra.
- **`state.ts`:** SQLite with two tables:
  - `items(d, status, content_hash, tags_json, latest_event_id, first_seen, last_changed)` (`tags_json` lets the console show fields without a relay read);
  - `events(event_id, d, kind, created_at, run_id, relay, ok, message)`.
- **`console/`:** a localhost-only web server with read-only JSON endpoints over state, the latest cache and live relay reads, plus a static page (§ 8).

### 6.2 Commands

| Command | Does | Network | Key |
|---|---|---|---|
| `npm run fetch` | Write today's cache file | BTC Map | no |
| `npm run census` | Category counts, in-scope total, field coverage, skips with reasons, 20 sample items | none | no |
| `npm run build -- [--pilot [N]] [--filter country=US] [--allow-deletions]` | Check the header, then write `unsigned.jsonl` (new and changed items, then deletions) and `report.md`. A filtered or pilot build never emits deletions. | header read from dcosl | no |
| `npm run sign -- <run>` | Write `signed.jsonl` | none | yes |
| `npm run publish -- <run> [--relays dcosl,search]` | Publish and record | relays | no |
| `npm run verify` | Read back and compare | relays | no |
| `npm run header:rebroadcast` | Copy Avi's signed header, byte for byte, from dcosl to the search relay | relays | no |
| `npm run console` | Start the local console | relays (read) | no |

Each step writes files the next one reads, so Avi can inspect any stage before it continues.

### 6.3 Config (`config.json`, committed)

Holds:
- the header coordinate;
- the curator pubkey (used only to check the key);
- relay URLs;
- scope lists;
- the throttle;
- the BTC Map fields list.

The header author's pubkey is the one inside the coordinate. `build` reads the header live and stops if it is missing or its `required` fields have changed.

### 6.4 Key handling

- **Where the key lives:**
  - Avi writes it himself, as an `nsec` or a NIP-49 `ncryptsec`.
  - It goes to a file outside any repo. The default is `~/.config/mise-en-place/curator.key`; `MISE_KEY_FILE` overrides it.
- **Checks before use:** the tool refuses a file whose mode is wider than 600, then checks the derived pubkey against `config.curatorPubkey`.
- **Encrypted keys:** for an `ncryptsec`, the passphrase is read from a TTY prompt and never taken as an argument.
- **Never exposed:** the key is never logged, printed, passed on a command line or written anywhere else.
- **Rehearsal:** uses a throwaway key and `config.rehearsal.json`.
- **`.gitignore`** covers `data/`, `out/`, `state/` and `*.key`.

## 7. Workflows

### 7.1 Rehearsal (before anything touches a public relay)

1. Run an isolated local relay (`nak serve`, no router).
2. Run the full pipeline against it with a throwaway key, using `config.rehearsal.json`.
3. Check that verify matches, that a second build produces zero changes, and that a simulated change and a simulated deletion behave correctly.
4. Keep the throwaway key so any stray event could still be deleted.

Tapestry's ledger records 6,377 test events that leaked to production relays through strfry-router. Isolation prevents that here.

### 7.2 Pilot

1. Run `header:rebroadcast` to the search relay.
2. Build about 150 US items with `--pilot --filter country=US`. The selection is deterministic, spread across categories and states.
3. Sign and publish to both relays, then verify.
4. Avi looks at them:
   - Brainstorm staging, admin view: the item page renders through `DListItemHero`. The Dictionary entry needs the config registration, which is Vinney's step.
   - The search relay: a NIP-50 query for a cuisine and a city, to test the `t` tokenization question in § 5.
   - The console.
5. Fix field names or tag shapes now; they are expensive to change after the full import.

### 7.3 Full import, then monthly refresh

The same command sequence runs for both:

```
fetch → build → (review report.md) → sign → publish → verify
```

- **New and changed** places become new item versions.
- **Gone** places become kind 5 deletions. A place is gone when it is no longer in the latest fetch or no longer in scope. (BTC Map's default sync omits deleted places, so absence is enough.)
- **Unchanged** places are untouched.

The report shows counts for each class. Before any deletion run, the report asks for confirmation when deletions exceed a threshold (default 2% of items), as a guard against a bad fetch.

## 8. Console (localhost, read-only)

A single page served by `npm run console` on `127.0.0.1`.

- **Overview:**
  - item counts by status;
  - counts per relay, read live, set against state;
  - field coverage;
  - the latest run.
- **Table:** search and filter by category, country, locality and cuisine, with a link to each item's raw event.
- **Map:** Leaflet with OSM tiles and attribution, clustered markers.
- **Diff:** what the next build would do (new, changed, gone) against the latest cache.
- **Runs:** the publish history per run and relay, with failures listed.

There is no trust filter and no item cap: it reads state and the relays directly. It doesn't write. Writes happen only through the CLI, so the key never meets the browser.

Not built now:
- Hand curation (adding or fixing places by hand). This needs an override rule first, because a later BTC Map refresh would otherwise overwrite hand edits to the same `d`.
- Other sources (Overpass). The source adapter boundary in § 6.1 keeps both open.

## 9. Testing

- **Unit:**
  - `item.ts` against the place-15 fixture and the geohash vector;
  - the `accepts-bitcoin` truth table, including `no` values;
  - scope precedence (amenity before shop before craft);
  - `t` derivation and deduplication;
  - omission of empty fields;
  - deterministic output.
- **Diff and deletion:** the change hash ignores `created_at`, and a deletion lists every recorded version id.
- **Sign:** refuses a mismatched pubkey and refuses a world-readable key file. A test key is used.
- **Integration:** the rehearsal in § 7.1, scripted against a local relay.

## 10. Attribution and licence

- **Data:**
  - © OpenStreetMap contributors, under the ODbL 1.0.
  - Every item carries `osm-id`, `source` and `license`. The header already carries the description notice and `r` links.
  - The README repeats the notice and credits BTC Map.
- **Code:** MIT (`LICENSE`).
- **Not committed:** fetched data and built output stay gitignored, so the repo holds code and config, not an ODbL extract.

## 11. What stays outside this tool

- Registering the coordinate in Brainstorm-UI's `dictionary.config.json` (`"search": true`), which is Vinney's PR. The Dictionary and list search are on Brainstorm `staging` only, and are admin-only today.
- Brainstorm's 500-item read cap and server-side list search (not built). Until then Brainstorm shows at most 500 of these items.
- Chain restaurants: Brainstorm groups items with the same `name` as one thing.
- Tapestry: its Dictionary reads only items in an instance's local strfry, and dcosl sync is off by default. GUM₁ for this concept stays at 1 or below with a single curator.
- Tapestry Tags for cuisine (W20 tagging collision; tag shape undecided).
- Curator profile and `bot: true`.

## 12. Resolved review items

1. Code licence: MIT (Avi, 2026-10-05).
2. Pilot spread: about 150 places spread across the US, not one city (Avi, 2026-10-05).
