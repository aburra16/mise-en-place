# Food and Drink DList Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI pipeline that turns BTC Map's food and drink places into kind 39999 DList items signed by the Mise en Place curator, publishes them to two relays, keeps them current (changed items republished, gone items deleted), and a local read-only console to inspect it all.

**Architecture:** Staged files. `fetch` caches raw BTC Map JSON, `build` (pure apart from one header read) writes unsigned JSONL, `sign` (the only step that loads the key) writes signed JSONL, and `publish` sends it and records every event id per relay in SQLite. `verify` reads back from the relays, and `console` serves state, the cache and live relay counts on localhost.

**Tech Stack:** Node 23 (ESM), TypeScript run via `tsx`, `vitest`, `nostr-tools@2.25`, `@rapideditor/country-coder@5`, `ngeohash@0.6`, `better-sqlite3`, `nak serve` for integration tests, Leaflet and Leaflet.markercluster from unpkg for the console.

**Spec:** `docs/specs/2026-10-05-food-dlist-importer-design.md`

## Global Constraints

- **Header coordinate:** `39998:b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450:food-and-drink-places`. It lives only in `config.json`.
- **Curator pubkey:** `4bded2172075221ead393a0baec9c530238ec192c2a9cdbbc7754ba8c3357b64`. It lives only in `config.json` and is used only to check the loaded key.
- **Relays:** `wss://dcosl.brainstorm.world` and `wss://search.brainstorm.world`, from config.
- **Kinds:** items are kind 39999, deletions kind 5. The tool never signs a 39998.
- **Item `d`:** `osm-` + `osm_id` with `:` replaced by `-`.
- **Item tags:** exactly one `z`. Never `["z","list"]` or `b`/`p`/`e`/`a`/`i` tags on items.
- **Empty values:** a field with no value (after trimming) is omitted, never written empty.
- **Secrets:** the key is read from `MISE_KEY_FILE` (default `~/.config/mise-en-place/curator.key`). The file must be mode 600 or narrower. It is never logged, printed, passed as an argument or included in an error message.
- **Republishing:** unchanged items are never republished.
- **Deletions:** a deletion carries one `e` tag for every version id ever recorded, plus an `a` tag and `["k","39999"]`.
- **Filtered builds:** a filtered or pilot build never emits deletions.
- **Deletion guard:** deletions above 2% of live items abort `build` unless `--allow-deletions` is passed.
- **Throttle:** 5 events per second per relay by default (`config.publish.eventsPerSecond`).
- **Git:** `data/`, `out/`, `state/` and `*.key` are gitignored. The repo holds no ODbL extract.
- **Rehearsal:** never publish to a public relay from a test. Integration tests use `nak serve` on localhost only.

## Review Focus

1. **A bad or partial BTC Map fetch** (HTTP error, non-array body, or far fewer places than the last cache): `fetch` refuses to write the cache file, so no mass deletion follows. Tests are in Task 2.
2. **A pilot or filtered build run after a full import:** it must not mark the thousands of places outside the filter as gone. Tests are in Task 6.
3. **A publish interrupted midway, or one relay rejecting events:** a re-run sends only the (event, relay) pairs not yet accepted. State never claims an item is published on a relay that didn't send OK. Tests are in Task 8.
4. **Two BTC Map places with the same `osm_id`:** none exist today, but a future fetch could have them. `build` keeps the lowest `btcmap-id`, lists the duplicate in the report, and never emits two events with one `d`. Tests are in Task 6.
5. **Values that are whitespace-only, padded, or `http://`:** whitespace-only values are omitted, padded values are trimmed, and an `http://` image is dropped. Tests are in Task 4.

---

