import { AbstractRelay } from "nostr-tools/abstract-relay";
import type { NostrEvent } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectRelay, publishEvent, queryAll } from "../../src/relay.js";
import { startStubRelay } from "../stub-relay.js";
import { startNak } from "./nak.js";

// Loopback only: an in-memory `nak serve`, never a public relay.
const NAK_PORT = 10597;

let nak: { url: string; stop(): Promise<void> };

beforeAll(async () => {
  nak = await startNak(NAK_PORT);
}, 20_000);

afterAll(async () => {
  await nak?.stop();
});

const T0 = 1_700_000_000;

/** Signs one kind 39999 event per created_at in `times`, each with its own `d`. */
function events(secret: Uint8Array, times: number[]): NostrEvent[] {
  return times.map((created_at, i) =>
    finalizeEvent({ kind: 39999, created_at, content: "", tags: [["d", `item-${i}`]] }, secret),
  );
}

async function publishAll(evs: NostrEvent[]): Promise<void> {
  const relay = await connectRelay(nak.url, 5_000);
  try {
    for (const ev of evs) expect(await publishEvent(relay, ev, 5_000)).toEqual({ ok: true, message: "" });
  } finally {
    relay.close();
  }
}

describe("publishEvent", () => {
  it("returns ok for an accepted event and the relay's message for a rejected one, never throwing", async () => {
    const secret = generateSecretKey();
    const [good] = events(secret, [T0]);
    const broken = { ...events(secret, [T0 + 1])[0]!, sig: "0".repeat(128) };
    const relay = await connectRelay(nak.url, 5_000);
    try {
      expect(await publishEvent(relay, good!, 5_000)).toEqual({ ok: true, message: "" });
      const rejected = await publishEvent(relay, broken, 5_000);
      expect(rejected.ok).toBe(false);
      expect(rejected.message).toMatch(/^invalid:/);
    } finally {
      relay.close();
    }
    expect(await publishEvent(relay, good!, 5_000)).toEqual({
      ok: false,
      message: `not connected to ${relay.url}`,
    });
  });
});

describe("queryAll", () => {
  it("pages with until through more events than one page holds, ties included, once each", async () => {
    const secret = generateSecretKey();
    // 25 events over 5 timestamps, 5 per timestamp: every page boundary falls inside a tie.
    const evs = events(secret, Array.from({ length: 25 }, (_, i) => T0 - Math.floor(i / 5)));
    await publishAll(evs);
    const close = vi.spyOn(AbstractRelay.prototype, "close");
    try {
      const got = await queryAll(nak.url, { kinds: [39999], authors: [getPublicKey(secret)] }, 7);
      expect(got.map((e) => e.id).sort()).toEqual(evs.map((e) => e.id).sort());
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it("returns an empty list for a filter nothing matches", async () => {
    const got = await queryAll(nak.url, { kinds: [39999], authors: [getPublicKey(generateSecretKey())] });
    expect(got).toEqual([]);
  });

  it("refuses to return a partial list when more than a page shares one created_at", async () => {
    const secret = generateSecretKey();
    await publishAll(events(secret, Array.from({ length: 8 }, () => T0)));
    await expect(
      queryAll(nak.url, { kinds: [39999], authors: [getPublicKey(secret)] }, 5),
    ).rejects.toThrow(`more than 5 events share created_at ${T0}`);
  });

  it("rejects instead of returning a partial list when the relay never finishes the read", async () => {
    const silent = await startStubRelay(() => {}); // answers no REQ at all
    try {
      await expect(queryAll(silent.url, { kinds: [39999] }, 10, 300)).rejects.toThrow(
        /did not finish the read within 0\.3 s/,
      );
    } finally {
      await silent.close();
    }
  });

  it("rejects with the relay named when it cannot connect", async () => {
    await expect(queryAll("ws://127.0.0.1:9", { kinds: [39999] }, 10, 2_000)).rejects.toThrow(
      /cannot connect to ws:\/\/127\.0\.0\.1:9/,
    );
  });
});
