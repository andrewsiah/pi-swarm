// Live cross-machine test: a real pi session (pi-swarm extension + scripted brain, no LLM key) in an E2B sandbox,
// talking through the hub to agents on this machine ("the VM"). Only scoped swarm tokens for e2b-pi / e2b-cli enter the sandbox.
//
// Run on your machine:
//   E2B_API_KEY=… PI_SWARM_URL=https://hub.example.com PI_SWARM_SWARM=live \
//     PI_SWARM_ADMIN_TOKEN_FILE=~/.config/pi-swarm/admin-token OPS_TOKEN_FILE=… E2B_SDK_DIR=/dir/with/e2b \
//     node examples/e2b/live-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { SwarmClient } from "../../client/client.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const { PI_SWARM_URL: url, PI_SWARM_SWARM: swarm, PI_SWARM_ADMIN_TOKEN_FILE, OPS_TOKEN_FILE, E2B_SDK_DIR = process.cwd(), ASK_TARGET = "vm-a" } = process.env;
const { Sandbox } = createRequire(`${E2B_SDK_DIR}/`)("e2b");
const expand = (p) => p.replace(/^~\//, os.homedir() + "/");
const admin = new SwarmClient({ url, swarm, token: fs.readFileSync(expand(PI_SWARM_ADMIN_TOKEN_FILE), "utf8").trim() });
const ops = new SwarmClient({ url, swarm, token: fs.readFileSync(expand(OPS_TOKEN_FILE), "utf8").trim() });
const t0 = Date.now();
const log = (msg) => console.log(`${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const sbx = await Sandbox.create("base", { timeoutMs: 30 * 60_000, metadata: { purpose: "pi-swarm-live-test" } });
try {
  log(`sandbox ${sbx.sandboxId} up`);
  const node = await sbx.commands.run("node --version && hostname");
  log(`sandbox node/hostname: ${node.stdout.trim().replace(/\n/g, " ")}`);
  for (const rel of ["package.json", "client/client.mjs", "bin/pi-swarm.mjs", "extension/index.ts", "examples/e2b/scripted-brain.ts"]) {
    await sbx.files.write(`/home/user/pi-swarm/${rel}`, fs.readFileSync(path.join(root, rel), "utf8"));
  }
  // Scoped tokens only: minted for these two sandbox identities, revoked at the end.
  const tokens = {};
  for (const id of ["e2b-pi", "e2b-cli"]) {
    tokens[id] = (await admin.mint(id, id)).token;
    await sbx.files.write(`/home/user/.${id}.token`, tokens[id] + "\n");
  }
  await sbx.commands.run("chmod 600 /home/user/.e2b-*.token && chmod +x /home/user/pi-swarm/bin/pi-swarm.mjs");
  let started = Date.now();
  // pi 1.5 needs Node >= 22; the E2B base image ships Node 20.
  const install = await sbx.commands.run("(npm i -g --no-audit --no-fund n && n -q 22 && hash -r && npm i -g --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.0) 2>&1 | tail -2; node --version", { timeoutMs: 300_000, user: "root" });
  log(`installed pi in sandbox in ${((Date.now() - started) / 1000).toFixed(1)}s: ${install.stdout.trim().split("\n").pop()}`);

  const envFor = (id) => ({ PI_SWARM_URL: url, PI_SWARM_SWARM: swarm, PI_SWARM_TOKEN_FILE: `/home/user/.${id}.token`, PI_SWARM_CONFIG: "/nonexistent" });
  const startPi = async () => {
    await sbx.commands.run("rm -f /home/user/pi.in && mkfifo /home/user/pi.in");
    const cmd = "cd /home/user && (tail -f /home/user/pi.in | pi --mode rpc --no-session --provider scripted --model brain " +
      "-e /home/user/pi-swarm/extension/index.ts -e /home/user/pi-swarm/examples/e2b/scripted-brain.ts >> /home/user/pi.out 2>&1)";
    const handle = await sbx.commands.run(cmd, { envs: envFor("e2b-pi"), background: true });
    for (let i = 0; i < 100; i++) {
      const roster = await ops.list();
      const me = roster.agents.find((a) => a.id === "e2b-pi");
      if (me?.online && me.status === "idle" && me.host !== os.hostname()) return handle;
      await sleep(300);
    }
    const tail = await sbx.files.read("/home/user/pi.out").catch(() => "");
    throw new Error(`e2b pi never came online; pi.out tail:\n${tail.slice(-1500)}`);
  };
  const prompt = (message) => sbx.commands.run(`echo ${JSON.stringify(JSON.stringify({ type: "prompt", message }))} > /home/user/pi.in`);

  // 1. Roster sees the sandbox pi.
  started = Date.now();
  let piHandle = await startPi();
  const roster = await ops.list();
  const e2b = roster.agents.find((a) => a.id === "e2b-pi");
  record("e2b pi joins and shows in list", true, `online after ${((Date.now() - started) / 1000).toFixed(1)}s, host=${e2b.host}, harness=${e2b.harness}; roster: ${roster.agents.map((a) => `${a.id}:${a.online ? "on" : "off"}`).join(" ")}`);

  // 2. VM -> E2B ask/reply latency (scripted brain answers, so this is transport + pi turn overhead).
  const lat = [];
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    const res = await ops.ask("e2b-pi", `ping ${i} from the VM`, { timeoutSec: 60 });
    if (!res.reply) throw new Error("no reply from e2b-pi");
    lat.push(Date.now() - s);
    if (i === 0) log(`reply text: ${res.reply.text}`);
  }
  record("VM -> E2B ask/reply", true, `round trips ms: ${lat.join(" ")} (median ${lat.slice().sort((a, b) => a - b)[2]})`);

  // 3. E2B -> VM ask/reply: the sandbox pi asks a real LLM pi session on the VM.
  const evBefore = (await admin.events(0, { limit: 1000 })).cursor;
  started = Date.now();
  await prompt(`ASK ${ASK_TARGET}: Hi from an E2B sandbox. In one short sentence, what folder is your session running in?`);
  let answered = null;
  for (let i = 0; i < 240 && !answered; i++) {
    await sleep(500);
    const ev = await admin.events(evBefore, { text: true, limit: 1000 });
    const ask = ev.events.find((e) => e.actor === "e2b-pi" && e.kind === "message_ask" && e.target === ASK_TARGET);
    if (ask) answered = ev.events.find((e) => e.kind === "message_reply" && e.replyTo === ask.messageId);
    if (answered) {
      const askTs = Date.parse(ask.ts);
      record("E2B -> VM ask/reply (real LLM on the VM)", true, `ask→reply ${((Date.parse(answered.ts) - askTs) / 1000).toFixed(2)}s at the hub; reply: ${JSON.stringify(answered.text)}`);
    }
  }
  if (!answered) record("E2B -> VM ask/reply (real LLM on the VM)", false, "no reply within 120s");
  await sleep(1500);
  const out = (await sbx.files.read("/home/user/pi.out")).split("\n").filter((l) => l.includes("[brain] tool result")).slice(-1)[0] ?? "";
  log(`sandbox pi saw: ${out.slice(0, 300)}`);

  // 4. Offline delivery: kill the sandbox pi, ask it while it is down, restart, and the queued ask gets answered.
  await sbx.commands.run("pkill -9 -f '[p]i --mode rpc' ; pkill -9 -f '[t]ail -f /home/user/pi.in'; true");
  await piHandle.kill().catch(() => {});
  for (let i = 0; i < 200; i++) {
    const r = (await ops.list()).agents.find((a) => a.id === "e2b-pi");
    if (!r.online) break;
    await sleep(500);
  }
  const offlineAsk = ops.ask("e2b-pi", "this was sent while you were offline; reply when you are back", { timeoutSec: 300 });
  await sleep(5000);
  const queued = (await ops.list()).agents.find((a) => a.id === "e2b-pi");
  log(`while down: e2b-pi online=${queued.online} pending=${queued.pending}`);
  const restartAt = Date.now();
  piHandle = await startPi();
  const offlineRes = await offlineAsk;
  record("offline agent gets queued mail on return", !!offlineRes.reply && queued.pending >= 1 && !queued.online,
    `pending while down=${queued.pending}; reply ${((Date.now() - restartAt) / 1000).toFixed(1)}s after restart (incl. pi startup): ${offlineRes.reply?.text}`);

  // 5. A CLI client killed mid-wait resumes from the server cursor without loss.
  const waitCmd = "node /home/user/pi-swarm/bin/pi-swarm.mjs wait --timeout 120";
  const first = await sbx.commands.run(waitCmd, { envs: envFor("e2b-cli"), background: true });
  await sleep(3000);
  await first.kill();
  await sbx.commands.run("pkill -9 -f '[p]i-swarm.mjs wait'; true");
  for (const t of ["lost? #1", "lost? #2", "lost? #3"]) await ops.send("e2b-cli", t);
  const second = await sbx.commands.run(waitCmd, { envs: envFor("e2b-cli"), timeoutMs: 60_000 });
  const got = ["#1", "#2", "#3"].filter((t) => second.stdout.includes(`lost? ${t}`));
  record("CLI killed mid-wait resumes without loss", got.length === 3, `after restart got ${got.length}/3 messages`);

  // 6. Markers from the sandbox show up on the VM, and overlaps are reported (never blocking).
  await prompt("STATUS on: TASK-42 live test from e2b");
  await sleep(3000);
  const markerRow = (await ops.list()).agents.find((a) => a.id === "e2b-pi");
  const overlap = await ops.presence({ marker: "on: TASK-42 ops checks", markerTtlSec: 600 });
  record("markers visible across machines", markerRow.marker === "on: TASK-42 live test from e2b" && overlap.overlaps.some((o) => o.id === "e2b-pi"),
    `e2b-pi marker="${markerRow.marker}" expires ${markerRow.markerExpiresAt}; ops overlap warning: ${overlap.overlaps.map((o) => `${o.id}:"${o.marker}"`).join(", ")}`);
} catch (error) {
  record("live test", false, error.stack);
} finally {
  for (const id of ["e2b-pi", "e2b-cli"]) await admin.revoke(id).catch(() => {});
  log("revoked e2b tokens");
  await sbx.kill();
  log("sandbox killed");
  console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