### Task 1: Scaffold and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `config.json`, `config.rehearsal.example.json`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Config {
    headerCoordinate: string; curatorPubkey: string;
    relays: Record<string, string>;          // name -> url, e.g. { dcosl: "wss://…", search: "wss://…" }
    headerRelay: string;                     // relay name used for the header read
    scope: { amenity: string[]; shop: string[]; craft: string[] };
    btcmapFields: string[];
    publish: { eventsPerSecond: number; okTimeoutMs: number };
    deletionGuardFraction: number;           // 0.02
    pilotSize: number;                       // 150
    paths: { data: string; out: string; state: string };
  }
  export function loadConfig(path?: string): Config;   // path ?? process.env.MISE_CONFIG ?? "config.json"
  export function headerAuthor(coordinate: string): string;
  ```

- [ ] **Step 1: Write the scaffold.**
  - **`package.json`:**
    - `"type": "module"`;
    - scripts: `fetch`, `census`, `build`, `sign`, `publish`, `verify`, `header:rebroadcast`, `console`, each `tsx src/cli.ts <name>`;
    - `"test": "vitest run"` and `"typecheck": "tsc --noEmit"`;
    - `engines.node >= 20`.
  - **Dependencies:** install `nostr-tools@2.25.2 @rapideditor/country-coder ngeohash better-sqlite3`, and as dev dependencies `typescript tsx vitest @types/node @types/better-sqlite3 @types/ngeohash`.
  - **`.gitignore`:** `node_modules/ data/ out/ state/ *.key config.rehearsal.json`.
  - **`config.json` scope lists**, copied from spec §4:
    - amenity: restaurant, cafe, fast_food, bar, pub, biergarten, food_court, ice_cream;
    - shop: bakery, pastry, confectionery, chocolate, deli, cheese, butcher, seafood, greengrocer, farm, dairy, spices, coffee, tea, wine, alcohol, beverages, health_food;
    - craft: brewery, winery, distillery.
  - **`btcmapFields`:** `id,lat,lon,name,address,opening_hours,osm_id,phone,website,description,image,osm:amenity,osm:shop,osm:craft,osm:cuisine,osm:addr:city,osm:addr:state,osm:addr:postcode,osm:addr:country,osm:payment:lightning,osm:payment:onchain,osm:payment:lightning_contactless`.
  - **Other `config.json` values:**
    - `headerRelay` is `"dcosl"`;
    - `publish` is `{ "eventsPerSecond": 5, "okTimeoutMs": 10000 }`;
    - `deletionGuardFraction` is `0.02`;
    - `pilotSize` is `150`;
    - `paths` is `{ "data": "data", "out": "out", "state": "state/state.sqlite" }`.
  - **`config.rehearsal.example.json`:** the same, except `relays` is `{ "local": "ws://localhost:10547" }`, `headerRelay` is `"local"`, `curatorPubkey` is `"<throwaway pubkey>"` and `paths.state` is `"state/rehearsal.sqlite"`.

- [ ] **Step 2: Write the failing tests** in `tests/config.test.ts`:
  - `loads config.json and exposes the header coordinate`: equals the Global Constraints value.
  - `headerAuthor extracts the pubkey`: `headerAuthor(cfg.headerCoordinate) === "b83a28b7…9450"`.
  - `rejects a malformed coordinate`: `loadConfig` on a temp file whose coordinate is `"39998:abc"` throws `/headerCoordinate/`.
  - `rejects a curatorPubkey that is not 64 hex chars`: throws `/curatorPubkey/`.
  - `MISE_CONFIG selects the file`: set the env var to a temp config with relay `ws://x`, and `loadConfig().relays` reflects it.

- [ ] **Step 3: Run** `npx vitest run tests/config.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement `src/config.ts`.** Validate the coordinate with `/^39998:[0-9a-f]{64}:[^:]+$/` and the pubkey with `/^[0-9a-f]{64}$/`.
- [ ] **Step 5: Run the tests and `npm run typecheck`.** Expected: PASS, no type errors.
- [ ] **Step 6: Commit** `feat: scaffold project and config loader`.

### Task 2: BTC Map source adapter

**Files:**
- Create: `src/place.ts`, `src/source/btcmap.ts`, `tests/fixtures/place-15.json`
- Test: `tests/btcmap.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces:
  ```ts
  // src/place.ts — source-neutral record; every string field already trimmed, "" never present (use undefined)
  export interface Place {
    sourceId: string; osmId: string; name?: string; lat: number; lon: number;
    address?: string; city?: string; state?: string; postcode?: string; countryTag?: string;
    amenity?: string; shop?: string; craft?: string; cuisine?: string;  // cuisine = raw OSM value, e.g. "pizza;italian"
    website?: string; phone?: string; openingHours?: string; description?: string; image?: string;
    payment: { lightning?: string; onchain?: string; lightningContactless?: string };
  }
  // src/source/btcmap.ts
  export type RawPlace = Record<string, unknown>;
  export function placesUrl(fields: string[]): string;
  export function normalize(raw: RawPlace): Place;
  export async function fetchPlaces(cfg: Config, opts?: { fetchImpl?: typeof fetch; today?: string }): Promise<{ path: string; count: number }>;
  export function latestCachePath(cfg: Config): string | null;   // newest data/cache/places-*.json
  export function readCache(path: string): RawPlace[];
  ```

