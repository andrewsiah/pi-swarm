#!/usr/bin/env node
// pi-swarm eval: one command, two layers.
//   (a) protocol: scripted clients, no LLM, must pass 100% (+ the same scenarios on pi-intercom as a baseline)
//   (b) agents:   real LLM pi sessions, each scenario --reps times (default 3), reported as a pass rate with spread
//
//   npm run eval                 # both layers on a local self-hosted hub
//   npm run eval -- --quick      # protocol layer only (seconds, no tokens)
//   npm run eval -- --hub https://… --admin-token-file ~/.config/pi-swarm/admin-token
//   npm run eval -- --only coop_task,coop_files --reps 1 --no-baseline --keep   # --keep leaves pi transcripts
//
// Prints one summary line and writes eval/results/<time>-<sha>.json.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, runScenario, percentile, root, INTERCOM, LLM } from "./lib.mjs";
import { protocol, intercomBaseline } from "./protocol.mjs";
import { agents } from "./agents.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const quick = args.includes("--quick");
const only = flag("only") ? String(flag("only")).split(",") : null;
const reps = Number(flag("reps", 3));
const baseline = !args.includes("--no-baseline") && fs.existsSync(path.join(INTERCOM, "index.ts"));
const selected = (set) => Object.entries(set).filter(([name]) => !only || only.includes(name));
const log = (msg) => console.error(msg);

const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };
const sha = git("rev-parse --short HEAD") ?? "nogit";
const dirty = !!git("status --porcelain");

function summarize(rows, { tokens }) {
  const run = rows.filter((r) => !r.unsupported);
  const lat = run.flatMap((r) => r.latenciesMs).sort((a, b) => a - b);
  const passed = rows.filter((r) => r.pass).length;
  return {
    passed, total: rows.length, passRate: rows.length ? passed / rows.length : 0, unsupported: rows.filter((r) => r.unsupported).length,
    durationMs: run.reduce((s, r) => s + r.durationMs, 0), lost: run.reduce((s, r) => s + r.lost, 0), duplicated: run.reduce((s, r) => s + r.duplicated, 0),
    latencyP50Ms: percentile(lat, 50), latencyP95Ms: percentile(lat, 95), latencySamples: lat.length,
    ...(tokens ? { tokens: run.reduce((s, r) => s + r.tokens, 0) } : {}),
  };
}

async function runLayer(h, label, set, timeoutMs) {
  const rows = [];
  for (const [name, fn] of selected(set)) {
    if (typeof fn === "string") {
      rows.push({ name, pass: false, unsupported: true, detail: fn });
      continue;
    }
    const row = await runScenario(h, name, fn, timeoutMs);
    rows.push(row);
    log(`[${label}] ${row.pass ? "PASS" : "FAIL"} ${name} (${(row.durationMs / 1000).toFixed(1)}s): ${row.detail}`);
  }
  return rows;
}

const h = await createHarness({ hub: flag("hub", "local"), adminTokenFile: flag("admin-token-file"), keep: args.includes("--keep") });
let exitCode = 1;
try {
  const result = { evalVersion: 2, sha, dirty, at: new Date().toISOString(), host: os.hostname(), hub: h.hubUrl.startsWith("http://127.0.0.1") ? "local-node" : h.hubUrl };

  const protoRows = await runLayer(h, "protocol", protocol, 90_000);
  result.protocol = { summary: summarize(protoRows, { tokens: false }), scenarios: protoRows };
  if (baseline) {
    const rows = await runLayer(h, "intercom", intercomBaseline, 90_000);
    result.intercomBaseline = { note: "same scenarios on pi-intercom (same machine only)", summary: summarize(rows, { tokens: false }), scenarios: rows };
  }

  if (!quick && selected(agents).length) {
    const repRows = [];
    for (let rep = 1; rep <= reps; rep++) {
      const rows = (await runLayer(h, `agents ${rep}/${reps}`, agents, 240_000)).map((r) => ({ ...r, rep }));
      repRows.push(rows);
    }
    const all = repRows.flat();
    const repRates = repRows.map((rows) => rows.filter((r) => r.pass).length / rows.length);
    const perScenario = Object.fromEntries(selected(agents).map(([name]) => {
      const runs = all.filter((r) => r.name === name);
      return [name, { passed: runs.filter((r) => r.pass).length, runs: runs.length }];
    }));
    result.agents = {
      model: `${LLM.provider}/${LLM.model}`, reps,
      summary: { ...summarize(all, { tokens: true }), repPassRates: repRates, spread: [Math.min(...repRates), Math.max(...repRates)] },
      perScenario, runs: all,
    };
  }

  const outDir = path.join(root, "eval/results");
  fs.mkdirSync(outDir, { recursive: true });
  const file = String(flag("out", path.join(outDir, `${result.at.replace(/[:.]/g, "-")}-${sha}.json`)));
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");

  const p = result.protocol.summary;
  const pct = (x) => `${Math.round(x * 100)}%`;
  let line = `pi-swarm eval ${sha}${dirty ? "+dirty" : ""}: protocol ${p.passed}/${p.total} (${pct(p.passRate)}) p50 ${p.latencyP50Ms}ms p95 ${p.latencyP95Ms}ms lost ${p.lost} dup ${p.duplicated}`;
  if (result.agents) {
    const a = result.agents.summary;
    line += ` · agents ${a.passed}/${a.total} (${pct(a.passRate)}, reps ${pct(a.spread[0])}-${pct(a.spread[1])}) p50 ${a.latencyP50Ms ?? "-"}ms ${(a.durationMs / 1000).toFixed(0)}s ~${Math.round(a.tokens / 1000)}k tok`;
  }
  if (result.intercomBaseline) {
    const b = result.intercomBaseline.summary;
    line += ` · pi-intercom ${b.passed}/${b.total} (${b.unsupported} unsupported)`;
  }
  console.log(`${line} → ${path.relative(process.cwd(), file)}`);
  exitCode = p.passed === p.total ? 0 : 1; // the protocol layer is the gate; agent evals are a score
} finally {
  await h.close();
}
process.exit(exitCode);
