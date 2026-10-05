import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { NostrEvent } from "nostr-tools/core";
import { WebSocketServer, type WebSocket } from "ws";

export interface StubRelay {
  url: string;
  /** Every EVENT the stub received, in arrival order, retries included. */
  received: NostrEvent[];
  /** How many clients connected. */
  connections: number;
  close(): Promise<void>;
}

export interface StubContext {
  /** Sends `["OK", <event id>, ok, message]` back to the client. */
  reply(ok: boolean, message: string): void;
  socket: WebSocket;
  /** 1 for the first EVENT the stub received, 2 for the second, and so on. */
  n: number;
}

/**
 * A relay on an OS-assigned loopback port that hands each EVENT to `onEvent`, which decides
 * whether and how to answer. It never answers a REQ, so a read from it never finishes.
 */
export async function startStubRelay(onEvent: (ev: NostrEvent, ctx: StubContext) => void): Promise<StubRelay> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  const stub: StubRelay = {
    url: `ws://127.0.0.1:${port}`,
    received: [],
    connections: 0,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
    },
  };
  wss.on("connection", (socket) => {
    stub.connections++;
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data)) as unknown[];
      if (msg[0] !== "EVENT") return;
      const ev = msg[1] as NostrEvent;
      stub.received.push(ev);
      onEvent(ev, {
        reply: (ok, message) => socket.send(JSON.stringify(["OK", ev.id, ok, message])),
        socket,
        n: stub.received.length,
      });
    });
  });
  return stub;
}
