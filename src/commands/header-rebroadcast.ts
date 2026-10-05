import { readSearch, relayUrl, type Config } from "../config.js";
import { checkHeader, fetchHeader } from "../header.js";
import { connectRelay, publishEvent } from "../relay.js";

/**
 * Copies the header from `headerRelay` to the relay called `toRelay`: the exact event object
 * read back (its signature checked on the way in), never re-signed, so the copy has the same
 * id and sig. The header must pass checkHeader first. Returns the target's answer.
 */
export async function rebroadcastHeader(
  cfg: Config,
  toRelay: string,
): Promise<{ ok: boolean; message: string; eventId: string }> {
  const target = relayUrl(cfg, toRelay);
  if (toRelay === cfg.headerRelay) {
    throw new Error(`${toRelay} is the header relay: the header is read from there, so there is nothing to copy`);
  }
  const header = await fetchHeader(
    relayUrl(cfg, cfg.headerRelay),
    cfg.headerCoordinate,
    undefined,
    readSearch(cfg, cfg.headerRelay),
  );
  checkHeader(header, cfg.headerCoordinate);

  const relay = await connectRelay(target, cfg.publish.okTimeoutMs);
  try {
    return { ...(await publishEvent(relay, header, cfg.publish.okTimeoutMs)), eventId: header.id };
  } finally {
    relay.close();
  }
}
