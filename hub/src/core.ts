// pi-swarm hub core: one instance per swarm (a Durable Object in production, node:sqlite in tests).
// Identity always comes from the bearer token, never from the request body.

export interface Sql {
  exec(query: string, ...bindings: unknown[]): Record<string, unknown>[];
}

export interface CoreOptions {
  swarm: string;
  adminTokenHash: string | undefined; // sha256 hex of the admin token; undefined disables admin routes
  now?: () => number;
}

type Caller = { kind: "admin" } | { kind: "agent"; id: string; name: string; hash: string };

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAME_RE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029<>"`\\]{1,64}$/;
// Peer-set presence text (status, marker, harness, host, cwd) is shown to LLMs: one line, no tags.
const LINE_RE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029<>]*$/;
const MAX_WAITS_PER_AGENT = 8;
const SEND_RATE_PER_MIN = 120;
const MAX_UNREAD_PER_AGENT = 2000;
const MAX_TEXT = 32 * 1024;
const MAX_BODY_BYTES = MAX_TEXT * 2 + 4096;
const MAX_WAIT_SEC = 50;
// An agent is online while a long-poll is open, or within this window of the start of its last request. Clients
// re-poll every <=25 s. A wait whose client disconnects (request.signal) marks the agent offline at once; if the
// runtime can't see the disconnect, a killed agent drops off within about this window.
const ONLINE_WINDOW_MS = 30_000;
const DEFAULT_MARKER_TTL_SEC = 2 * 3600;
const MAX_MARKER_TTL_SEC = 7 * 24 * 3600;
const DEFAULT_ASK_TIMEOUT_SEC = 600;
const MAX_HINT_ROSTER = 500;

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "psw_" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function str(value: unknown, field: string, opts: { max?: number; optional?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new HttpError(400, `${field} is required`);
  }
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  if (opts.max !== undefined && value.length > opts.max) throw new HttpError(413, `${field} is longer than ${opts.max} characters`);
  return value;
}

function intParam(value: string | null, field: string, min: number, max: number, fallback: number): number {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// Keys used to spot overlapping "on: <task>" markers: issue ids (AND-123), absolute/home paths, else the whole text.
export function markerKeys(marker: string): string[] {
  const lower = marker.toLowerCase().trim();
  const keys = new Set<string>();
  for (const m of lower.matchAll(/\b[a-z][a-z0-9]*-\d+\b/g)) keys.add(m[0]);
  for (const m of lower.matchAll(/(?:^|\s)((?:~|\/)[^\s,;]+)/g)) keys.add(m[1].replace(/\/+$/, ""));
  if (keys.size === 0 && lower) keys.add(lower);
  return [...keys];
}

function markersOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      const isPath = (s: string) => s.startsWith("/") || s.startsWith("~");
      if (isPath(x) && isPath(y) && (x.startsWith(y + "/") || y.startsWith(x + "/"))) return true;
    }
  }
  return false;
}

interface MessageRow {
  seq: number;
  id: string;
  from_id: string;
  to_id: string;
  kind: string;
  thread_id: string;
  reply_to: string | null;
  text: string;
  expects: string;
  request_id: string | null;
  created_at: number;
  deadline: number | null;
}

export class SwarmCore {
  sql: Sql;
  swarm: string;
  adminTokenHash: string | undefined;
  now: () => number;
  waiters = new Map<string, Set<() => void>>();
  activeWaits = new Map<string, number>();
  disconnectedAt = new Map<string, number>();
  sendWindows = new Map<string, { start: number; count: number }>();
  ready = false; // false until the swarm exists; only the admin token can create it

  constructor(sql: Sql, options: CoreOptions) {
    this.sql = sql;
    this.swarm = options.swarm;
    this.adminTokenHash = options.adminTokenHash;
    this.now = options.now ?? Date.now;
    let exists = true;
    try {
      exists = this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'`).length > 0;
    } catch {
      // storage that hides sqlite_master: fall back to treating the swarm as existing
    }
    if (exists) {
      this.migrate();
      this.ready = true;
    }
  }

  migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT,
      created_at INTEGER NOT NULL, last_seen INTEGER, status TEXT, marker TEXT, marker_expires INTEGER,
      harness TEXT, host TEXT, cwd TEXT, acked_seq INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER)`);
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agents_token ON agents(token_hash)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      kind TEXT NOT NULL, thread_id TEXT NOT NULL, reply_to TEXT, text TEXT NOT NULL,
      expects TEXT NOT NULL, request_id TEXT, created_at INTEGER NOT NULL, deadline INTEGER)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS messages_to ON messages(to_id, seq)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS messages_reply ON messages(reply_to)`);
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS messages_request ON messages(from_id, request_id) WHERE request_id IS NOT NULL`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS messages_asks ON messages(from_id, to_id, deadline) WHERE kind = 'ask'`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, kind TEXT NOT NULL, target TEXT,
      message_id TEXT, reply_to TEXT, thread_id TEXT, data TEXT)`);
  }

  // ---------- plumbing ----------

  logEvent(e: { actor: string | null; kind: string; target?: string | null; messageId?: string | null; replyTo?: string | null; threadId?: string | null; data?: unknown }): void {
    this.sql.exec(
      `INSERT INTO events (ts, actor, kind, target, message_id, reply_to, thread_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.now(), e.actor, e.kind, e.target ?? null, e.messageId ?? null, e.replyTo ?? null, e.threadId ?? null,
      e.data === undefined ? null : JSON.stringify(e.data),
    );
  }

  notify(key: string): void {
    const set = this.waiters.get(key);
    if (!set) return;
    this.waiters.delete(key);
    for (const wake of set) wake();
  }

  // Waits until check() returns a value, a key is notified, the client disconnects, alive() turns false, or timeout.
  async waitFor<T>(keys: string[], timeoutMs: number, check: () => T | null, signal?: AbortSignal, alive: () => boolean = () => true): Promise<T | null> {
    let result = check();
    if (result !== null || timeoutMs <= 0) return result;
    const deadline = this.now() + timeoutMs;
    while (result === null && !signal?.aborted && alive()) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const sets = keys.map((key) => {
          let set = this.waiters.get(key);
          if (!set) this.waiters.set(key, (set = new Set()));
          return [key, set] as const;
        });
        const wake = () => {
          clearTimeout(timer);
          for (const [key, set] of sets) {
            set.delete(wake);
            if (set.size === 0 && this.waiters.get(key) === set) this.waiters.delete(key);
          }
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        for (const [, set] of sets) set.add(wake);
        signal?.addEventListener("abort", wake);
      });
      if (!alive()) break;
      result = check();
    }
    return result;
  }

  async authenticate(req: Request): Promise<Caller> {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw new HttpError(401, "missing bearer token");
    const hash = await sha256Hex(match[1]);
    if (this.adminTokenHash && timingSafeEqualHex(hash, this.adminTokenHash)) {
      if (!this.ready) {
        this.migrate();
        this.ready = true;
      }
      return { kind: "admin" };
    }
    // An unknown swarm answers like a bad token and creates nothing.
    if (!this.ready) throw new HttpError(401, "invalid or revoked token");
    const rows = this.sql.exec(`SELECT id, name FROM agents WHERE token_hash = ? AND revoked_at IS NULL`, hash);
    if (rows.length === 0) throw new HttpError(401, "invalid or revoked token");
    return { kind: "agent", id: rows[0].id as string, name: rows[0].name as string, hash };
  }

  // Re-checks an agent token after a body read or a long wait, so a token revoked or rotated mid-request
  // can't write or receive anything.
  // Call it synchronously right before the protected operation, with no await in between.
  recheck(caller: { id: string; hash?: string }): void {
    if (!this.tokenValid(caller)) throw new HttpError(401, "invalid or revoked token");
  }

  tokenValid(caller: { id: string; hash?: string }): boolean {
    if (!caller.hash) return true;
    return this.sql.exec(`SELECT 1 FROM agents WHERE id = ? AND token_hash = ? AND revoked_at IS NULL`, caller.id, caller.hash).length > 0;
  }

  beginWait(me: { id: string }): void {
    const n = this.activeWaits.get(me.id) ?? 0;
    if (n >= MAX_WAITS_PER_AGENT) throw new HttpError(429, `at most ${MAX_WAITS_PER_AGENT} concurrent waits per agent`);
    this.activeWaits.set(me.id, n + 1);
  }

  // One budget per agent for every durable write (messages, replies, presence changes).
  rateLimit(agentId: string): void {
    const now = this.now();
    let w = this.sendWindows.get(agentId);
    if (!w || now - w.start >= 60_000) this.sendWindows.set(agentId, (w = { start: now, count: 0 }));
    if (++w.count > SEND_RATE_PER_MIN) throw new HttpError(429, `rate limit: ${SEND_RATE_PER_MIN} writes per minute`);
  }

  checkSendLimits(fromId: string, toId: string): void {
    this.rateLimit(fromId);
    this.checkMailbox(toId);
  }

  checkMailbox(toId: string): void {
    const unread = Number(this.sql.exec(`SELECT count(*) AS n FROM messages m JOIN agents a ON a.id = m.to_id WHERE m.to_id = ? AND m.seq > a.acked_seq`, toId)[0].n);
    if (unread >= MAX_UNREAD_PER_AGENT) throw new HttpError(429, `${toId} has ${unread} unread messages; mailbox full`);
  }

  requireAgent(caller: Caller): { id: string; name: string; hash: string } {
    if (caller.kind !== "agent") throw new HttpError(403, "this route needs an agent token, not the admin token");
    return caller;
  }

  requireAdmin(caller: Caller): void {
    if (caller.kind !== "admin") throw new HttpError(403, "admin token required");
  }

  touch(agentId: string): void {
    this.sql.exec(`UPDATE agents SET last_seen = ? WHERE id = ?`, this.now(), agentId);
  }

  // Ids are lowercase, so an id is matched case-insensitively (e.g. an id typed as Team-A1B2...).
  resolveRecipient(to: string): { id: string; name: string } {
    const byId = this.sql.exec(`SELECT id, name FROM agents WHERE id = ? AND revoked_at IS NULL`, to.toLowerCase());
    if (byId.length) return { id: byId[0].id as string, name: byId[0].name as string };
    const byName = this.sql.exec(`SELECT id, name FROM agents WHERE lower(name) = lower(?) AND revoked_at IS NULL`, to);
    if (byName.length === 1) return { id: byName[0].id as string, name: byName[0].name as string };
    if (byName.length > 1) throw new HttpError(409, `name "${to}" matches ${byName.length} agents; use the agent id`);
    const nearest = this.nearestAgents(to);
    throw new HttpError(404, `no agent "${to}" in swarm ${this.swarm} (offline agents still receive mail; this one does not exist)` +
      (nearest.length ? `. Nearest: ${nearest.join(", ")}` : ""));
  }

  // The two agents whose id or name is closest to `to` by edit distance, for a 404 hint. Bounded work: ids and names
  // are at most 64 characters, and very large swarms get no hint.
  nearestAgents(to: string): string[] {
    const target = to.toLowerCase().slice(0, 64);
    const agents = this.sql.exec(`SELECT id, name FROM agents WHERE revoked_at IS NULL LIMIT ?`, MAX_HINT_ROSTER + 1);
    if (agents.length > MAX_HINT_ROSTER) return [];
    return agents
      .map((r) => ({ label: `${r.name} (${r.id})`, d: Math.min(editDistance(target, r.id as string), editDistance(target, (r.name as string).toLowerCase())) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .map((r) => r.label);
  }

  // Asks from askerId to targetId whose wait hasn't ended and that targetId hasn't answered.
  openAsks(askerId: string, targetId: string): MessageRow[] {
    return this.sql.exec(
      `SELECT * FROM messages m WHERE m.kind = 'ask' AND m.from_id = ? AND m.to_id = ? AND m.deadline > ?
       AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.from_id = m.to_id) ORDER BY m.seq`,
      askerId, targetId, this.now(),
    ) as unknown as MessageRow[];
  }

  messageView(row: MessageRow, names?: Map<string, string>): Record<string, unknown> {
    const nameOf = (id: string) => names?.get(id) ?? (this.sql.exec(`SELECT name FROM agents WHERE id = ?`, id)[0]?.name as string | undefined) ?? id;
    return {
      seq: row.seq,
      id: row.id,
      from: { id: row.from_id, name: nameOf(row.from_id) },
      to: { id: row.to_id, name: nameOf(row.to_id) },
      kind: row.kind,
      threadId: row.thread_id,
      replyTo: row.reply_to,
      text: row.text,
      expects: row.expects,
      requestId: row.request_id,
      createdAt: new Date(row.created_at).toISOString(),
      deadline: row.deadline ? new Date(row.deadline).toISOString() : null,
    };
  }

  isOnline(id: string, lastSeen: number | null): boolean {
    if ((this.activeWaits.get(id) ?? 0) > 0) return true;
    if (lastSeen === null || (this.disconnectedAt.get(id) ?? -1) >= lastSeen) return false;
    return this.now() - lastSeen < ONLINE_WINDOW_MS;
  }

  // ---------- routes ----------

  async handle(req: Request): Promise<Response> {
    try {
      return await this.route(req);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("pi-swarm hub error", error);
      return json({ error: "internal error" }, 500);
    }
  }

  async readJson(req: Request): Promise<Record<string, unknown>> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (req.body) {
      const reader = req.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw new HttpError(413, "request body too large");
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    if (!text) return {};
    try {
      const body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
      return body as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "body must be a JSON object");
    }
  }

  async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();
    const caller = await this.authenticate(req);
    const parts = path.split("/").filter(Boolean);

    if (method === "GET" && path === "/me") return json(this.me(this.requireAgent(caller)));
    if (method === "GET" && path === "/agents") return json({ swarm: this.swarm, agents: this.roster() });
    if (method === "POST" && path === "/agents") {
      this.requireAdmin(caller);
      return json(await this.mint(await this.readJson(req)), 201);
    }
    if (method === "DELETE" && parts[0] === "agents" && parts.length === 2) {
      this.requireAdmin(caller);
      return json(this.revoke(parts[1]));
    }
    // Agent writes: read the body, then recheck the token and write with no await in between.
    const agentWrite = async <T>(op: (me: { id: string; name: string; hash: string }, body: Record<string, unknown>) => T): Promise<T> => {
      const me = this.requireAgent(caller);
      const body = await this.readJson(req);
      this.recheck(me);
      return op(me, body);
    };
    if (method === "POST" && path === "/presence") return json(await agentWrite((me, body) => this.presence(me, body)));
    if (method === "POST" && path === "/messages") return json(await agentWrite((me, body) => this.send(me, body)), 201);
    if (method === "POST" && parts[0] === "messages" && parts[2] === "reply" && parts.length === 3) {
      return json(await agentWrite((me, body) => this.reply(me, parts[1], body)), 201);
    }
    if (method === "GET" && parts[0] === "messages" && parts[2] === "reply" && parts.length === 3) {
      const me = this.requireAgent(caller);
      return json(await this.waitReply(me, parts[1], intParam(url.searchParams.get("wait"), "wait", 0, MAX_WAIT_SEC, 0), req.signal));
    }
    if (method === "GET" && path === "/inbox") {
      const me = this.requireAgent(caller);
      const after = url.searchParams.get("after");
      return json(await this.inbox(me, {
        after: after === null || after === "" ? null : intParam(after, "after", 0, Number.MAX_SAFE_INTEGER, 0),
        waitSec: intParam(url.searchParams.get("wait"), "wait", 0, MAX_WAIT_SEC, 0),
        limit: intParam(url.searchParams.get("limit"), "limit", 1, 200, 50),
        signal: req.signal,
      }));
    }
    if (method === "POST" && path === "/inbox/ack") return json(await agentWrite((me, body) => this.ack(me, body)));
    if (method === "GET" && path === "/events") {
      this.requireAdmin(caller);
      return json(this.events(
        intParam(url.searchParams.get("after"), "after", 0, Number.MAX_SAFE_INTEGER, 0),
        intParam(url.searchParams.get("limit"), "limit", 1, 1000, 200),
        url.searchParams.get("text") === "1",
      ));
    }
    throw new HttpError(404, `no route ${method} ${path}`);
  }

  me(me: { id: string; name: string }) {
    this.touch(me.id);
    const row = this.sql.exec(`SELECT * FROM agents WHERE id = ?`, me.id)[0];
    const pending = this.sql.exec(`SELECT count(*) AS n FROM messages WHERE to_id = ? AND seq > ?`, me.id, row.acked_seq)[0].n;
    return { swarm: this.swarm, id: me.id, name: row.name, ackedCursor: row.acked_seq, pending };
  }

  roster() {
    const now = this.now();
    const pending = new Map<string, number>();
    for (const r of this.sql.exec(`SELECT m.to_id AS id, count(*) AS n FROM messages m JOIN agents a ON a.id = m.to_id WHERE m.seq > a.acked_seq GROUP BY m.to_id`)) {
      pending.set(r.id as string, Number(r.n));
    }
    return this.sql.exec(`SELECT * FROM agents WHERE revoked_at IS NULL ORDER BY id`).map((r) => {
      const lastSeen = (r.last_seen as number | null) ?? null;
      const markerActive = r.marker && (r.marker_expires as number) > now;
      return {
        id: r.id,
        name: r.name,
        online: this.isOnline(r.id as string, lastSeen),
        lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
        lastSeenAgoSec: lastSeen ? Math.round((now - lastSeen) / 1000) : null,
        status: r.status ?? null,
        marker: markerActive ? r.marker : null,
        markerExpiresAt: markerActive ? new Date(r.marker_expires as number).toISOString() : null,
        harness: r.harness ?? null,
        host: r.host ?? null,
        cwd: r.cwd ?? null,
        pending: pending.get(r.id as string) ?? 0,
      };
    });
  }

  async mint(body: Record<string, unknown>) {
    const id = str(body.id, "id")!;
    if (!ID_RE.test(id)) throw new HttpError(400, "id must match " + ID_RE.source);
    const name = str(body.name, "name", { optional: true }) ?? id;
    if (!NAME_RE.test(name)) throw new HttpError(400, "name must be 1-64 printable characters without <>\"`\\");
    const token = randomToken();
    const hash = await sha256Hex(token);
    const existing = this.sql.exec(`SELECT id FROM agents WHERE id = ?`, id);
    if (existing.length) {
      // Re-minting rotates the token but keeps the identity and its mailbox.
      this.sql.exec(`UPDATE agents SET token_hash = ?, name = ?, revoked_at = NULL WHERE id = ?`, hash, name, id);
    } else {
      this.sql.exec(`INSERT INTO agents (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)`, id, name, hash, this.now());
    }
    this.logEvent({ actor: "admin", kind: existing.length ? "token_rotated" : "agent_registered", target: id, data: { name } });
    this.notify(`agent:${id}`); // ends waits held by the old token
    return { swarm: this.swarm, agent: { id, name }, token, rotated: existing.length > 0 };
  }

  revoke(id: string) {
    const rows = this.sql.exec(`SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL`, id);
    if (!rows.length) throw new HttpError(404, `no active agent "${id}"`);
    this.sql.exec(`UPDATE agents SET token_hash = NULL, revoked_at = ? WHERE id = ?`, this.now(), id);
    this.logEvent({ actor: "admin", kind: "agent_revoked", target: id });
    this.notify(`agent:${id}`);
    return { revoked: id };
  }

  presence(me: { id: string; name: string }, body: Record<string, unknown>) {
    this.rateLimit(me.id);
    const now = this.now();
    const before = this.sql.exec(`SELECT * FROM agents WHERE id = ?`, me.id)[0];
    const sets: string[] = ["last_seen = ?"];
    const values: unknown[] = [now];
    const changed: Record<string, unknown> = {};
    const setField = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
      if (before[column] !== value) changed[column] = value;
    };
    if (body.name !== undefined) {
      const name = str(body.name, "name")!;
      if (!NAME_RE.test(name)) throw new HttpError(400, "name must be 1-64 printable characters without <>\"`\\");
      setField("name", name);
    }
    const line = (value: unknown, field: string, max: number) => {
      const v = str(value, field, { max })!;
      if (!LINE_RE.test(v)) throw new HttpError(400, `${field} must be one line without control characters or <>`);
      return v;
    };
    for (const field of ["status", "harness", "host", "cwd"] as const) {
      if (body[field] !== undefined) setField(field, body[field] === null ? null : line(body[field], field, 256));
    }
    let overlaps: Record<string, unknown>[] = [];
    if (body.marker !== undefined) {
      const marker = body.marker === null || body.marker === "" ? null : line(body.marker, "marker", 200);
      const ttl = intParam(body.markerTtlSec === undefined ? null : String(body.markerTtlSec), "markerTtlSec", 30, MAX_MARKER_TTL_SEC, DEFAULT_MARKER_TTL_SEC);
      setField("marker", marker);
      sets.push("marker_expires = ?");
      values.push(marker ? now + ttl * 1000 : null);
      if (marker) {
        const keys = markerKeys(marker);
        overlaps = this.sql
          .exec(`SELECT id, name, marker, last_seen FROM agents WHERE id != ? AND revoked_at IS NULL AND marker IS NOT NULL AND marker_expires > ?`, me.id, now)
          .filter((r) => markersOverlap(keys, markerKeys(r.marker as string)))
          .map((r) => ({ id: r.id, name: r.name, marker: r.marker, online: this.isOnline(r.id as string, r.last_seen as number | null) }));
      }
    }
    values.push(me.id);
    this.sql.exec(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`, ...values);
    if (Object.keys(changed).length) this.logEvent({ actor: me.id, kind: "presence", data: changed });
    return { ok: true, overlaps, me: this.roster().find((a) => a.id === me.id) };
  }

  existingRequest(fromId: string, requestId: string | undefined): MessageRow | null {
    if (!requestId) return null;
    const rows = this.sql.exec(`SELECT * FROM messages WHERE from_id = ? AND request_id = ?`, fromId, requestId) as unknown as MessageRow[];
    return rows[0] ?? null;
  }

  insertMessage(m: Omit<MessageRow, "seq">): MessageRow {
    this.sql.exec(
      `INSERT INTO messages (id, from_id, to_id, kind, thread_id, reply_to, text, expects, request_id, created_at, deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.id, m.from_id, m.to_id, m.kind, m.thread_id, m.reply_to, m.text, m.expects, m.request_id, m.created_at, m.deadline,
    );
    const row = this.sql.exec(`SELECT * FROM messages WHERE id = ?`, m.id)[0] as unknown as MessageRow;
    this.logEvent({ actor: m.from_id, kind: `message_${m.kind}`, target: m.to_id, messageId: m.id, replyTo: m.reply_to, threadId: m.thread_id, data: { seq: row.seq, expects: m.expects, chars: m.text.length } });
    this.notify(`inbox:${m.to_id}`);
    if (m.reply_to) this.notify(`reply:${m.reply_to}`);
    return row;
  }

  send(me: { id: string; name: string }, body: Record<string, unknown>) {
    this.touch(me.id);
    const requestId = str(body.requestId, "requestId", { optional: true, max: 128 });
    const dup = this.existingRequest(me.id, requestId);
    if (dup) {
      // A retry after a lost response still learns whether the recipient is online (the extension's offline-ask check).
      const recipient = this.sql.exec(`SELECT last_seen FROM agents WHERE id = ?`, dup.to_id)[0];
      return { message: this.messageView(dup), duplicate: true, recipientOnline: this.isOnline(dup.to_id, (recipient?.last_seen as number | null) ?? null) };
    }
    const kind = str(body.kind, "kind", { optional: true }) ?? "send";
    if (kind !== "send" && kind !== "ask") throw new HttpError(400, "kind must be send or ask (use /messages/{id}/reply to reply)");
    this.rateLimit(me.id); // before the lookup, so misses (and their nearest-name hints) count too
    const to = this.resolveRecipient(str(body.to, "to", { max: 128 })!);
    if (to.id === me.id) throw new HttpError(400, "cannot message yourself");
    // The recipient is blocked waiting on my answer: a blocking ask back would leave both waiting out their timeouts,
    // and a plain send is almost always the answer, so it is threaded as the reply that ends their wait.
    const theirAsks = this.openAsks(to.id, me.id);
    if (kind === "ask" && theirAsks.length) {
      throw new HttpError(409, `${to.name} is waiting on your answer to their ask ${theirAsks[0].id}; reply to it first (or send a message, which answers it)`);
    }
    const answers = kind === "send" && theirAsks.length === 1 ? theirAsks[0] : null;
    this.checkMailbox(to.id);
    const text = str(body.text, "text", { max: MAX_TEXT })!;
    const expects = kind === "ask" ? "reply" : (str(body.expects, "expects", { optional: true }) ?? "none");
    if (!["none", "reply", "decision"].includes(expects)) throw new HttpError(400, "expects must be none, reply or decision");
    const timeoutSec = kind === "ask" ? intParam(body.timeoutSec === undefined ? null : String(body.timeoutSec), "timeoutSec", 1, 7 * 24 * 3600, DEFAULT_ASK_TIMEOUT_SEC) : 0;
    const id = crypto.randomUUID();
    const now = this.now();
    const row = this.insertMessage({
      id, from_id: me.id, to_id: to.id, kind, thread_id: answers?.thread_id ?? id, reply_to: answers?.id ?? null, text,
      expects, request_id: requestId ?? null, created_at: now,
      deadline: kind === "ask" ? now + timeoutSec * 1000 : null,
    });
    const recipient = this.sql.exec(`SELECT last_seen FROM agents WHERE id = ?`, to.id)[0];
    return {
      message: this.messageView(row),
      recipientOnline: this.isOnline(to.id, (recipient.last_seen as number | null) ?? null),
      ...(answers ? { inferredReplyTo: answers.id } : {}),
    };
  }

  reply(me: { id: string; name: string }, messageId: string, body: Record<string, unknown>) {
    this.touch(me.id);
    const requestId = str(body.requestId, "requestId", { optional: true, max: 128 });
    const dup = this.existingRequest(me.id, requestId);
    if (dup) return { message: this.messageView(dup), duplicate: true };
    const original = (this.sql.exec(`SELECT * FROM messages WHERE id = ?`, messageId) as unknown as MessageRow[])[0];
    if (!original || original.to_id !== me.id) throw new HttpError(404, "no message with that id was sent to you");
    this.checkSendLimits(me.id, original.from_id);
    const text = str(body.text, "text", { max: MAX_TEXT })!;
    const row = this.insertMessage({
      id: crypto.randomUUID(), from_id: me.id, to_id: original.from_id, kind: "reply", thread_id: original.thread_id,
      reply_to: original.id, text, expects: "none",
      request_id: requestId ?? null, created_at: this.now(), deadline: null,
    });
    return { message: this.messageView(row) };
  }

  // Ends a wait's "online" credit. A client that disconnected mid-wait is offline until its next request.
  endWait(me: { id: string }, signal: AbortSignal | undefined): void {
    const n = (this.activeWaits.get(me.id) ?? 1) - 1;
    if (n > 0) this.activeWaits.set(me.id, n);
    else this.activeWaits.delete(me.id);
    if (signal?.aborted) this.disconnectedAt.set(me.id, this.now());
  }

  async waitReply(me: { id: string; name: string; hash?: string }, askId: string, waitSec: number, signal?: AbortSignal) {
    const ask = (this.sql.exec(`SELECT * FROM messages WHERE id = ?`, askId) as unknown as MessageRow[])[0];
    if (!ask || ask.from_id !== me.id) throw new HttpError(404, "no message with that id was sent by you");
    this.touch(me.id);
    this.beginWait(me);
    try {
      const reply = await this.waitFor([`reply:${askId}`, `agent:${me.id}`], waitSec * 1000, () => {
        const rows = this.sql.exec(`SELECT * FROM messages WHERE reply_to = ? AND to_id = ? ORDER BY seq LIMIT 1`, askId, me.id) as unknown as MessageRow[];
        return rows[0] ?? null;
      }, signal, () => this.tokenValid(me));
      this.recheck(me);
      return { reply: reply ? this.messageView(reply) : null };
    } finally {
      this.endWait(me, signal);
    }
  }

  async inbox(me: { id: string; name: string; hash?: string }, opts: { after: number | null; waitSec: number; limit: number; signal?: AbortSignal }) {
    this.touch(me.id);
    const acked = Number(this.sql.exec(`SELECT acked_seq FROM agents WHERE id = ?`, me.id)[0].acked_seq);
    const after = Math.max(acked, opts.after ?? acked);
    this.beginWait(me);
    try {
      const rows = await this.waitFor([`inbox:${me.id}`, `agent:${me.id}`], opts.waitSec * 1000, () => {
        const found = this.sql.exec(`SELECT * FROM messages WHERE to_id = ? AND seq > ? ORDER BY seq LIMIT ?`, me.id, after, opts.limit) as unknown as MessageRow[];
        return found.length ? found : null;
      }, opts.signal, () => this.tokenValid(me));
      this.recheck(me);
      const messages = (rows ?? []).map((r) => this.messageView(r));
      const cursor = rows && rows.length ? rows[rows.length - 1].seq : after;
      return { messages, cursor, acked };
    } finally {
      this.endWait(me, opts.signal);
    }
  }

  ack(me: { id: string; name: string }, body: Record<string, unknown>) {
    const cursor = body.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) throw new HttpError(400, "cursor must be a non-negative integer");
    const maxSeq = Number(this.sql.exec(`SELECT coalesce(max(seq), 0) AS m FROM messages WHERE to_id = ?`, me.id)[0].m);
    if (cursor > maxSeq) throw new HttpError(400, `cursor ${cursor} is past your newest message (${maxSeq})`);
    const before = Number(this.sql.exec(`SELECT acked_seq FROM agents WHERE id = ?`, me.id)[0].acked_seq);
    if (cursor > before) {
      this.sql.exec(`UPDATE agents SET acked_seq = ?, last_seen = ? WHERE id = ?`, cursor, this.now(), me.id);
      this.logEvent({ actor: me.id, kind: "ack", data: { cursor } });
    }
    return { acked: Math.max(before, cursor) };
  }

  events(after: number, limit: number, withText: boolean) {
    const rows = this.sql.exec(`SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit);
    const texts = new Map<string, string>();
    if (withText) {
      const ids = rows.map((r) => r.message_id).filter(Boolean) as string[];
      for (const id of ids) {
        const m = this.sql.exec(`SELECT text FROM messages WHERE id = ?`, id)[0];
        if (m) texts.set(id, m.text as string);
      }
    }
    return {
      events: rows.map((r) => ({
        seq: r.seq, ts: new Date(r.ts as number).toISOString(), actor: r.actor, kind: r.kind, target: r.target,
        messageId: r.message_id, replyTo: r.reply_to, threadId: r.thread_id, data: r.data ? JSON.parse(r.data as string) : null,
        ...(withText && r.message_id ? { text: texts.get(r.message_id as string) ?? null } : {}),
      })),
      cursor: rows.length ? rows[rows.length - 1].seq : after,
    };
  }
}
