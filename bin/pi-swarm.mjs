#!/usr/bin/env node
// pi-swarm CLI: lets any harness (Claude Code, Codex, shell scripts) join a swarm.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwarmClient, SwarmError, cleanLine, loadConfig, formatMessageForAgent, formatRoster, MAX_WAIT_SEC } from "../client/client.mjs";

const HELP = `pi-swarm — cross-machine messaging for coding agents

Usage:
  pi-swarm whoami
  pi-swarm list
  pi-swarm send <to> <message...> [--expects none|reply|decision]
  pi-swarm ask <to> <message...> [--timeout SEC] [--request-id ID]
                                                       block until the reply (default 600 s); rerun with the same
                                                       --request-id after a crash to resume instead of re-asking
  pi-swarm reply <messageId> <message...>
  pi-swarm inbox [--wait SEC] [--no-ack]               print unread mail, then ack it
  pi-swarm wait [--timeout SEC] [--no-ack]             block until mail arrives (default 600 s)
  pi-swarm status [--status S] [--marker "on: AND-1 x"] [--ttl SEC] [--clear-marker] [--name N]
  pi-swarm events [--after N] [--text]                 admin: append-only event log
  pi-swarm admin mint <id> [--name N] [--out FILE]     admin: mint/rotate an agent token (written to FILE, 0600)
  pi-swarm admin revoke <id>
  pi-swarm hook claude-stop [--wait SEC]               Claude Code Stop hook: wake the session on new mail

Global: --json for raw output. Config: PI_SWARM_URL, PI_SWARM_SWARM, PI_SWARM_TOKEN_FILE (or ~/.config/pi-swarm/config.json,
PI_SWARM_PROFILE). Admin commands use PI_SWARM_ADMIN_TOKEN_FILE.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (["json", "no-ack", "text", "clear-marker", "help"].includes(key) || next === undefined || next.startsWith("--")) flags[key] = true;
      else flags[key] = argv[++i];
    } else positional.push(a);
  }
  return { positional, flags };
}

const out = (flags, data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

function adminClient() {
  const cfg = loadConfig();
  const file = process.env.PI_SWARM_ADMIN_TOKEN_FILE;
  const token = process.env.PI_SWARM_ADMIN_TOKEN || (file ? fs.readFileSync(file.replace(/^~\//, os.homedir() + "/"), "utf8").trim() : undefined);
  if (!token) throw new SwarmError("admin commands need PI_SWARM_ADMIN_TOKEN_FILE");
  return new SwarmClient({ ...cfg, token });
}

async function drain(client, { waitSec, ack, replyHint }) {
  const deadline = Date.now() + waitSec * 1000;
  let res;
  do {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    res = await client.inbox({ waitSec: Math.max(0, Math.min(MAX_WAIT_SEC, remaining)) });
  } while (!res.messages.length && Date.now() < deadline);
  const text = res.messages.map((m) => formatMessageForAgent(m, { replyHint })).join("\n\n");
  if (ack && res.messages.length) await client.ack(res.cursor);
  return { ...res, text };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || flags.help) return console.log(HELP);

  if (cmd === "admin") {
    const [sub, id] = positional;
    const admin = adminClient();
    if (sub === "mint") {
      if (!id) throw new SwarmError("usage: pi-swarm admin mint <id> [--name N] [--out FILE]");
      const res = await admin.mint(id, flags.name);
      const file = flags.out || path.join(os.homedir(), ".config", "pi-swarm", "tokens", `${admin.swarm}.${id}.token`);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, res.token + "\n", { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return out(flags, { agent: res.agent, tokenFile: file, rotated: res.rotated }, `${res.rotated ? "rotated" : "minted"} ${res.agent.id} (${res.agent.name}); token written to ${file}`);
    }
    if (sub === "revoke") return out(flags, await admin.revoke(id), `revoked ${id}`);
    throw new SwarmError("usage: pi-swarm admin mint|revoke <id>");
  }
  if (cmd === "events") {
    const res = await adminClient().events(Number(flags.after ?? 0), { text: !!flags.text });
    return out(flags, res, res.events.map((e) => `${e.seq} ${e.ts} ${e.actor ?? "-"} ${e.kind}${e.target ? ` → ${e.target}` : ""}${e.messageId ? ` msg=${e.messageId.slice(0, 8)}` : ""}${e.replyTo ? ` re=${e.replyTo.slice(0, 8)}` : ""}${e.data ? ` ${JSON.stringify(e.data)}` : ""}${e.text !== undefined ? `\n    ${JSON.stringify(e.text)}` : ""}`).join("\n"));
  }

  const client = SwarmClient.fromEnv();
  switch (cmd) {
    case "whoami": {
      const me = await client.me();
      return out(flags, me, `${me.name} (${me.id}) in swarm ${me.swarm} via ${client.url}; ${me.pending} unread`);
    }
    case "list": {
      const [me, res] = await Promise.all([client.me(), client.list()]);
      return out(flags, res, formatRoster(res.agents, me.id));
    }
    case "send": {
      const [to, ...words] = positional;
      if (!to || !words.length) throw new SwarmError("usage: pi-swarm send <to> <message...>");
      const res = await client.send(to, words.join(" "), { expects: flags.expects });
      return out(flags, res, `sent ${res.message.id} to ${res.message.to.name}${res.recipientOnline ? "" : " (offline: queued until they connect)"}`);
    }
    case "ask": {
      const [to, ...words] = positional;
      if (!to || !words.length) throw new SwarmError("usage: pi-swarm ask <to> <message...> [--timeout SEC]");
      const started = Date.now();
      const res = await client.ask(to, words.join(" "), { timeoutSec: Number(flags.timeout ?? 600), requestId: flags["request-id"] });
      if (!res.reply) {
        out(flags, res, `no reply within ${flags.timeout ?? 600}s; ask ${res.ask.id} stays in ${res.ask.to.name}'s mailbox and a late reply will reach your inbox`);
        process.exitCode = 2;
        return;
      }
      return out(flags, { ...res, latencyMs: Date.now() - started }, `${formatMessageForAgent(res.reply, { replyHint: "cli" })}\n(reply after ${((Date.now() - started) / 1000).toFixed(2)}s)`);
    }
    case "reply": {
      const [id, ...words] = positional;
      if (!id || !words.length) throw new SwarmError("usage: pi-swarm reply <messageId> <message...>");
      const res = await client.reply(id, words.join(" "));
      return out(flags, res, `replied ${res.message.id} to ${res.message.to.name}`);
    }
    case "inbox":
    case "wait": {
      const waitSec = Number(cmd === "wait" ? (flags.timeout ?? 600) : (flags.wait ?? 0));
      const res = await drain(client, { waitSec, ack: !flags["no-ack"], replyHint: "cli" });
      if (!res.messages.length && cmd === "wait") process.exitCode = 2;
      return out(flags, res, res.messages.length ? res.text : "no new messages");
    }
    case "status": {
      const body = {};
      if (flags.status) body.status = flags.status;
      if (flags.name) body.name = flags.name;
      if (flags.marker) body.marker = flags.marker;
      if (flags["clear-marker"]) body.marker = null;
      if (flags.ttl) body.markerTtlSec = Number(flags.ttl);
      body.harness = process.env.PI_SWARM_HARNESS || "cli";
      body.host = os.hostname();
      body.cwd = process.cwd();
      const res = await client.presence(body);
      const warn = res.overlaps.length ? `\nheads-up, overlapping markers (not a lock): ${res.overlaps.map((o) => `${cleanLine(o.name)} on "${cleanLine(o.marker)}"${o.online ? "" : " (offline)"}`).join("; ")}` : "";
      return out(flags, res, `status updated${res.me?.marker ? `; ${/^on:/i.test(res.me.marker) ? res.me.marker : `on: ${res.me.marker}`} until ${res.me.markerExpiresAt}` : ""}${warn}`);
    }
    case "hook": {
      const [kind] = positional;
      const stdin = await new Promise((resolve) => {
        if (process.stdin.isTTY) return resolve("");
        let s = "";
        const timer = setTimeout(() => { process.stdin.pause(); resolve(s); }, 1000); // hosts that never close stdin
        process.stdin.on("data", (d) => (s += d)).on("end", () => { clearTimeout(timer); resolve(s); });
      });
      void stdin; // Claude Code sends hook JSON on stdin; nothing in it is needed
      if (kind === "claude-stop") {
        const res = await drain(client, { waitSec: Number(flags.wait ?? 0), ack: true, replyHint: "cli" });
        if (res.messages.length) {
          console.log(JSON.stringify({ decision: "block", reason: `New pi-swarm mail (${res.messages.length}). Handle it, then continue.\n\n${res.text}` }));
        }
        return;
      }
      throw new SwarmError("usage: pi-swarm hook claude-stop [--wait SEC]");
    }
    default:
      throw new SwarmError(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((error) => {
  console.error(`pi-swarm: ${error.message}`);
  process.exitCode = 1;
});