- [ ] **Step 1: Write the fixture.** `tests/fixtures/place-15.json` holds exactly:
  ```json
  {"id":15,"lat":46.0042728,"lon":8.9502477,"name":"Gabbani Enoteca","address":"1 Piazza Cioccaro Lugano 6900","osm_id":"node:10011069455","phone":"+41 91 911 30 80","website":"https://www.gabbani.com/home/","osm:amenity":"restaurant","osm:addr:city":"Lugano","osm:addr:postcode":"6900","osm:payment:lightning":"yes","osm:payment:onchain":"no","osm:payment:lightning_contactless":"no"}
  ```
- [ ] **Step 2: Write the failing tests:**
  - `normalize maps place 15`:
    - `sourceId` is `"15"`, `osmId` is `"node:10011069455"`, `amenity` is `"restaurant"`, `city` is `"Lugano"`, `postcode` is `"6900"`;
    - `payment.lightning` is `"yes"` and `payment.onchain` is `"no"`;
    - `cuisine` is `undefined`.
  - `normalize trims and drops blank strings`: `{name:"  X  ", address:"   "}` gives `name === "X"` and `address === undefined`.
  - `placesUrl encodes colons`: the URL contains `fields=` and `osm%3Aamenity`, and has no raw `osm:`.
  - `fetchPlaces writes a dated cache`:
    - setup: a stubbed `fetchImpl` returns a 200 with a 3-element array, and `today` is `"2026-10-05"`;
    - the file `data/cache/places-2026-10-05.json` (under a temp `paths.data`) exists with 3 records, and `count === 3`.
  - `fetchPlaces refuses a non-200`: rejects `/HTTP 503/`, and no file is written.
  - `fetchPlaces refuses a non-array body`: rejects `/array/`.
  - `fetchPlaces refuses a shrunken fetch`: an existing cache has 1000 records and the stub returns 400. Rejects `/fewer than half/`, and the old cache is untouched.
- [ ] **Step 3: Run** `npx vitest run tests/btcmap.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Points the tests don't fix:
  - `fetchPlaces` writes to a `.tmp` file, then renames it.
  - It refuses when the new count is under 50% of the latest cache's count.
  - `normalize` maps:
    - `osm:addr:city` → `city`, `osm:addr:state` → `state`, `osm:addr:postcode` → `postcode`, `osm:addr:country` → `countryTag`;
    - `opening_hours` → `openingHours`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: BTC Map source adapter with guarded cache fetch`.

### Task 3: Scope classification

**Files:**
- Create: `src/scope.ts`
- Test: `tests/scope.test.ts`

**Interfaces:**
- Consumes: `Place`, `Config["scope"]`.
- Produces: `export function classify(place: Place, scope: Config["scope"]): string | null;`. It returns the `category` value, or `null` when the place is out of scope.

