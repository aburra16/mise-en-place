import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { rebroadcastHeader } from "../src/commands/header-rebroadcast.js";
import { loadConfig, type Config } from "../src/config.js";
import { startStubRelay } from "./stub-relay.js";

// Both relays are loopback stubs; nothing leaves this machine.

const SEARCH = "include:spam";
const AUTH_REQUIRED = "auth-required: this relay answers through a web of trust and has no house observer to lend you";

describe("rebroadcastHeader with relayReadSearch", () => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const d = "food-and-drink-places";
  const header = finalizeEvent(
    {
      kind: 39998,
      created_at: 1_700_000_000,
      content: "",
      tags: [["d", d], ["names", "food and drink place", "food and drink places"], ["required", "name"], ["required", "category"]],
    },
    secret,
  );

  /** A header relay that, like vespa-relay, answers only a REQ whose filter has `search`. */
  async function run(relayReadSearch: Config["relayReadSearch"]) {
    const filters: Record<string, unknown>[] = [];
    const source = await startStubRelay(
      () => {},
      (received, ctx) => {
        filters.push(...received);
        if (received.some((f) => typeof f.search !== "string")) return ctx.closed(AUTH_REQUIRED);
        ctx.send(header);
        ctx.eose();
      },
    );
    const target = await startStubRelay((ev, ctx) => ctx.reply(true, ""));
    const cfg: Config = {
      ...loadConfig("config.json"),
      headerCoordinate: `39998:${pubkey}:${d}`,
      relays: { source: source.url, target: target.url },
      headerRelay: "source",
      relayReadSearch,
    };
    try {
      return { filters, target, result: await rebroadcastHeader(cfg, "target").catch((err: Error) => err) };
    } finally {
      await source.close();
      await target.close();
    }
  }

  it("reads the header relay with its search and publishes the header to the target without one", async () => {
    const { filters, target, result } = await run({ source: SEARCH });

    expect(result).toMatchObject({ ok: true, eventId: header.id });
    expect(filters).toEqual([{ kinds: [39998], authors: [pubkey], "#d": [d], search: SEARCH }]);
    // The same event, id and signature, not a re-signed copy.
    expect(target.received.map((ev) => [ev.id, ev.sig])).toEqual([[header.id, header.sig]]);
  });

  it("is refused by a header relay that wants search when config has no entry for it", async () => {
    const { result, target } = await run({ target: SEARCH });

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/cannot read the header.*auth-required/);
    expect(target.received).toEqual([]);
  });
});
