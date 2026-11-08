// Tests of the pi extension (extension/index.ts) against the self-hosted hub, with a fake pi ExtensionAPI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { register } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwarmClient, SwarmError } from "../client/client.mjs";

// pi provides these packages at runtime; the tests only need the schema helpers to exist.
const stubs = {
  "@earendil-works/pi-ai": "export const StringEnum = (values, opts) => ({ type: 'string', enum: values, ...opts });",
  typebox: "export const Type = { Object: (p) => ({ type: 'object', properties: p }), Optional: (s) => s, String: (o) => ({ type: 'string', ...o }), Number: (o) => ({ type: 'number', ...o }) };",
};
register("data:text/javascript," + encodeURIComponent(`
const stubs = ${JSON.stringify(stubs)};
export async function resolve(specifier, context, next) {
  if (specifier in stubs) return { url: "stub:" + specifier, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("stub:")) return { format: "module", source: stubs[url.slice(5)], shortCircuit: true };
  return next(url, context);
}`));
const { default: piSwarm } = await import("../extension/index.ts");

const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-ext-test-"));
const port = 19000 + Math.floor(Math.random() * 900);
const url = `http://127.0.0.1:${port}`;
let server;
let admin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const adminFile = path.join(dir, "admin-token");
  fs.writeFileSync(adminFile, "test-admin-token", { mode: 0o600 });
  server = spawn(process.execPath, [path.join(root, "hub/src/node-server.ts")], { env: { ...process.env, PORT: String(port), PI_SWARM_DATA: path.join(dir, "data"), PI_SWARM_ADMIN_TOKEN_FILE: adminFile }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => server.stdout.once("data", resolve));
  admin = new SwarmClient({ url, swarm: "ext", token: "test-admin-token" });
});

after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function mint(id) {
  const { token } = await admin.mint(id, id);
  const file = path.join(dir, `${id}.token`);
  fs.writeFileSync(file, token, { mode: 0o600 });
  return { id, file, client: new SwarmClient({ url, swarm: "ext", token }) };
}

// Points the extension's env at an identity. Foreground subagent children share this env with their parent.
function useIdentity(agent, extra = {}) {
  for (const k of Object.keys(process.env)) if (/^PI_SWARM_|^PI_SUBAGENT_CHILD$/.test(k)) delete process.env[k];
  Object.assign(process.env, { PI_SWARM_URL: url, PI_SWARM_SWARM: "ext", PI_SWARM_TOKEN_FILE: agent.file, PI_SWARM_CONFIG: path.join(dir, "none.json"), ...extra });
}

function fakePi() {
  const handlers = {};
  const listeners = {};
  const f = {
    tools: [],
    sent: [],
    failNext: 0,
    pi: {
      on: (event, handler) => (handlers[event] ??= []).push(handler),
      registerTool: (tool) => f.tools.push(tool),
      sendMessage: (message, options) => {
        if (f.failNext > 0) {
          f.failNext--;
          throw new Error("This extension ctx is stale after session replacement");
        }
        f.sent.push({ message, options });
      },
      events: {
        emit: (channel, data) => (listeners[channel] ?? []).forEach((h) => h(data)),
        on: (channel, handler) => (listeners[channel] ??= []).push(handler),
      },
    },
    handlerCount: () => Object.values(handlers).flat().length,
    async emit(event, payload = {}, ctx) {
      let result;
      for (const h of handlers[event] ?? []) result = (await h(payload, ctx)) ?? result;
      return result;
    },
    tool: () => f.tools.find((t) => t.name === "swarm"),
    run: (params) => f.tool().execute("call-1", params, undefined, () => {}),
  };
  return f;
}

function fakeCtx({ sessionDir = path.join(dir, "sessions"), idle = true } = {}) {
  const ctx = {
    cwd: dir,
    idle,
    footer: "",
    isIdle: () => ctx.idle,
    ui: { setStatus: (_key, text) => { ctx.footer = text; }, notify() {} },
    sessionManager: { getSessionDir: () => sessionDir, getSessionFile: () => path.join(sessionDir, "session.jsonl") },
  };
  return ctx;
}