- [ ] **Step 1: Write the failing tests:**
  - `amenity restaurant → "restaurant"`.
  - `amenity wins over shop`: `{amenity:"cafe", shop:"bakery"}` gives `"cafe"`.
  - `shop used when amenity is out of scope`: `{amenity:"atm", shop:"bakery"}` gives `"bakery"`.
  - `craft brewery → "brewery"` when amenity and shop are absent.
  - `supermarket and convenience are out`: `null`.
  - `caterer and marketplace are out`: `{craft:"caterer"}` and `{amenity:"marketplace"}` give `null`.
  - `no name → null` even for a restaurant.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `classify`.** Order: amenity, then shop, then craft. Each is checked against its config list, and the place needs a `name`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: scope classification`.

### Task 4: Item builder

**Files:**
- Create: `src/item.ts`
- Test: `tests/item.test.ts`

**Interfaces:**
- Consumes: `Place`, `classify` output.
- Produces:
  ```ts
  export type Tags = string[][];
  export function dTag(osmId: string): string;                       // "node:1" -> "osm-node-1"
  export function geohashes(lat: number, lon: number): string[];     // [p9, p6, p5, p4]
  export function acceptsBitcoin(p: Place["payment"]): "both" | "lightning" | "onchain" | "yes";
  export function countryOf(place: Place): string | undefined;       // country-coder iso1A2Code([lon, lat]) ?? countryTag
  export function deriveT(category: string, cuisine: string | undefined, locality: string | undefined): string[];
  export function buildItem(place: Place, category: string, headerCoordinate: string): Tags;
  ```

- [ ] **Step 1: Write the failing tests:**
  - **`place 15 builds exactly the expected tags`:** `buildItem(normalize(fixture), "restaurant", COORD)` deep-equals:
    ```ts
    [["d","osm-node-10011069455"],["z",COORD],["name","Gabbani Enoteca"],["category","restaurant"],
     ["address","1 Piazza Cioccaro Lugano 6900"],["locality","Lugano"],["postal-code","6900"],["country","CH"],
     ["osm-id","node:10011069455"],["lat","46.0042728"],["lon","8.9502477"],
     ["website","https://www.gabbani.com/home/"],["phone","+41 91 911 30 80"],["accepts-bitcoin","lightning"],
     ["btcmap-id","15"],["source","btcmap"],["license","ODbL-1.0"],
     ["g","u0nmewv67"],["g","u0nmew"],["g","u0nme"],["g","u0nm"],
     ["t","restaurant"],["t","lugano"],
     ["alt","Food and drink place: Gabbani Enoteca, Lugano"]]
    ```
  - **`geohash vector`:** `geohashes(46.0042728, 8.9502477)` gives `["u0nmewv67","u0nmew","u0nme","u0nm"]`.
  - **`acceptsBitcoin truth table`:**

    | lightning | onchain | contactless | result |
    |---|---|---|---|
    | yes | yes | – | both |
    | yes | no | – | lightning |
    | no | yes | – | onchain |
    | – | – | yes | lightning |
    | no | no | – | yes |
    | – | – | – | yes |

  - **`cuisine takes the first value, lowercased`:** cuisine `" Pizza;Italian"` gives the tag `["cuisine","pizza"]`, and `t` includes both `pizza` and `italian`.
  - **`deriveT`:** `deriveT("fast_food","burger;Burger;fries","Austin")` gives `["fast food","burger","fries","austin"]`.
  - **`field order follows spec §5`:** a fully populated place yields tag names in this order: `d z name category address locality region postal-code country cuisine osm-id lat lon website phone opening-hours description image accepts-bitcoin btcmap-id source license g g g g t… alt`.
  - **`missing fields are omitted`:** a place with only name, lat, lon and osmId has no `address`/`locality`/`website` tags, and no tag anywhere has a value of `""`.
  - **`http image dropped, https kept`.**
  - **`alt without locality`:** `["alt","Food and drink place: X"]`.
  - **`country falls back to the addr tag`:** at lat 0, lon -160 (open ocean) with `countryTag "US"` gives `["country","US"]`. With no `countryTag`, there is no country tag.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use `ngeohash.encode(lat, lon, 9)` and slice it for the prefixes.
  - Use `iso1A2Code` from `@rapideditor/country-coder`.
  - `lat` and `lon` are `String(n)`.
  - The `alt` text is exactly `Food and drink place: <name>, <locality>`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: item builder`.

### Task 5: State store

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LiveItem { d: string; contentHash: string; tagsJson: string; latestEventId: string }
  export interface State {
    liveItems(): Map<string, LiveItem>;
    versionsOf(d: string): string[];                         // every kind-39999 event id ever recorded for d, any relay, ok or not
    acceptedOn(eventId: string, relay: string): boolean;
    recordResult(r: { eventId: string; d: string; kind: number; createdAt: number; runId: string; relay: string; ok: boolean; message: string }): void;
    markLive(d: string, contentHash: string, tagsJson: string, eventId: string, at: number): void;
    markDeleted(d: string, at: number): void;
    runs(): { runId: string; relay: string; ok: number; failed: number }[];
    close(): void;
  }
  export function openState(path: string): State;           // ":memory:" allowed; creates schema (spec §6.1)
  ```

- [ ] **Step 1: Write the failing tests** (all on `:memory:`):
  - `markLive then liveItems returns it`.
  - `markLive again replaces hash and latestEventId`, while `versionsOf` keeps both ids once both were recorded with `recordResult`.
  - `markDeleted removes from liveItems`, and `versionsOf` is unchanged.
  - `acceptedOn true only for ok=true results on that relay`.
  - `runs aggregates ok and failed per run and relay`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement with `better-sqlite3`.**
  - Tables `items` and `events`, as in spec §6.1. `events` has primary key `(event_id, relay)`, and a re-recorded pair updates `ok`/`message`.
  - `items.status` is `live` or `deleted`.
  - Create the parent directory of the state path.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: SQLite state store`.

