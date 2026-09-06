import { connect, type Socket } from "node:net";

export interface AgentResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

// Line-delimited JSON over the client's --agent-socket; requests carry an id so replies can interleave.
export class AgentSocket {
  private sock: Socket;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: AgentResponse) => void; reject: (e: Error) => void }>();

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("close", () => this.fail(new Error("agent socket closed")));
    sock.on("error", (e) => this.fail(e));
  }

  static connect(path: string, timeoutMs = 30_000): Promise<AgentSocket> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const sock = connect({ path });
        sock.once("connect", () => resolve(new AgentSocket(sock)));
        sock.once("error", () => {
          sock.destroy();
          if (Date.now() > deadline) reject(new Error(`agent socket ${path} not reachable after ${timeoutMs}ms`));
          else setTimeout(attempt, 250);
        });
      };
      attempt();
    });
  }

  send(cmd: string, args: Record<string, unknown> = {}): Promise<AgentResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }

  async call(cmd: string, args: Record<string, unknown> = {}): Promise<AgentResponse> {
    const res = await this.send(cmd, args);
    if (!res.ok) throw new Error(`${cmd}: ${res.error ?? "failed"}`);
    return res;
  }

  close() {
    this.sock.destroy();
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      const res = JSON.parse(line) as AgentResponse & { id?: number };
      const waiter = res.id !== undefined ? this.pending.get(res.id) : undefined;
      if (waiter) {
        this.pending.delete(res.id!);
        delete res.id;
        waiter.resolve(res);
      }
    }
  }

  private fail(e: Error) {
    for (const w of this.pending.values()) w.reject(e);
    this.pending.clear();
  }
}
