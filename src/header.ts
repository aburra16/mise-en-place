import type { AbstractRelay } from "nostr-tools/abstract-relay";
import type { NostrEvent } from "nostr-tools/core";
import { connectRelay } from "./relay.js";

const HEADER_KIND = 39998;
/** The fields every item this tool builds carries; the header must require exactly these. */
const REQUIRED_FIELDS = ["category", "name"];
const DEFAULT_TIMEOUT_MS = 10_000;

/** Splits `<kind>:<pubkey>:<d>`; the `d` part may itself contain colons. */
function parseCoordinate(coordinate: string): { kind: number; pubkey: string; d: string } {
  const first = coordinate.indexOf(":");
  const second = coordinate.indexOf(":", first + 1);
  const kind = Number(coordinate.slice(0, first));
  if (first < 0 || second < 0 || !Number.isInteger(kind)) {
    throw new Error(`not an address coordinate: ${coordinate}`);
  }
  return { kind, pubkey: coordinate.slice(first + 1, second), d: coordinate.slice(second + 1) };
}

/** Of two versions of a replaceable event, the newer; on a tie, the lower id (NIP-01). */
function newer(a: NostrEvent, b: NostrEvent | null): NostrEvent {
  if (b === null || a.created_at > b.created_at) return a;
  if (a.created_at === b.created_at && a.id < b.id) return a;
  return b;
}

/**
 * Reads the header at `coordinate` from one relay: the newest matching event, or null when
 * the relay has none. Throws if the relay cannot be reached or does not answer within
 * `timeoutMs`, so a slow relay is never mistaken for a missing header.
 */
export async function fetchHeader(
  relayUrl: string,
  coordinate: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NostrEvent | null> {
  const { kind, pubkey, d } = parseCoordinate(coordinate);
  let relay: AbstractRelay;
  try {
    relay = await connectRelay(relayUrl, timeoutMs);
  } catch (err) {
    throw new Error(`cannot read the header: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return await new Promise<NostrEvent | null>((resolve, reject) => {
      let found: NostrEvent | null = null;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const sub = relay.subscribe([{ kinds: [kind], authors: [pubkey], "#d": [d] }], {
        // Longer than our own timer, so the library never reports a silent relay as EOSE.
        eoseTimeout: timeoutMs + 5_000,
        onevent: (ev) => {
          found = newer(ev, found);
        },
        oneose: () => {
          finish(() => resolve(found));
          sub.close();
        },
        onclose: (reason) => {
          finish(() => reject(new Error(`${relayUrl} closed the header read: ${reason}`)));
        },
      });
      if (settled) return;
      timer = setTimeout(() => {
        finish(() =>
          reject(new Error(`${relayUrl} did not answer the header read within ${timeoutMs / 1000} s`)),
        );
        sub.close();
      }, timeoutMs);
    });
  } finally {
    relay.close();
  }
}

/**
 * Throws unless `ev` is the header at `coordinate` (kind 39998, same author and `d`) and its
 * `required` fields are exactly `name` and `category`, the shape the items are built for.
 */
export function checkHeader(ev: NostrEvent | null, coordinate: string): asserts ev is NostrEvent {
  const { pubkey, d } = parseCoordinate(coordinate);
  if (ev === null) throw new Error(`header ${coordinate} not found`);
  if (ev.kind !== HEADER_KIND) {
    throw new Error(`header ${coordinate}: kind is ${ev.kind}, expected ${HEADER_KIND}`);
  }
  if (ev.pubkey !== pubkey) {
    throw new Error(`header ${coordinate}: author is ${ev.pubkey}, expected ${pubkey}`);
  }
  const evD = ev.tags.find((t) => t[0] === "d")?.[1];
  if (evD !== d) throw new Error(`header ${coordinate}: d is "${evD ?? ""}", expected "${d}"`);
  const required = [
    ...new Set(ev.tags.filter((t) => t[0] === "required" && t[1] !== undefined).map((t) => t[1]!)),
  ].sort();
  if (required.join(",") !== REQUIRED_FIELDS.join(",")) {
    throw new Error(
      `header ${coordinate}: required fields are [${required.join(", ")}], ` +
        `expected [${REQUIRED_FIELDS.join(", ")}]; the item shape must be revisited before building`,
    );
  }
}