### Task 6: Diff, deletions, pilot selection, and the build command

**Files:**
- Create: `src/diff.ts`, `src/deletion.ts`, `src/pilot.ts`, `src/header.ts`, `src/commands/build.ts`, `src/commands/census.ts`, `src/cli.ts`
- Test: `tests/diff.test.ts`, `tests/build.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  ```ts
  // src/diff.ts
  export function contentHash(tags: Tags): string;          // sha256 hex of JSON.stringify(tags)
  export interface Diff { created: Tags[]; changed: Tags[]; unchanged: number; gone: string[] }   // gone = d values
  export function diffItems(built: Map<string, Tags>, live: Map<string, LiveItem>, opts: { detectGone: boolean }): Diff;
  // src/deletion.ts
  export type Unsigned = { kind: number; tags: Tags; content: string };   // created_at added at signing
  export function deletionFor(d: string, versionIds: string[], curatorPubkey: string): Unsigned;
  // src/pilot.ts
  export function selectPilot(items: Tags[], n: number): Tags[];
  // src/header.ts
  export async function fetchHeader(relayUrl: string, coordinate: string): Promise<NostrEvent | null>;
  export function checkHeader(ev: NostrEvent | null, coordinate: string): void;  // throws if missing, wrong author/d, or required != ["name","category"]
  // src/commands/build.ts
  export interface BuildOptions { pilot?: number; filter?: Record<string, string>; allowDeletions?: boolean; runId?: string; header?: NostrEvent }  // header injectable for tests
  export interface BuildResult { runDir: string; created: number; changed: number; unchanged: number; deletions: number; skipped: Record<string, number>; duplicates: string[] }
  export async function build(cfg: Config, state: State, opts: BuildOptions): Promise<BuildResult>;
  // src/commands/census.ts
  export function census(cfg: Config, cachePath: string): string;  // markdown
  ```

- [ ] **Step 1: Write the failing tests** in `tests/diff.test.ts`:
  - `identical tags → unchanged`.
  - `changed value → changed`.
  - `new d → created`.
  - `detectGone true: live d absent from built → gone`.
  - `detectGone false: nothing is gone` (Review Focus 2).
  - `deletionFor lists every version`: with 2 ids, the tags are `[["e",id1],["e",id2],["a","39999:<curator>:<d>"],["k","39999"]]`, the kind is 5 and the content is `""`.
  - `selectPilot is deterministic and spread`:
    - the same input gives the same output;
    - the output has `n` items;
    - with 3 two-character geohash cells, each holding 10 items of mixed categories, and `n=6`, every cell contributes 2 items and categories alternate within each cell.
- [ ] **Step 2: Write the failing tests** in `tests/build.test.ts`. The setup is a temp config whose cache is a fixture array of 6 raw places:
  - 4 in scope: 3 in the US (including one restaurant and one brewery) and place 15;
  - 1 supermarket;
  - 1 restaurant sharing place 15's `osm_id` with a higher `id`.

  The header is injected as a valid event. Tests:
  - `first build writes all in-scope items`:
    - `unsigned.jsonl` has 4 lines, all kind 39999;
    - `skipped["out-of-scope"] === 1`;
    - `duplicates` names the duplicated `osm_id` and keeps id 15 (Review Focus 4);
    - `report.md` exists.
  - `filter country=US builds only US items and emits no deletions`, even when state has live items outside the US (Review Focus 2).
  - `rebuild against state with the same hashes writes zero events`.
  - `a place missing from the cache becomes a kind-5 deletion with all its versions` (full build only).
  - `deletions over the guard abort`: when state has 100 live items and the cache drops 3, the build throws `/allow-deletions/`, and with `allowDeletions` it succeeds.
  - `checkHeader rejects a header whose required set changed`.
- [ ] **Step 3: Run both files.** Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **`selectPilot`:**
    - bucket by the first 2 characters of the first `g` value;
    - order buckets by key;
    - within a bucket, round-robin across categories, each category ordered by `btcmap-id` numerically;
    - then round-robin across buckets until `n` are taken.
  - **`build`:**
    - read the latest cache, normalize and classify;
    - deduplicate by `d`, keeping the lowest `btcmap-id`;
    - apply the `filter` (`country` and `category` keys, matched against the built tags);
    - apply `pilot`;
    - diff with `detectGone = !filter && !pilot`;
    - apply the guard: deletions over `deletionGuardFraction × live` throw unless `allowDeletions`;
    - write `out/<runId>/unsigned.jsonl`, with items first and deletions last;
    - write `manifest.json` (options, cache path, counts) and `report.md`. The report has the counts, skipped places by reason, duplicates, field coverage over the built items, and 20 sample items.
  - **`fetchHeader`:** uses nostr-tools `Relay` with the filter `{kinds:[39998], authors:[author], "#d":[d]}`.
  - **`cli.ts`:** dispatches the script names to commands and parses `--pilot [N]`, `--filter k=v`, `--allow-deletions` and `--relays a,b`.
  - **`census`:** prints counts by amenity, shop and craft, the in-scope total, field coverage, and skips by reason.
- [ ] **Step 5: Run.** Expected: PASS. Run `npm run typecheck` too.
- [ ] **Step 6: Commit** `feat: diff, deletions, pilot selection, build and census commands`.

### Task 7: Key loading and signing

**Files:**
- Create: `src/key.ts`, `src/commands/sign.ts`
- Test: `tests/sign.test.ts`

**Interfaces:**
- Consumes: `Unsigned` (Task 6), `Config`.
- Produces:
  ```ts
  export async function loadKey(path: string, expectedPubkey: string, askPassphrase: () => Promise<string>): Promise<Uint8Array>;
  export async function sign(cfg: Config, runDir: string, opts?: { keyPath?: string; askPassphrase?: () => Promise<string>; now?: () => number }): Promise<{ signed: number }>;
  ```

- [ ] **Step 1: Write the failing tests.** Each test generates its key in a temp dir with `generateSecretKey()`:
  - `loads an nsec file at mode 600`.
  - `refuses mode 644`: throws `/mode/`, and the message does not contain `nsec1`.
  - `refuses a key whose pubkey differs from config`: throws `/does not match/`. The message names both pubkeys and contains no secret.
  - `loads an ncryptsec with the passphrase from askPassphrase`.
  - `missing file`: throws `/MISE_KEY_FILE/`.
  - `sign writes verifiable events`:
    - `signed.jsonl` has one line per unsigned line;
    - each line passes `verifyEvent`;
    - `pubkey` equals the curator;
    - `created_at` equals the injected `now()`;
    - the tags are byte-identical to the input.
  - `sign refuses to overwrite an existing signed.jsonl`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Check `fs.statSync(path).mode & 0o077` is 0.
  - Accept a trimmed file body that starts with `nsec1` (via `nip19.decode`) or `ncryptsec1` (via `nip49.decrypt`).
  - Derive the pubkey with `getPublicKey`, then sign with `finalizeEvent`.
  - The default `askPassphrase` reads from the TTY with echo off. Use `readline`, muting output.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: key loading and signing`.

