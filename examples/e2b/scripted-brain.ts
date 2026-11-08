// A deterministic "model" for pi, so real pi sessions can run (in E2B or in the benchmark) without any LLM API key.
// It drives the real messaging extension: pi-swarm (`swarm` tool, default) or pi-intercom (BRAIN_TOOL=intercom).
// Usage: pi --provider scripted --model brain -e extension/index.ts -e examples/e2b/scripted-brain.ts
//
// Rules: answers incoming asks; "SUM <file>" -> sum of the numbers in <file> (cwd); "HANDOFF uppercase <text>" ->
// "DONE <TEXT>". Prompts: "ASK <to>: q", "SEND <to>: m", "STATUS <marker>", "LIST", "COOP <peer> <file>" (ask the peer
// for its sum of <file>, add the local one, write result.txt).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const TOOL = process.env.BRAIN_TOOL === "intercom" ? "intercom" : "swarm";
let coop: { file: string } | undefined;

function textOf(message: any): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
  return "";
}

function sumFile(file: string): number {
  const text = fs.readFileSync(path.resolve(process.cwd(), path.basename(file)), "utf8");
  return (text.match(/-?\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0);
}

function answer(body: string, kind: string, from: string): string {
  const sum = /^SUM (\S+)$/.exec(body.trim());
  if (sum) return `SUM=${sumFile(sum[1])}`;
  const handoff = /^HANDOFF uppercase ([\s\S]+)$/.exec(body.trim());
  if (handoff) return `DONE ${handoff[1].toUpperCase()}`;
  return `brain on ${os.hostname()} (${os.platform()}, node ${process.version}) got your ${kind} from ${from}: "${body.slice(0, 200)}"`;
}

function decide(context: any) {
  const messages = (context.messages ?? []).filter((m: any) => m.role !== "system");
  const last = messages[messages.length - 1];
  if (!last) return fauxAssistantMessage("ok");
  if (last.role === "toolResult") {
    const result = textOf(last);
    const peerSum = /SUM=(-?\d+)/.exec(result);
    if (coop && peerSum) {
      const total = sumFile(coop.file) + Number(peerSum[1]);
      fs.writeFileSync(path.join(process.cwd(), "result.txt"), `${total}\n`);
      coop = undefined;
      return fauxAssistantMessage(`[brain] coop total ${total}`);
    }
    return fauxAssistantMessage(`[brain] tool result: ${result.slice(0, 300)}`);
  }
  const text = textOf(last);
  const swarm = /<swarm_message id="([^"]+)" from="([^"]*)" kind="([^"]+)" expects="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/swarm_message>/.exec(text);
  if (swarm) {
    const [, id, from, kind, expects, body] = swarm;
    if (kind === "ask" || expects !== "none" || /^HANDOFF /.test(body)) {
      return fauxAssistantMessage(fauxToolCall("swarm", { action: "reply", messageId: id, message: answer(body, kind, from) }));
    }
    return fauxAssistantMessage(`[brain] noted ${kind} from ${from}: ${body.slice(0, 200)}`);
  }
  const intercom = /^\*\*From ([^*]+)\*\*[\s\S]*?To reply, use the intercom tool: (intercom\([^\n]*\))/.exec(text);
  if (intercom) {
    const body = text.split("\n\n").pop() ?? "";
    const replyTo = /replyTo: "([^"]+)"/.exec(intercom[2])?.[1];
    return fauxAssistantMessage(fauxToolCall("intercom", { action: "reply", message: answer(body, "ask", intercom[1]), ...(replyTo ? { replyTo } : {}) }));
  }
  const prompt = text.trim();
  const coopCmd = /^COOP (\S+) (\S+)$/.exec(prompt);
  if (coopCmd) {
    coop = { file: coopCmd[2] };
    const args = { action: "ask", to: coopCmd[1], message: `SUM ${coopCmd[2]}` };
    return fauxAssistantMessage(fauxToolCall(TOOL, TOOL === "swarm" ? { ...args, timeoutSec: 60 } : args));
  }
  const ask = /^ASK ([^:]+):\s*([\s\S]+)$/.exec(prompt);
  if (ask) return fauxAssistantMessage(fauxToolCall(TOOL, { action: "ask", to: ask[1].trim(), message: ask[2].trim(), ...(TOOL === "swarm" ? { timeoutSec: 180 } : {}) }));
  const send = /^SEND ([^:]+):\s*([\s\S]+)$/.exec(prompt);
  if (send) return fauxAssistantMessage(fauxToolCall(TOOL, { action: "send", to: send[1].trim(), message: send[2].trim() }));
  const status = /^STATUS\s+([\s\S]+)$/.exec(prompt);
  if (status && TOOL === "swarm") return fauxAssistantMessage(fauxToolCall("swarm", { action: "status", marker: status[1].trim(), status: "working" }));
  if (prompt === "LIST") return fauxAssistantMessage(fauxToolCall(TOOL, { action: "list" }));
  return fauxAssistantMessage(`[brain] ok: ${text.slice(0, 100)}`);
}

export default function scriptedBrain(pi: ExtensionAPI) {
  const handle = fauxProvider({ provider: "scripted", models: [{ id: "brain", name: "Scripted brain", reasoning: false }], tokensPerSecond: 10_000 });
  handle.setResponses(Array.from({ length: 1000 }, () => decide));
  pi.registerProvider(handle.provider as any);
}
