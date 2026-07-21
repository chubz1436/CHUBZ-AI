import WebSocket from "ws";
import type { EnrollmentMaterial, ProtectedCredentialStore } from "./enrollment.js";
import { validateLocalOutboundEndpoint } from "./enrollment.js";

export interface OutboundConnection {
  close(): Promise<void> | void;
  send(data: string): Promise<void> | void;
}

export interface OutboundConnector {
  connect(endpoint: string, authorization: string): Promise<OutboundConnection>;
}

export class WebSocketOutboundConnector implements OutboundConnector {
  public connect(endpoint: string, authorization: string): Promise<OutboundConnection> {
    const normalized = validateLocalOutboundEndpoint(endpoint);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(normalized, { headers: { authorization }, handshakeTimeout: 10_000, maxPayload: 1_048_576, perMessageDeflate: false });
      const onError = (error: Error): void => reject(error);
      socket.once("error", onError);
      socket.once("open", () => {
        socket.off("error", onError);
        socket.on("error", () => { /* connection errors are represented by close state at this foundation layer */ });
        resolve(Object.freeze({
          close: () => new Promise<void>((done) => { if (socket.readyState === WebSocket.CLOSED) return done(); socket.once("close", () => done()); socket.close(); }),
          send: (data: string) => new Promise<void>((done, fail) => { if (Buffer.byteLength(data) > 1_048_576) return fail(new Error("outbound message exceeds bound")); socket.send(data, (error) => error ? fail(error) : done()); }),
        }));
      });
    });
  }
}

export class BridgeConnectionManager {
  public constructor(private readonly store: ProtectedCredentialStore, private readonly connector: OutboundConnector) {}

  public async connect(): Promise<OutboundConnection> {
    const enrollment: EnrollmentMaterial | null = await this.store.load();
    if (enrollment === null) throw new Error("Bridge is not enrolled");
    return this.connector.connect(validateLocalOutboundEndpoint(enrollment.endpoint), `Bearer ${enrollment.bearerToken}`);
  }
}
