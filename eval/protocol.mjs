// Layer (a): protocol evals. Scripted clients only (pi + scripted brain, CLI, MCP); no LLM. Must pass 100%.
import { countDelivery, sleep } from "./lib.mjs";

export const protocol = {
  async ask_reply_cli(h, ctx) {
    const ops = await h.mint("ops-1");
    ctx.agent(h.startPi("peer-1", { env: h.swarmEnv(await h.mint("peer-1")) }));
    await h.online("peer-1");
    const latencies = [];
    for (let i = 0; i < 10; i++) {
      const t = Date.now();
      const r = await ops.client.ask("peer-1", `ping ${i}`, { timeoutSec: 30 });
      if (!r.reply) return { pass: false, detail: `no reply to ping ${i}`, latencies };
      latencies.push(Date.now() - t);
    }
    return { pass: true, detail: "CLI client → pi session: 10/10 asks answered", latencies };
  },

  async ask_reply_mcp(h, ctx) {
    const me = await h.mint("mcp-2");
    ctx.agent(h.startPi("peer-2", { env: h.swarmEnv(await h.mint("peer-2")) }));
    await h.online("peer-2");
    const mcp = h.startMcp(me);
    ctx.proc(mcp.proc);
    await mcp.init();
    const latencies = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      const text = await mcp.call("swarm_ask", { to: "peer-2", message: `mcp ping ${i}`, timeoutSec: 30 });
      if (!text.includes("<swarm_message")) return { pass: false, detail: `no reply: ${text}`, latencies };
      latencies.push(Date.now() - t);
    }
    const roster = await mcp.call("swarm_list", {});
    return { pass: roster.includes("peer-2") && roster.includes("[you]"), detail: "MCP host → pi session: 3/3 asks answered", latencies };
  },

  async offline_delivery(h, ctx) {
    const ops = await h.mint("ops-3");
    const late = await h.mint("late-3");
    const expected = ["m1", "m2", "m3", "m4", "m5"];
    for (const m of expected) await ops.client.send("late-3", m);
    const piAgent = await h.mint("late-pi-3");
    const asking = ops.client.ask("late-pi-3", "answer when you are back", { timeoutSec: 60 });
    await sleep(1000);
    ctx.agent(h.startPi("late-pi-3", { env: h.swarmEnv(piAgent) }));
    const answered = await asking;
    const inbox = await late.client.inbox();
    await late.client.ack(inbox.cursor);
    const again = await late.client.inbox();
    const received = [...inbox.messages, ...again.messages].map((m) => m.text);
    const { lost, duplicated } = countDelivery(expected, received);
    const ordered = received.join(",") === expected.join(",");
    return {
      pass: !!answered.reply && lost === 0 && duplicated === 0 && ordered,
      detail: `5 sends to a never-connected agent: lost ${lost}, dup ${duplicated}, in order ${ordered}; ask to a not-yet-started pi answered: ${!!answered.reply}`,
      lost, duplicated,
    };
  },

  async kill_mid_wait(h, ctx) {
    const ops = await h.mint("ops-4");
    const waiter = await h.mint("waiter-4");
    const first = ctx.proc(h.spawnCli(waiter, ["wait", "--timeout", "30", "--json"]));
    await sleep(700);
    first.kill("SIGKILL");
    const expected = ["k1", "k2", "k3", "k4", "k5"];
    for (const m of expected) await ops.client.send("waiter-4", m);
    const out = JSON.parse(await h.cli(waiter, ["wait", "--timeout", "10", "--json"]));
    const again = JSON.parse(await h.cli(waiter, ["inbox", "--json"]));
    const received = [...out.messages, ...again.messages].map((m) => m.text);
    const { lost, duplicated } = countDelivery(expected, received);
    return { pass: lost === 0 && duplicated === 0, detail: `SIGKILL mid-wait, 5 sends, restart: lost ${lost}, dup ${duplicated}`, lost, duplicated };
  },

  async presence_after_kill(h, ctx) {
    const peer = await h.mint("peer-5");
    const pi = ctx.agent(h.startPi("peer-5", { env: h.swarmEnv(peer) }));
    await h.online("peer-5");
    const t = Date.now();
    await pi.stop(); // SIGKILL: no goodbye
    await h.waitFor(async () => !(await h.admin.list()).agents.find((a) => a.id === "peer-5").online, 30_000, "offline");
    const ms = Date.now() - t;
    return { pass: ms < 5000, detail: `SIGKILLed pi shown offline after ${ms} ms (limit 5000)` };
  },

  async collision_markers(h, ctx) {
    const a = await h.mint("worker-a-6");
    const b = await h.mint("worker-b-6");
    const c = await h.mint("worker-c-6");
    await a.client.presence({ marker: "on: BENCH-7 src/auth", markerTtlSec: 600 });
    const mcp = h.startMcp(b);
    ctx.proc(mcp.proc);
    await mcp.init();
    const warn = await mcp.call("swarm_status", { marker: "fixing BENCH-7 tests" });
    const unrelated = await c.client.presence({ marker: "on: BENCH-8 docs" });
    await a.client.presence({ marker: "on: /repo/src/auth" });
    const pathWarn = await c.client.presence({ marker: "editing /repo/src/auth/login.ts" });
    const roster = (await c.client.list()).agents;
    const ok = warn.includes("worker-a-6") && unrelated.overlaps.length === 0 && pathWarn.overlaps.some((o) => o.id === "worker-a-6") && roster.filter((r) => r.marker).length === 3;
    return { pass: ok, detail: `issue-id overlap warned via MCP: ${warn.includes("worker-a-6")}; unrelated marker quiet: ${unrelated.overlaps.length === 0}; path overlap warned: ${pathWarn.overlaps.length > 0}; nothing blocked` };
  },

  async handoff_offline(h, ctx) {
    const lead = await h.mint("lead-7");
    const heir = await h.mint("heir-7");
    await lead.client.send("heir-7", "HANDOFF uppercase finish the release notes", { expects: "reply" });
    ctx.agent(h.startPi("heir-7", { env: h.swarmEnv(heir) }));
    const res = await h.waitFor(async () => (await lead.client.inbox()).messages.find((m) => m.kind === "reply") ?? null, 20_000, "handoff result");
    return { pass: res.text === "DONE FINISH THE RELEASE NOTES", detail: `heir started after the handoff, did it, lead got "${res.text}"` };
  },

  async late_reply_after_timeout(h) {
    const asker = await h.mint("asker-8");
    const slow = await h.mint("slow-8");
    const r = await asker.client.ask("slow-8", "take your time", { timeoutSec: 2 });
    const inbox = await slow.client.inbox();
    await slow.client.reply(inbox.messages[0].id, "sorry, late");
    const late = await asker.client.inbox({ waitSec: 5 });
    const got = late.messages.find((m) => m.replyTo === r.ask.id);
    return { pass: r.timedOut === true && got?.text === "sorry, late", detail: `ask timed out: ${!!r.timedOut}; late reply reached the asker's inbox: ${!!got}` };
  },

  async coop_task(h, ctx) {
    const a = await h.mint("coop-a-9");
    const b = await h.mint("coop-b-9");
    const pa = ctx.agent(h.startPi("coop-a-9", { env: h.swarmEnv(a), files: { "numbers.txt": "1 2 3 4\n" } }));
    ctx.agent(h.startPi("coop-b-9", { env: h.swarmEnv(b), files: { "numbers.txt": "10 20 30\n" } }));
    await h.online("coop-a-9");
    await h.online("coop-b-9");
    pa.prompt("COOP coop-b-9 numbers.txt");
    const result = await h.waitFor(() => pa.read("result.txt"), 30_000, "coop result");
    return { pass: result === "70", detail: `two pi sessions in different folders combined their files: ${result} (expected 70)` };
  },
};

