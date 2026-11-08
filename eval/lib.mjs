// Shared eval harness: a hub (local or deployed), agent tokens, pi sessions (scripted brain or real LLM), MCP and CLI
// clients, and an isolated pi-intercom for the baseline. Every pi gets its own temp agent dir and no inherited
// PI_INTERCOM_* / PI_SUBAGENT* / PI_SESSION* variables, so evals never touch a live intercom broker or memory.
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SwarmClient } from "../client/client.mjs";

export const root = path.resolve(import.meta.dirname, "..");
const BRAIN = path.join(root, "examples/e2b/scripted-brain.ts");
const EXT = path.join(root, "extension/index.ts");
export const INTERCOM = process.env.PI_INTERCOM_DIR || path.join(root, "node_modules/pi-intercom");
export const LLM = { provider: process.env.EVAL_PROVIDER || "anthropic", model: process.env.EVAL_MODEL || "claude-haiku-5-5" };
const execFileP = promisify(execFile);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^PI_(INTERCOM|SUBAGENT|SESSION|SWARM)/.test(k) || k === "PI_CODING_AGENT_DIR") delete env[k];
  return { ...env, ...extra };
}

export async function createHarness({ hub = "local", adminTokenFile, keep = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-eval-"));
  fs.chmodSync(work, 0o700);
  const children = new Set();
  const track = (proc) => (children.add(proc), proc.once("exit", () => children.delete(proc)), proc);

  let hubUrl = hub;
  let adminToken;
  if (hub === "local") {
    adminToken = crypto.randomBytes(24).toString("base64url");
    const port = 19000 + Math.floor(Math.random() * 900);
    const proc = track(spawn(process.execPath, [path.join(root, "hub/src/node-server.ts")], {
      env: cleanEnv({ PORT: String(port), PI_SWARM_DATA: path.join(work, "hub"), PI_SWARM_ADMIN_TOKEN: adminToken }),
      stdio: ["ignore", "pipe", "ignore"],
    }));
    await new Promise((resolve) => proc.stdout.once("data", resolve));
    hubUrl = `http://127.0.0.1:${port}`;
  } else {
    adminToken = fs.readFileSync(String(adminTokenFile).replace(/^~\//, os.homedir() + "/"), "utf8").trim();
  }

  // Agent dirs: the scripted brain needs nothing; real LLM agents get symlinks to the user's pi model config only.
  const agentDir = (kind) => {
    const dir = path.join(work, `agentdir-${kind}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (kind === "llm") for (const f of ["models.json", "auth.json"]) {
        const src = path.join(os.homedir(), ".pi/agent", f);
        if (fs.existsSync(src)) fs.symlinkSync(src, path.join(dir, f));
      }
    }
    return dir;
  };

  const h = {
    work, hubUrl, LLM, swarm: "", admin: null, runId: 0,
    // Every scenario run gets a fresh swarm and fresh folders, so repetitions can't see each other's mail or files.
    fresh() {
      h.runId++;
      h.swarm = `eval-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
      h.admin = new SwarmClient({ url: hubUrl, swarm: h.swarm, token: adminToken });
    },
    async mint(id) {
      const { token } = await h.admin.mint(id, id);
      const file = path.join(work, `${h.runId}-${id}.token`);
      fs.writeFileSync(file, token, { mode: 0o600 });
      return { id, file, client: new SwarmClient({ url: hubUrl, swarm: h.swarm, token }) };
    },
    swarmEnv: (agent) => ({ PI_SWARM_URL: hubUrl, PI_SWARM_SWARM: h.swarm, PI_SWARM_TOKEN_FILE: agent.file, PI_SWARM_CONFIG: path.join(work, "none.json") }),

    // A real pi session in rpc mode. brain: "scripted" (no LLM) or "llm". transport: "swarm" or "intercom".
    startPi(name, { brain = "scripted", transport = "swarm", env = {}, files = {} } = {}) {
      const dir = path.join(work, `${h.runId}-${transport}-${brain}-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
      const ext = transport === "swarm" ? EXT : path.join(INTERCOM, "index.ts");
      const model = brain === "scripted" ? ["--provider", "scripted", "--model", "brain", "-e", BRAIN] : ["--provider", LLM.provider, "--model", LLM.model, "--thinking", "off"];
      const proc = track(spawn("pi", ["--mode", "rpc", "--no-session", "-ne", "--name", name, ...model, "-e", ext], {
        cwd: dir,
        env: cleanEnv({ PI_CODING_AGENT_DIR: agentDir(brain === "scripted" ? `scripted-${transport}` : "llm"), BRAIN_TOOL: transport, ...env }),
        stdio: ["pipe", "pipe", "ignore"],
      }));
      const agent = { name, dir, proc, tokens: 0, idle: true };
      const transcript = fs.createWriteStream(path.join(dir, ".rpc.jsonl"));
      let buf = "";
      proc.stdout.on("data", (d) => {
        transcript.write(d);
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const ev = JSON.parse(line);
            if (ev.type === "message_end" && ev.message?.role === "assistant") agent.tokens += ev.message.usage?.totalTokens ?? 0;
            if (ev.type === "agent_start") agent.idle = false;
            if (ev.type === "agent_end") agent.idle = true;
          } catch {}
        }
      });
      agent.prompt = (message) => proc.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
      agent.read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8").trim(); } catch { return null; } };
      agent.stop = () => new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode) return resolve();
        proc.once("exit", resolve);
        proc.kill("SIGKILL");
      });
      return agent;
    },

    async waitFor(check, timeoutMs, what) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const v = await check();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
      }
    },
    online: (id) => h.waitFor(async () => (await h.admin.list()).agents.find((a) => a.id === id && a.online && a.status === "idle"), 30_000, `${id} online`),

    startMcp(agent) {
      const proc = track(spawn(process.execPath, [path.join(root, "bin/pi-swarm-mcp.mjs")], { env: cleanEnv(h.swarmEnv(agent)), stdio: ["pipe", "pipe", "ignore"] }));
      const pending = new Map();
      let buf = "";
      let next = 1;
      proc.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          pending.get(msg.id)?.(msg);
        }
      });
      const rpc = (method, params) => new Promise((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
      return {
        proc,
        init: () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eval-mcp", version: "0" } }),
        call: async (name, a) => (await rpc("tools/call", { name, arguments: a })).result.content[0].text,
      };
    },

    spawnCli: (agent, cliArgs) => track(spawn(process.execPath, [path.join(root, "bin/pi-swarm.mjs"), ...cliArgs], { env: cleanEnv(h.swarmEnv(agent)) })),
    cli: (agent, cliArgs) => execFileP(process.execPath, [path.join(root, "bin/pi-swarm.mjs"), ...cliArgs], { env: cleanEnv(h.swarmEnv(agent)) })
      .then((r) => r.stdout, (e) => (e.stdout ?? "") + (e.stderr ?? "")),

    // Isolated pi-intercom (own agent dir and scope) for the same-machine baseline.
    intercomEnv: { PI_INTERCOM_SCOPE_ID: `eval-${crypto.randomBytes(12).toString("hex")}` },
    intercomCli(cmdArgs, timeoutMs = 60_000) {
      return execFileP(process.execPath, [path.join(INTERCOM, "cli.mjs"), ...cmdArgs, "--json"], {
        env: cleanEnv({ PI_CODING_AGENT_DIR: agentDir("scripted-intercom"), ...h.intercomEnv }), timeout: timeoutMs,
      }).then((r) => ({ ok: true, out: r.stdout }), (e) => ({ ok: false, out: (e.stdout ?? "") + (e.stderr ?? "") }));
    },
    intercomOnline: (name) => h.waitFor(async () => (await h.intercomCli(["list"])).out.includes(`"${name}"`), 20_000, `${name} on intercom`),

    async close() {
      for (const p of children) p.kill("SIGKILL");
      // pi-intercom's broker is spawned detached; stop only brokers whose agent dir is inside this eval's temp dir.
      if (process.platform === "linux") {
        for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
          try {
            const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
            if (env.includes(`PI_CODING_AGENT_DIR=${work}/`)) process.kill(Number(pid), "SIGKILL");
          } catch {}
        }
      }
      if (keep) console.error(`eval: kept ${work} (pi transcripts in */.rpc.jsonl)`);
      else fs.rmSync(work, { recursive: true, force: true });
    },
  };
  return h;
}

export function countDelivery(expected, received) {
  const counts = new Map();
  for (const r of received) counts.set(r, (counts.get(r) ?? 0) + 1);
  return { lost: expected.filter((e) => !counts.has(e)).length, duplicated: [...counts.values()].reduce((a, n) => a + Math.max(0, n - 1), 0) };
}

// Runs one scenario with its own agents; anything it starts is stopped afterwards.
export async function runScenario(h, name, fn, timeoutMs) {
  const agents = [];
  const procs = [];
  const ctx = { agent: (a) => (agents.push(a), a), proc: (p) => (procs.push(p), p) };
  h.fresh();
  const t = Date.now();
  let r;
  try {
    r = await Promise.race([fn(h, ctx), sleep(timeoutMs).then(() => ({ pass: false, detail: `scenario timeout (${timeoutMs / 1000} s)` }))]);
  } catch (error) {
    r = { pass: false, detail: `error: ${error.message}` };
  }
  for (const a of agents) await a.stop();
  for (const p of procs) p.kill("SIGKILL");
  return { name, pass: !!r.pass, durationMs: Date.now() - t, tokens: agents.reduce((s, a) => s + a.tokens, 0), lost: r.lost ?? 0, duplicated: r.duplicated ?? 0, latenciesMs: r.latencies ?? [], detail: r.detail };
}

export function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
}
