// Layer (b): agent evals. Real LLM pi sessions (default anthropic claude-haiku-5-5) using only the swarm tool and pi's
// built-in tools. Each scenario runs several times; results are pass rates with a spread, not a 100% gate.
import crypto from "node:crypto";

const word = () => crypto.randomBytes(3).toString("hex");

export const agents = {
  // A scripted client asks an LLM agent something only that agent's folder can answer. (The file isn't called
  // "secret": a refusal to share secrets is correct behavior, and this scenario measures communication.)
  async ask_answer(h, ctx) {
    const build = `build-${word()}`;
    const ops = await h.mint("ops-a1");
    ctx.agent(h.startPi("llm-a1", { brain: "llm", env: h.swarmEnv(await h.mint("llm-a1")), files: { "status.txt": `last green ${build}\n` } }));
    await h.online("llm-a1");
    const t = Date.now();
    const r = await ops.client.ask("llm-a1", "Quick one from your teammate: which build does status.txt in your working folder say was last green? Reply with just the build id.", { timeoutSec: 120 });
    return { pass: !!r.reply?.text.includes(build), detail: r.reply ? `reply: ${JSON.stringify(r.reply.text.slice(0, 80))}` : "no reply", latencies: r.reply ? [Date.now() - t] : [] };
  },

  // Two LLM agents must combine files that each can only see in its own folder.
  async coop_files(h, ctx) {
    const [x, y] = [word(), word()];
    const a = await h.mint("llm-a2");
    const b = await h.mint("llm-b2");
    const pa = ctx.agent(h.startPi("llm-a2", { brain: "llm", env: h.swarmEnv(a), files: { "part1.txt": `${x}\n` } }));
    const pb = ctx.agent(h.startPi("llm-b2", { brain: "llm", env: h.swarmEnv(b), files: { "part2.txt": `${y}\n` } }));
    await h.online("llm-a2");
    await h.online("llm-b2");
    pb.prompt("You are llm-b2, on a team with llm-a2. Teammates may message you through the swarm tool about files in your folder; help them. Nothing to do right now.");
    await h.waitFor(() => pb.idle && pb.tokens > 0, 60_000, "llm-b2 briefed");
    pa.prompt("Your teammate is the agent llm-b2 (use the swarm tool). It has part2.txt in its folder; you have part1.txt in yours. " +
      `Write answer.txt in your folder (${pa.dir}) containing the contents of part1.txt, a space, then the contents of part2.txt, on one line. Ask llm-b2 for its part.`);
    const answer = await h.waitFor(() => pa.read("answer.txt"), 150_000, "answer.txt").catch(() => null);
    return { pass: answer === `${x} ${y}`, detail: `answer.txt=${JSON.stringify(answer)} expected ${JSON.stringify(`${x} ${y}`)}` };
  },

  // An LLM worker about to start a task someone else already holds should notice the marker and coordinate.
  async collision_stand_down(h, ctx) {
    const holder = await h.mint("holder-a3");
    await holder.client.presence({ marker: "on: TASK-42 fix login bug", markerTtlSec: 900, status: "working" });
    const pb = ctx.agent(h.startPi("llm-a3", { brain: "llm", env: h.swarmEnv(await h.mint("llm-a3")) }));
    await h.online("llm-a3");
    pb.prompt("You are about to start TASK-42 (fix login bug). Team rule: before starting, set your swarm marker for the task and look at the overlaps it reports. " +
      `If another agent already holds the task, don't start: send that agent a short note offering help, and write STOOD_DOWN to ${pb.dir}/status.txt. Otherwise write STARTED to that file.`);
    // The holder is a scripted teammate: it answers whatever the newcomer sends, so an `ask` doesn't hang.
    let note = null;
    let stop = false;
    const holderLoop = (async () => {
      while (!stop) {
        const res = await holder.client.inbox({ waitSec: 5 }).catch(() => ({ messages: [] }));
        for (const m of res.messages) {
          if (m.from.id === "llm-a3") note ??= m;
          await holder.client.reply(m.id, "Thanks, I've got TASK-42 covered. No need to start it.").catch(() => {});
        }
        if (res.messages.length) await holder.client.ack(res.cursor).catch(() => {});
      }
    })();
    const status = await h.waitFor(() => pb.read("status.txt"), 120_000, "status.txt").catch(() => null);
    stop = true;
    await holderLoop;
    return { pass: status === "STOOD_DOWN" && !!note, detail: `status.txt=${JSON.stringify(status)}; note to holder: ${note ? JSON.stringify(note.text.slice(0, 80)) : "none"}` };
  },

  // A lead hands off a task while the heir isn't running; the heir starts later, does it and reports back.
  async offline_handoff(h, ctx) {
    const token = `plum-${word()}`;
    const lead = await h.mint("lead-a4");
    const heir = await h.mint("llm-a4");
    await lead.client.send("llm-a4", `Handoff from your lead: please create handoff.txt in your working folder containing exactly ${token}, then reply "done".`, { expects: "reply" });
    const pi = ctx.agent(h.startPi("llm-a4", { brain: "llm", env: h.swarmEnv(heir) }));
    const reply = await h.waitFor(async () => (await lead.client.inbox()).messages.find((m) => m.kind === "reply") ?? null, 150_000, "reply").catch(() => null);
    const file = pi.read("handoff.txt");
    return { pass: file === token && !!reply, detail: `handoff.txt=${JSON.stringify(file)}; reply: ${reply ? JSON.stringify(reply.text.slice(0, 60)) : "none"}` };
  },
};