### Task 8: Relay IO: publish, verify, header rebroadcast (integration-tested)

**Files:**
- Create: `src/relay.ts`, `src/commands/publish.ts`, `src/commands/verify.ts`, `src/commands/header-rebroadcast.ts`, `tests/integration/nak.ts`
- Test: `tests/integration/pipeline.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // src/relay.ts
  export async function publishEvent(url: string, ev: NostrEvent, timeoutMs: number): Promise<{ ok: boolean; message: string }>;
  export async function queryAll(url: string, filter: Filter, pageSize?: number): Promise<NostrEvent[]>;  // paginates with until, default page 500
  // src/commands/publish.ts
  export async function publish(cfg: Config, state: State, runDir: string, relayNames?: string[]): Promise<Record<string, { sent: number; ok: number; failed: number; skipped: number }>>;
  // src/commands/verify.ts
  export async function verify(cfg: Config, state: State): Promise<Record<string, { onRelay: number; inState: number; missing: string[]; extra: string[] }>>;
  // src/commands/header-rebroadcast.ts
  export async function rebroadcastHeader(cfg: Config, toRelay: string): Promise<{ ok: boolean; message: string }>;
  // tests/integration/nak.ts
  export async function startNak(port: number): Promise<{ url: string; stop(): Promise<void> }>;  // spawns `nak serve --port`, waits for the port
  ```

