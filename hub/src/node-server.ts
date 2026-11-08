// Self-hosted pi-swarm hub: the same SwarmCore as the Cloudflare Durable Object, on node:sqlite.
// Run: PI_SWARM_ADMIN_TOKEN_FILE=~/.config/pi-swarm/admin-token PI_SWARM_DATA=./data node hub/src/node-server.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SwarmCore, sha256Hex } from "./core.ts";

const SWARM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.PI_SWARM_DATA ?? path.join(process.cwd(), "data");
const adminToken = process.env.PI_SWARM_ADMIN_TOKEN
  ?? (process.env.PI_SWARM_ADMIN_TOKEN_FILE ? fs.readFileSync(process.env.PI_SWARM_ADMIN_TOKEN_FILE, "utf8").trim() : undefined);
const adminTokenHash = adminToken ? await sha256Hex(adminToken) : undefined;
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const cores = new Map<string, SwarmCore>();
// Returns undefined for a swarm that doesn't exist yet unless the caller holds the admin token, so unauthenticated
// requests can't create databases.
async function coreFor(swarm: string, bearer: string): Promise<SwarmCore | undefined> {
  let core = cores.get(swarm);
  if (!core) {
    const file = path.join(dataDir, `${swarm}.sqlite`);
    if (!fs.existsSync(file) && (!adminTokenHash || (await sha256Hex(bearer)) !== adminTokenHash)) return undefined;
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    core = new SwarmCore({ exec: (q, ...b) => db.prepare(q).all(...(b as never[])) as Record<string, unknown>[] }, { swarm, adminTokenHash });
    cores.set(swarm, core);
  }
  return core;
}

const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/healthz") return send(200, { service: "pi-swarm", version: "0.1.0", ok: true, runtime: "node" });
    const match = /^\/v1\/swarms\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return send(404, { error: "not found" });
    const swarm = decodeURIComponent(match[1]);
    if (!SWARM_RE.test(swarm)) return send(400, { error: "invalid swarm name" });
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer) return send(401, { error: "missing bearer token" });
    const core = await coreFor(swarm, bearer);
    if (!core) return send(401, { error: "invalid or revoked token" });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) return send(413, { error: "request body too large" });
      chunks.push(chunk as Buffer);
    }
    const inner = new URL(url);
    inner.pathname = match[2] || "/";
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const method = req.method ?? "GET";
    const disconnected = new AbortController();
    res.on("close", () => { if (!res.writableFinished) disconnected.abort(); });
    const response = await core.handle(new Request(inner, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks), signal: disconnected.signal }));
    if (disconnected.signal.aborted) return;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    console.error(error);
    send(500, { error: "internal error" });
  }
});
// Bounds how long a client may take to send its request (long-polls are response time, not covered by this).
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(port, host, () => console.log(`pi-swarm hub listening on http://${host}:${port} (data ${dataDir})`));
