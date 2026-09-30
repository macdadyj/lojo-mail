import { createServer, type AddressInfo, type Server } from "node:net";
import { ImapSession, type SessionContext } from "./imap-session.ts";

export class ImapServer {
  private readonly server: Server;
  private readonly sessions = new Set<ImapSession>();
  private nextId = 1;

  constructor(ctx: SessionContext) {
    this.server = createServer((socket) => {
      const session = new ImapSession(socket, ctx, this.nextId++);
      this.sessions.add(session);
      socket.on("close", () => this.sessions.delete(session));
    });
    this.server.maxConnections = 32;
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ port, host, exclusive: true }, () => {
        this.server.off("error", reject);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    for (const session of this.sessions) session.shutdown("lojo-mail bridge shutting down");
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
