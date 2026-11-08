import { DurableObject } from "cloudflare:workers";
import { SwarmCore, sha256Hex } from "./core.ts";

interface Env {
  SWARM: DurableObjectNamespace<SwarmHub>;
  ADMIN_TOKEN?: string;
}

const SWARM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = "0.1.0";

// One Durable Object per swarm; all of a swarm's agents, messages and events live in its SQLite storage.
export class SwarmHub extends DurableObject<Env> {
  core: SwarmCore | undefined;

  async fetch(request: Request): Promise<Response> {
    if (!this.core) {
      try {
        const swarm = request.headers.get("x-pi-swarm") ?? "unknown";
        const adminTokenHash = this.env.ADMIN_TOKEN ? await sha256Hex(this.env.ADMIN_TOKEN) : undefined;
        const sql = this.ctx.storage.sql;
        this.core = new SwarmCore({ exec: (query, ...bindings) => [...sql.exec(query, ...(bindings as SqlStorageValue[]))] }, { swarm, adminTokenHash });
      } catch (error) {
        // Storage errors (e.g. an exhausted free-tier quota) are not secret and are what an operator needs to see.
        console.error("pi-swarm hub storage unavailable", error);
        return Response.json({ error: `hub storage unavailable: ${(error as Error).message}` }, { status: 503 });
      }
    }
    return this.core.handle(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return Response.json({ service: "pi-swarm", version: VERSION, ok: true });
    }
    const match = /^\/v1\/swarms\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return Response.json({ error: "not found" }, { status: 404 });
    const swarm = decodeURIComponent(match[1]);
    if (!SWARM_RE.test(swarm)) return Response.json({ error: "invalid swarm name" }, { status: 400 });
    const inner = new URL(request.url);
    inner.pathname = match[2] || "/";
    const headers = new Headers(request.headers);
    headers.set("x-pi-swarm", swarm);
    const stub = env.SWARM.get(env.SWARM.idFromName(swarm));
    return stub.fetch(new Request(inner.toString(), { method: request.method, headers, body: request.body, signal: request.signal }));
  },
};