- [ ] **Step 1: Write `tests/integration/nak.ts`, then the failing tests** in `pipeline.test.ts`. One `nak serve` runs on port 10599, with a temp config pointing both relay names at it. A generated test key acts as the curator, and the header is published to the local relay signed by a second generated key. Tests:
  - `full cycle`: build, sign, publish, then verify. `missing` and `extra` are empty, and every item is live in state.
  - `rebuild is a no-op`: a second build writes 0 events.
  - `a changed place republishes only that item`: rename one place in the cache and rebuild, giving 1 changed. After sign and publish, `versionsOf(d)` has 2 ids.
  - `a removed place is deleted with every version`:
    - remove that place, rebuild with `allowDeletions`, then sign and publish;
    - the kind 5 carries both `e` ids;
    - `queryAll` no longer returns the item;
    - state marks it deleted.
  - `interrupted publish resumes` (Review Focus 3):
    - make `publish`'s `onEventSent` test hook throw after half the events, simulating a crash, and keep the relay running, since `nak serve` is in-memory;
    - run `publish` again on the same run directory;
    - the second run's `skipped` equals the first run's `ok`, and the final verify is clean.
  - `rejected events are recorded as failed and not marked live`. Publish an event with a broken signature to the relay: the result is `ok: false`, and `markLive` is not called for it.
  - `header rebroadcast copies the event byte for byte`: the event fetched from the target has the same `id` and `sig`.
- [ ] **Step 2: Run** `npx vitest run tests/integration`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`publishEvent`:** one `Relay.connect` per relay per run, reused. `relay.publish` resolves to OK; a rejection carries the relay's message. The event is timed out after `okTimeoutMs`.
  - **`publish`:**
    - throttle to `eventsPerSecond` per relay;
    - on a message starting `rate-limited`, back off for 30 s and retry that event once;
    - record every result with `recordResult`;
    - call `markLive` for an item event on its first OK on any relay;
    - call `markDeleted` for a kind 5 on its first OK;
    - skip pairs where `acceptedOn` is true;
    - accept an optional `onEventSent` test hook in an options argument.
  - **`verify`:** for each relay, `queryAll({kinds:[39999], authors:[curator], "#z":[coord]})`, compared with `liveItems()` by `d`.
  - **`rebroadcastHeader`:** `fetchHeader` from `headerRelay`, then `publishEvent` of that exact object to the target.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: publish, verify and header rebroadcast with nak-based integration tests`.

### Task 9: Console

**Files:**
- Create: `src/console/server.ts`, `src/console/public/index.html`, `src/console/public/app.js`, `src/console/public/style.css`
- Test: `tests/console.test.ts`

**Interfaces:**
- Consumes: `State`, `latestCachePath`, `readCache`, `normalize`, `classify`, `buildItem`, `diffItems`, `queryAll`, `Config`.
- Produces: `export function startConsole(cfg: Config, state: State, port = 4517): Promise<{ url: string; close(): Promise<void> }>;`. It binds `127.0.0.1` only. Routes:
  - `GET /api/overview`: `{ live, deleted, coverage: Record<field, pct>, lastRun }`.
  - `GET /api/items?q=&category=&country=&locality=&cuisine=&offset=&limit=`: `{ total, items: {d, eventId, fields: Record<string,string>}[] }`. `limit` is at most 500.
  - `GET /api/points`: `[d, lat, lon, name, category][]` for every live item, for the map.
  - `GET /api/diff`: `{ created, changed, unchanged, gone }` counts plus up to 50 examples each, from the latest cache against state (full-build semantics).
  - `GET /api/runs`: from `state.runs()`.
  - `GET /api/relays`: live per-relay counts via `queryAll`.
  - `GET /api/item/:d`: tags and every version id.

- [ ] **Step 1: Write the failing tests** against a temp state seeded with 3 live items and a fixture cache:
  - `overview counts`.
  - `items filter by category and q (name substring, case-insensitive)`.
  - `points has one row per live item`.
  - `diff matches diffItems`.
  - `binds 127.0.0.1 only`: `server.address().address === "127.0.0.1"`.
  - `no route writes state`: a POST to any path returns 405.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Server:** `node:http` with static files from `public/`. `/api/relays` is computed on request, not at startup.
  - **Page:** a single page with five sections (Overview, Table, Map, Diff, Runs).
    - The table has filter inputs and paginates by 100.
    - The map uses Leaflet 1.9 and Leaflet.markercluster from unpkg, OSM tiles with the attribution `© OpenStreetMap contributors`, and a popup with name, category and a link to the item.
    - Colors are CSS custom properties, with light and dark via `prefers-color-scheme`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Check it in the browser.**
  - Run `npm run console` with the rehearsal state from Task 10, then open `http://127.0.0.1:4517` in the preview browser.
  - Check that the map renders clusters, the table filters, and the console shows no errors.
