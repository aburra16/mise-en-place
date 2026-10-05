import { AbstractRelay } from "nostr-tools/abstract-relay";
import { verifyEvent } from "nostr-tools/pure";

/**
 * Node's built-in WebSocket dispatches `error` again from inside `close()` while it is still
 * connecting, and nostr-tools calls `close()` from its `onerror`. Together they recurse until
 * the stack overflows whenever a relay is unreachable. A re-entrant `close()` is ignored here,
 * which breaks the loop; the first call still closes the socket.
 */
class GuardedWebSocket extends WebSocket {
  #closing = false;

  override close(code?: number, reason?: string): void {
    if (this.#closing) return;
    this.#closing = true;
    super.close(code, reason);
  }
}

/** Connects to a relay that verifies event signatures, or throws a plain error naming it. */
export async function connectRelay(url: string, timeoutMs: number): Promise<AbstractRelay> {
  const relay = new AbstractRelay(url, { verifyEvent, websocketImplementation: GuardedWebSocket });
  try {
    await relay.connect({ timeout: timeoutMs });
  } catch (err) {
    relay.close();
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot connect to ${url} (${reason})`);
  }
  return relay;
}