// Same scenarios on pi-intercom (same machine only). Ones it has no primitive for are reported as unsupported.
export const intercomBaseline = {
  async ask_reply_cli(h, ctx) {
    ctx.agent(h.startPi("ic-peer-1", { transport: "intercom", env: h.intercomEnv }));
    await h.intercomOnline("ic-peer-1");
    const latencies = [];
    for (let i = 0; i < 10; i++) {
      const t = Date.now();
      const r = await h.intercomCli(["ask", "--to", "ic-peer-1", "--text", `ping ${i}`, "--timeout-ms", "30000"]);
      if (!r.ok) return { pass: false, detail: `ask ${i} failed: ${r.out.slice(0, 200)}`, latencies };
      latencies.push(Date.now() - t);
    }
    return { pass: true, detail: "CLI → pi session over pi-intercom: 10/10", latencies };
  },
  async offline_delivery(h) {
    const r = await h.intercomCli(["send", "--to", "ic-never-started", "--text", "m1"]);
    return { pass: r.ok, detail: r.ok ? "queued" : `rejected: ${r.out.replace(/\s+/g, " ").slice(0, 120)}`, lost: r.ok ? 0 : 1 };
  },
  async coop_task(h, ctx) {
    const pa = ctx.agent(h.startPi("ic-coop-a", { transport: "intercom", env: h.intercomEnv, files: { "numbers.txt": "1 2 3 4\n" } }));
    ctx.agent(h.startPi("ic-coop-b", { transport: "intercom", env: h.intercomEnv, files: { "numbers.txt": "10 20 30\n" } }));
    await h.intercomOnline("ic-coop-a");
    await h.intercomOnline("ic-coop-b");
    pa.prompt("COOP ic-coop-b numbers.txt");
    const result = await h.waitFor(() => pa.read("result.txt"), 30_000, "coop result").catch((e) => e.message);
    return { pass: result === "70", detail: `pi-intercom coop result: ${result}` };
  },
  ask_reply_mcp: "no MCP server: other harnesses can't join",
  kill_mid_wait: "no durable inbox or cursor to resume from",
  presence_after_kill: "not measured (list shows connected sessions only)",
  collision_markers: "no expiring work markers or overlap warnings",
  handoff_offline: "messages to a session that isn't running are rejected",
  late_reply_after_timeout: "the CLI ask's bridge session is gone after its timeout",
};