- [ ] **Step 6: Commit** `feat: local read-only console`.

### Task 10: README, census and rehearsal (no public relay)

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`:**
  - what this is;
  - the header coordinate;
  - the commands in order;
  - key setup (`mkdir -p ~/.config/mise-en-place`, then Avi writes the nsec or ncryptsec to `curator.key` and runs `chmod 600`);
  - rehearsal;
  - refresh;
  - the attribution notice: "Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0). Seeded from BTC Map (btcmap.org)." with links to `openstreetmap.org/copyright` and the ODbL text;
  - an "Import log" table (date, run, created, changed, deleted, relays) to fill in per run.
- [ ] **Step 2: Real census.** Run `npm run fetch`, then `npm run census > out/census-2026-10-05.md`. Expected: an in-scope total of about 7,960 (7,854 plus about 106 craft).
- [ ] **Step 3: Rehearsal (spec §7.1).**
  - Start `nak serve` in the background. Generate a throwaway key with `nak key generate` into `~/.config/mise-en-place/rehearsal.key` (mode 600, kept).
  - Create `config.rehearsal.json` from the example, with the throwaway pubkey.
  - Copy Avi's real header to the local relay only: `nak req -k 39998 -a b83a28b7e4e5d20bd960c5faeb6625f95529166b8bdb045d42634a2f35919450 -d food-and-drink-places wss://dcosl.brainstorm.world | nak event ws://localhost:10547`.
  - Run every following command with `MISE_CONFIG=config.rehearsal.json`.
  - Build the full set, then sign with `MISE_KEY_FILE` pointing at the rehearsal key, then publish and verify.
  - Expected: verify is clean for about 7,960 items, and a rebuild writes 0 events.
- [ ] **Step 4: Run the console on the rehearsal state** (Task 9 step 5) and screenshot it for Avi.
- [ ] **Step 5: Commit** `docs: README with attribution and runbook`.

### Task 11: Pilot (needs Avi: key file and an explicit go)

- [ ] **Step 1:** Avi writes `~/.config/mise-en-place/curator.key` himself and runs `chmod 600`. Claude never sees the value.
- [ ] **Step 2:** Run `npm run header:rebroadcast -- search`. Expected: OK. Read it back from `wss://search.brainstorm.world`.
- [ ] **Step 3:** Run `npm run build -- --pilot 150 --filter country=US`. Show Avi `report.md`.
- [ ] **Step 4:** On Avi's go, run `npm run sign -- <run>`, then `npm run publish -- <run>`, then `npm run verify`. Expected: both relays hold 150 items, with `missing` empty.
- [ ] **Step 5: Check the result.**
  - Run a NIP-50 query on `wss://search.brainstorm.world` for a cuisine word and for a two-word city (with `include:spam`). This answers the `t` tokenization question in spec §5.
  - If two-word values don't match, change `deriveT` to hyphenate, update its test, and rebuild. The changed items republish.
- [ ] **Step 6:** Avi reviews the items in the console and on a Brainstorm staging item page. Fix any schema issues before Task 12.
- [ ] **Step 7:** Record the run in the README's import log and commit.

### Task 12: Full import (needs Avi's explicit go)

- [ ] **Step 1:** Run `npm run fetch`, then `npm run build`. Expected: about 7,810 created, 0 deletions. Show Avi `report.md`.
- [ ] **Step 2:** On Avi's go: sign, publish, then verify. Expected: verify is clean on both relays.
- [ ] **Step 3:** Record the run in the import log and commit. Tell Avi what remains, from spec §11.