async function waitFor(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const unread = async (peer, id) => (await peer.client.list()).agents.find((a) => a.id === id).pending;
const texts = (f) => f.sent.map((s) => s.message.content).join("\n");

test("B1: an async subagent child (PI_SUBAGENT_CHILD=1) registers no tool and no handlers", async () => {
  const me = await mint("b1-runner");
  useIdentity(me, { PI_SUBAGENT_CHILD: "1" });
  const f = fakePi();
  piSwarm(f.pi);
  assert.equal(f.tools.length, 0);
  assert.equal(f.handlerCount(), 0);
});

test("B1: a foreground in-process child (nested session dir, same env) never reads or acks the parent's mail", async () => {
  const parent = await mint("b1-parent");
  const peer = await mint("b1-peer");
  const parentDir = path.join(dir, "channel-sessions");
  useIdentity(parent, { PI_SWARM_SESSION_DIR: parentDir });
  const child = fakePi();
  piSwarm(child.pi);
  const childCtx = fakeCtx({ sessionDir: path.join(parentDir, "2026-11-08_session", "run-abc", "run-0") });
  await child.emit("session_start", {}, childCtx);
  assert.match(childCtx.footer, /inactive/);
  await peer.client.send(parent.id, "for the parent only");
  await sleep(1500);
  assert.equal(child.sent.length, 0, "child injected nothing");
  assert.equal(await unread(peer, parent.id), 1, "child did not ack");
  const tool = await child.run({ action: "list" });
  assert.match(tool.content[0].text, /inactive in this session/);

  const owner = fakePi();
  piSwarm(owner.pi);
  await owner.emit("session_start", {}, fakeCtx({ sessionDir: parentDir }));
  await waitFor(() => owner.sent.length === 1, 5000, "parent receives its mail");
  assert.match(texts(owner), /for the parent only/);
  await waitFor(async () => (await unread(peer, parent.id)) === 0, 5000, "parent acks");
  assert.equal(child.sent.length, 0);
  await owner.emit("session_shutdown");
  await child.emit("session_shutdown");
});

test("B1: a session whose identity another extension claims (pi-subagents child) stays inactive", async () => {
  const me = await mint("b1-claimed");
  const peer = await mint("b1-claim-peer");
  useIdentity(me);
  const f = fakePi();
  f.pi.events.on("intercom:session-identity", (request) => request.claim("subagent-route-1"));
  piSwarm(f.pi);
  const ctx = fakeCtx();
  await f.emit("session_start", {}, ctx);
  assert.match(ctx.footer, /inactive \(subagent child/);
  await peer.client.send(me.id, "not for a child");
  await sleep(1500);
  assert.equal(f.sent.length, 0);
  assert.equal(await unread(peer, me.id), 1);
  await f.emit("session_shutdown");
});

test("R2: a message whose injection throws stays unacked and is delivered on the retry", async () => {
  const me = await mint("r2-me");
  const peer = await mint("r2-peer");
  useIdentity(me);
  const f = fakePi();
  piSwarm(f.pi);
  f.failNext = 1;
  await f.emit("session_start", {}, fakeCtx());
  await peer.client.send(me.id, "survive a stale ctx");
  await waitFor(() => f.sent.length === 1, 8000, "delivery after the failed injection");
  assert.match(texts(f), /survive a stale ctx/);
  await waitFor(async () => (await unread(peer, me.id)) === 0, 5000, "acked after delivery");
  await f.emit("session_shutdown");
});

test("R1: mail is held (unacked) while pi is busy outside a run, then steered in once a run starts", async () => {
  const me = await mint("r1-me");
  const peer = await mint("r1-peer");
  useIdentity(me);
  const f = fakePi();
  piSwarm(f.pi);
  const ctx = fakeCtx({ idle: false }); // compacting: not idle, no agent run
  await f.emit("session_start", {}, ctx);
  await peer.client.send(me.id, "arrived during compaction");
  await sleep(2000);
  assert.equal(f.sent.length, 0, "not injected while compacting");
  assert.equal(await unread(peer, me.id), 1, "not acked while held");
  await f.emit("agent_start", {}, ctx);
  await waitFor(() => f.sent.length === 1, 5000, "delivery once the run starts");
  assert.deepEqual(f.sent[0].options, { deliverAs: "steer" });
  await f.emit("session_shutdown");
});

test("R1: held mail wakes the session once pi goes idle", async () => {
  const me = await mint("r1-idle");
  const peer = await mint("r1-idle-peer");
  useIdentity(me);
  const f = fakePi();
  piSwarm(f.pi);
  const ctx = fakeCtx({ idle: false });
  await f.emit("session_start", {}, ctx);
  await peer.client.send(me.id, "wake after compaction");
  await sleep(1500);
  assert.equal(f.sent.length, 0);
  ctx.idle = true;
  await waitFor(() => f.sent.length === 1, 5000, "delivery once idle");
  assert.deepEqual(f.sent[0].options, { triggerTurn: true });
  await f.emit("session_shutdown");
});

test("R3: an ask to an offline agent returns at once; the late reply arrives as a swarm message", async () => {
  const me = await mint("r3-me");
  const peer = await mint("r3-offline");
  useIdentity(me);
  const f = fakePi();
  piSwarm(f.pi);
  await f.emit("session_start", {}, fakeCtx());
  const t = Date.now();
  const res = await f.run({ action: "ask", to: peer.id, message: "are you there?", timeoutSec: 600 });
  assert.ok(Date.now() - t < 5000, "did not block");
  assert.match(res.content[0].text, /offline, so I did not wait/);
  const inbox = await peer.client.inbox();
  await peer.client.reply(inbox.messages[0].id, "back now: yes");
  await waitFor(() => /back now: yes/.test(texts(f)), 5000, "late reply injected");
  await f.emit("session_shutdown");
});

test("R7: a send whose outcome is unknown says it may have been delivered; a 404 is a plain error", async () => {
  const me = await mint("r7-me");
  useIdentity(me);
  const f = fakePi();
  piSwarm(f.pi);
  const notFound = await f.run({ action: "send", to: "nobody-here", message: "hi" });
  assert.match(notFound.content[0].text, /^pi-swarm error: no agent/);
  assert.equal(notFound.details.error, true);

  useIdentity(me, { PI_SWARM_URL: "http://127.0.0.1:1" }); // nothing listens: network error after retries
  const g = fakePi();
  piSwarm(g.pi);
  const unknown = await g.run({ action: "send", to: "anyone", message: "hi" });
  assert.match(unknown.content[0].text, /could not confirm the send/);
  assert.match(unknown.content[0].text, /may still have been delivered/);
  assert.equal(unknown.details.outcomeUnknown, true);
});

test("R8: failed swarm results are marked isError; successes and other tools are left alone", async () => {
  const f = fakePi();
  useIdentity({ file: path.join(dir, "missing.token") });
  piSwarm(f.pi);
  assert.deepEqual(await f.emit("tool_result", { toolName: "swarm", details: { error: true } }), { isError: true });
  assert.equal(await f.emit("tool_result", { toolName: "swarm", details: { message: {} } }), undefined);
  assert.equal(await f.emit("tool_result", { toolName: "bash", details: { error: true } }), undefined);
});

test("review fix: a reply to a pending ask is held, then injected when the tool's wait fails", async () => {
  const me = await mint("rf-asker");
  const peer = await mint("rf-answerer");
  useIdentity(me);
  const f = fakePi();
  piSwarm(f.pi);
  await f.emit("session_start", {}, fakeCtx());
  const original = SwarmClient.prototype.waitReply;
  SwarmClient.prototype.waitReply = async () => {
    await sleep(2000);
    throw new SwarmError("socket hang up");
  };
  try {
    const peerInbox = peer.client.inbox({ waitSec: 10 }); // the peer is online, so the ask blocks
    await sleep(200);
    const asking = f.run({ action: "ask", to: peer.id, message: "status?", timeoutSec: 60 });
    const got = await peerInbox;
    await peer.client.reply(got.messages[0].id, "all green");
    await peer.client.ack(got.cursor);
    await sleep(800);
    assert.equal(f.sent.length, 0, "held while the ask is pending");
    const res = await asking;
    assert.match(res.content[0].text, /waiting for the reply failed/);
    await waitFor(() => /all green/.test(texts(f)), 5000, "reply injected after the failed wait");
    await waitFor(async () => (await unread(peer, me.id)) === 0, 5000, "acked once injected");
  } finally {
    SwarmClient.prototype.waitReply = original;
    await f.emit("session_shutdown");
  }
});

test("review fix: a failed ack is retried without new mail and without injecting twice", async () => {
  const me = await mint("rf-acker");
  const peer = await mint("rf-ack-peer");
  useIdentity(me);
  const f = fakePi();
  piSwarm(f.pi);
  const original = SwarmClient.prototype.ack;
  let failures = 1;
  SwarmClient.prototype.ack = function (cursor) {
    if (failures-- > 0) return Promise.reject(new SwarmError("bad request", 400));
    return original.call(this, cursor);
  };
  try {
    await f.emit("session_start", {}, fakeCtx());
    await peer.client.send(me.id, "ack me eventually");
    await waitFor(async () => (await unread(peer, me.id)) === 0, 8000, "ack retried");
    assert.equal(f.sent.length, 1, "injected once");
  } finally {
    SwarmClient.prototype.ack = original;
    await f.emit("session_shutdown");
  }
});

test("review fix: mail behind a held reply is still delivered while the ask's wait stalls", async () => {
  const me = await mint("rf-stall");
  const peer = await mint("rf-stall-peer");
  useIdentity(me);
  const f = fakePi();
  piSwarm(f.pi);
  await f.emit("session_start", {}, fakeCtx());
  const original = SwarmClient.prototype.waitReply;
  SwarmClient.prototype.waitReply = async () => {
    await sleep(4000);
    throw new SwarmError("socket hang up");
  };
  try {
    const peerInbox = peer.client.inbox({ waitSec: 10 });
    await sleep(200);
    const asking = f.run({ action: "ask", to: peer.id, message: "status?", timeoutSec: 60 });
    const got = await peerInbox;
    await peer.client.reply(got.messages[0].id, "the held reply");
    await peer.client.ack(got.cursor);
    await peer.client.send(me.id, "unrelated note");
    await waitFor(() => /unrelated note/.test(texts(f)), 3000, "later mail delivered during the stall");
    assert.doesNotMatch(texts(f), /the held reply/);
    assert.equal(await unread(peer, me.id), 2, "nothing acked past the held reply");
    await asking;
    await waitFor(() => /the held reply/.test(texts(f)), 5000, "held reply injected after the failed wait");
    await waitFor(async () => (await unread(peer, me.id)) === 0, 5000, "all acked");
    assert.equal(f.sent.length, 2, "each injected once");
  } finally {
    SwarmClient.prototype.waitReply = original;
    await f.emit("session_shutdown");
  }
});
