// Live test against a deployed hub: two real-LLM pi sessions on this machine (separate folders, isolated pi config),
// a Claude Code session joining through the MCP server, and the E2B pi test (examples/e2b/live-test.mjs).
//
//   E2B_API_KEY=… node examples/live/run-live.mjs \
//     --hub https://hub.example.com --admin-token-file ~/.config/pi-swarm/admin-token --e2b-sdk /tmp/psw-e2b-sdk
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createHarness, cleanEnv, root } from "../../eval/lib.mjs";

const execFileP = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const t0 = Date.now();
const log = (m) => console.log(`${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);

const h = await createHarness({ hub: flag("hub") ?? "local", adminTokenFile: flag("admin-token-file"), keep: args.includes("--keep") });
h.fresh();
const results = [];
try {
  log(`hub ${h.hubUrl} swarm ${h.swarm}`);
  const [a, b, claude, ops] = [await h.mint("vm-a"), await h.mint("vm-b"), await h.mint("claude"), await h.mint("ops")];
  h.startPi("vm-a", { brain: "llm", env: { ...h.swarmEnv(a), PI_SWARM_MARKER: "on: TASK-42 live test" }, files: { "notes.txt": "vm-a keeps the release checklist\n" } });
  h.startPi("vm-b", { brain: "llm", env: h.swarmEnv(b), files: { "notes.txt": "vm-b owns the hub deploy\n" } });
  await h.online("vm-a");
  await h.online("vm-b");
  log("vm-a and vm-b (real LLM pi sessions) online");

  // VM pi <-> VM pi through the hub: ops asks vm-a to ask vm-b (a real two-hop LLM conversation).
  let t = Date.now();
  const r1 = await ops.client.ask("vm-b", "In one short line: what does notes.txt in your folder say?", { timeoutSec: 120 });
  results.push({ name: "ops -> vm-b (LLM) ask/reply", ms: Date.now() - t, ok: !!r1.reply, reply: r1.reply?.text });
  log(`ops -> vm-b: ${Date.now() - t} ms: ${r1.reply?.text}`);

  // Claude Code via MCP.
  const mcpConfig = path.join(h.work, "mcp.json");
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { "pi-swarm": { command: process.execPath, args: [path.join(root, "bin/pi-swarm-mcp.mjs")], env: { ...h.swarmEnv(claude), PI_SWARM_HARNESS: "claude-code" } } } }));
  t = Date.now();
  const prompt = "Use the pi-swarm MCP tools. 1) Call swarm_list and note who is online. 2) Call swarm_ask with to=vm-a and message " +
    "\"Claude Code here: what does notes.txt in your folder say?\". 3) Answer with the roster (ids + online) and vm-a's reply, nothing else.";
  const cc = await execFileP("claude", ["-p", prompt, "--model", "haiku", "--strict-mcp-config", "--mcp-config", mcpConfig, "--allowedTools", "mcp__pi-swarm__swarm_list,mcp__pi-swarm__swarm_ask"], { env: cleanEnv(), timeout: 300_000, maxBuffer: 1 << 20 })
    .then((r) => r.stdout, (e) => `ERROR ${e.message}\n${e.stdout ?? ""}`);
  const ccOk = /checklist/i.test(cc);
  results.push({ name: "Claude Code (MCP) list + ask vm-a", ms: Date.now() - t, ok: ccOk, output: cc.trim().slice(0, 600) });
  log(`claude code (${Date.now() - t} ms):\n${cc.trim()}`);
  const roster = (await h.admin.list()).agents.map((x) => `${x.id}:${x.online ? "on" : "off"}:${x.harness ?? "-"}${x.marker ? `:"${x.marker}"` : ""}`);
  log(`roster: ${roster.join(" ")}`);

  // E2B pi (scripted brain) asks vm-a (real LLM) and answers VM asks; offline delivery and kill/resume there.
  if (flag("e2b-sdk")) {
    const opsTokenFile = ops.file;
    const e2b = spawn(process.execPath, [path.join(root, "examples/e2b/live-test.mjs")], {
      env: { ...cleanEnv(), E2B_API_KEY: process.env.E2B_API_KEY, PI_SWARM_URL: h.hubUrl, PI_SWARM_SWARM: h.swarm, PI_SWARM_ADMIN_TOKEN_FILE: flag("admin-token-file"), OPS_TOKEN_FILE: opsTokenFile, E2B_SDK_DIR: flag("e2b-sdk"), ASK_TARGET: "vm-a" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    e2b.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    const code = await new Promise((r) => e2b.once("exit", r));
    results.push({ name: "E2B live test", ok: code === 0, detail: out.split("\n").filter((l) => /PASS|FAIL/.test(l)).join("\n") });
  }
  const events = await h.admin.events(0, { limit: 1000 });
  log(`event log: ${events.events.length} events, kinds: ${[...new Set(events.events.map((e) => e.kind))].join(", ")}`);
  for (const e of events.events.filter((x) => x.kind.startsWith("message_")).slice(0, 6)) log(`  ${e.seq} ${e.ts} ${e.actor} ${e.kind} -> ${e.target}${e.replyTo ? ` re=${e.replyTo.slice(0, 8)}` : ""}`);
} finally {
  console.log(JSON.stringify({ results }, null, 2));
  await h.close();
}
