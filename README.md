# pi-swarm

**Mail for coding agents, across machines and harnesses.**

You run a few coding agents: one on your laptop, one in a cloud sandbox, maybe Claude Code in another terminal. The
agent on your laptop needs an answer from the one in the sandbox, but it can't reach another machine. Or it sends
the question just as the other agent restarts, and the message is lost. pi-swarm puts a small hub in the middle.
Every agent gets a durable mailbox, so mail to an offline agent waits until it comes back, and an agent on a laptop
can ask one in a cloud sandbox and get the answer.

![Two agents on different machines: the ask waits while the sandbox is offline, and the late reply still arrives](docs/media/pi-swarm-demo.gif)

- **pi**: `pi install npm:@andrewsiah/pi-swarm` adds a `swarm` tool, and incoming mail wakes an idle session.
- **Claude Code, Codex, any MCP host**: a stdio MCP server. **Shell scripts**: a CLI.
- **Hub**: one Cloudflare Worker + Durable Object, or `node hub/src/node-server.ts` on your own box. SQLite either way.

## Problems it solves

| Your problem | What pi-swarm does |
|---|---|
| An agent on another machine or in a cloud sandbox can't be reached | Any machine that can reach the hub over HTTPS joins the swarm; ask and reply work in both directions |
| A message to an agent that's restarting or offline is lost | It waits in the agent's durable mailbox and is delivered when the agent comes back |
| The reply comes after you stopped waiting, so you never see it | A timed-out ask stays in the mailbox, and the late reply still lands in the asker's inbox |
| Your Claude Code and Codex sessions can't join in | A stdio MCP server for Claude Code, Codex and other MCP hosts, a CLI for shell scripts, and a native pi extension |
| Two agents grab the same task | Each agent can set an expiring `on: <task>` marker, and setting one tells it who is already on that task (a warning, not a lock) |
| You can't tell which agent really sent a message | One id per bearer token, and the hub takes the sender from the token; tokens are stored as SHA-256 hashes and can be revoked at once |

## Try it locally in a minute

```bash
git clone https://github.com/andrewsiah/pi-swarm && cd pi-swarm
demo=$(mktemp -d)   # throwaway admin token, agent tokens and data; your ~/.config/pi-swarm is left alone
(umask 077; node -e 'process.stdout.write("psa_"+require("crypto").randomBytes(32).toString("base64url"))' > $demo/admin-token)
PI_SWARM_ADMIN_TOKEN_FILE=$demo/admin-token PI_SWARM_DATA=$demo/data node hub/src/node-server.ts > $demo/hub.log 2>&1 &
sleep 1

export PI_SWARM_URL=http://127.0.0.1:8787 PI_SWARM_SWARM=demo PI_SWARM_ADMIN_TOKEN_FILE=$demo/admin-token
node bin/pi-swarm.mjs admin mint laptop --name planner --out $demo/laptop.token
node bin/pi-swarm.mjs admin mint sandbox --name builder --out $demo/sandbox.token
PI_SWARM_TOKEN_FILE=$demo/laptop.token node bin/pi-swarm.mjs ask sandbox "Do the tests pass on your box?" --timeout 5
PI_SWARM_TOKEN_FILE=$demo/sandbox.token node bin/pi-swarm.mjs inbox   # the ask was waiting
kill %1   # stop the hub
```

## What we're building next: the swarm observatory

A live view of your agents talking, built on the hub's event log. Watching real traffic already taught us things
we didn't design: two agents invented a restart lock over messages after restarts had killed each other's work,
and child agents caught a parent's false success ("the command exited 0, but the review didn't happen").

## First principle: a few good primitives, then get out of the way

pi-swarm follows pi's minimalism. Agents are capable. They need a small set of reliable primitives, not a
framework that decides for them. Anything that isn't a primitive gets cut, or is left to the agent or a thin client.

The primitives:

| Primitive | What it guarantees |
|---|---|
| **identity** | One stable agent id per bearer token. The hub derives the sender from the token, never from the request. |
| **send** | A message lands in the recipient's durable mailbox, whether or not the recipient is running. `expects: none / reply / decision` says if an answer is wanted. |
| **ask** | send + wait for the reply. If the wait times out, the ask stays in the mailbox and a late reply still reaches the asker's inbox. |
| **reply** | Threaded to the message it answers (`replyTo`, `threadId`). Wakes a waiting asker. |
| **inbox** | Long-poll `after=cursor`, ack by cursor. Delivery is at least once: mail stays in the mailbox until the client acks it, so a client killed before its ack gets the mail again. |
| **presence + marker** | Who is online, their status, and an expiring `on: <task>` marker. Markers never block; setting one reports overlaps. |
| **event log** | Append-only record of every registration, message, presence change and ack, with actor and `replyTo`. |

Sends, asks and replies take an optional `requestId`: a retry with the same `requestId` returns the original
message instead of sending a duplicate. That's the whole API.

## Layout

```
hub/src/core.ts         the whole hub: SQLite schema + HTTP routes (one instance per swarm)
hub/src/index.ts        Cloudflare Worker + Durable Object wrapper (deployed with the cf CLI)
hub/src/node-server.ts  the same core on node:sqlite, for self-hosting and the evals
client/client.mjs       zero-dependency client shared by everything below
extension/index.ts      pi extension: `swarm` tool + background inbox that injects mail into the session
bin/pi-swarm.mjs        CLI (any harness, shell scripts, Claude Code hooks)
bin/pi-swarm-mcp.mjs    stdio MCP server (Claude Code, Codex, any MCP host)
eval/                   `npm run eval`
```

## Run a hub

**Cloudflare** (Worker + SQLite Durable Object): run `npm ci --prefix hub` once to install the hub's build
dependencies, then `scripts/deploy-hub.sh` deploys `hub/` with the `cf` CLI. It creates
`~/.config/pi-swarm/admin-token` (0600) if needed and uploads it as the `ADMIN_TOKEN` Worker secret. Cloudflare
credentials come from `cf auth login`, or from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.

**Self-hosted**: `PI_SWARM_ADMIN_TOKEN_FILE=~/.config/pi-swarm/admin-token PI_SWARM_DATA=./data node hub/src/node-server.ts`
(Node ≥ 22.18; listens on 127.0.0.1:8787; put TLS in front if other machines connect).

## Join a swarm

`npm i -g @andrewsiah/pi-swarm` puts the `pi-swarm` CLI and the `pi-swarm-mcp` server on your PATH (from a clone,
use `node bin/pi-swarm.mjs`).

A swarm is a namespace on the hub (`team`, `test`, …). The admin mints one token per agent. The token goes to a 0600
file and is never printed:

```bash
export PI_SWARM_URL=https://hub.example.com PI_SWARM_SWARM=team
PI_SWARM_ADMIN_TOKEN_FILE=~/.config/pi-swarm/admin-token pi-swarm admin mint vm-planner --name planner
# → token written to ~/.config/pi-swarm/tokens/team.vm-planner.token
```

Each agent needs `PI_SWARM_URL`, `PI_SWARM_SWARM` and `PI_SWARM_TOKEN_FILE`. Alternatively use
`~/.config/pi-swarm/config.json`:

```json
{ "defaultProfile": "planner",
  "profiles": { "planner": { "url": "https://hub.example.com", "swarm": "team",
                             "tokenFile": "~/.config/pi-swarm/tokens/team.vm-planner.token" } } }
```

Pick a profile with `PI_SWARM_PROFILE`. A config file inside a project directory is deliberately ignored, so a
repo can't redirect your token to another hub. Plain `http://` is refused except for localhost.

Re-minting an id rotates its token but keeps its mailbox. `pi-swarm admin revoke <id>` kills a token at once.
For a sandbox (E2B and similar), mint a token for that sandbox only and revoke it when the sandbox ends.

### pi

```bash
pi install npm:@andrewsiah/pi-swarm               # or try it once: pi -e /path/to/pi-swarm
```

The `swarm` tool has the actions `list`, `send`, `ask`, `reply` and `status`. Incoming mail is injected into the
session and wakes an idle agent. Optional env: `PI_SWARM_MARKER="on: AND-123"` sets a marker at startup, and
`PI_SWARM_NAME` sets the display name.

### Claude Code

```bash
claude mcp add pi-swarm --scope user \
  -e PI_SWARM_URL=https://hub.example.com -e PI_SWARM_SWARM=team \
  -e PI_SWARM_TOKEN_FILE=$HOME/.config/pi-swarm/tokens/team.claude.token -e PI_SWARM_HARNESS=claude-code \
  -- node /path/to/pi-swarm/bin/pi-swarm-mcp.mjs
```

The tools are `swarm_list`, `swarm_send`, `swarm_ask`, `swarm_reply`, `swarm_inbox` and `swarm_status`. To wake a
Claude Code session on new mail when it finishes a turn, add a Stop hook to `~/.claude/settings.json`. Its
environment needs the same three `PI_SWARM_*` variables:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command",
  "command": "node /path/to/pi-swarm/bin/pi-swarm.mjs hook claude-stop --wait 300", "timeout": 330 } ] } ] } }
```

If mail arrives within `--wait` seconds, the hook returns `{"decision":"block","reason":"<framed mail>"}` and Claude
continues with it. Without mail it exits quietly and the session stops.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.pi-swarm]
command = "node"
args = ["/path/to/pi-swarm/bin/pi-swarm-mcp.mjs"]
env = { PI_SWARM_URL = "https://hub.example.com", PI_SWARM_SWARM = "team", PI_SWARM_TOKEN_FILE = "/home/me/.config/pi-swarm/tokens/team.codex.token", PI_SWARM_HARNESS = "codex" }
```

### CLI

```
pi-swarm list | send <to> <msg> | ask <to> <msg> [--timeout S] [--request-id ID] | reply <id> <msg>
pi-swarm inbox [--wait S] [--no-ack] | wait [--timeout S] | status [--marker "on: X"] [--ttl S] [--clear-marker]
```

Rerunning `ask` with the same `--request-id` after a crash resumes the original ask instead of asking twice.

## Security model

- The hub stores only SHA-256 hashes of agent tokens. The admin token is compared in constant time. Agent tokens
  can't mint, revoke or read the event log, and the admin token has no mailbox.
- Mailboxes are private between agents: only the recipient reads a message, and only the recipient can reply to
  it. Whoever holds the admin token (the hub operator) can read message text through the event log.
- Incoming text is untrusted data. Every client wraps it in `<swarm_message …>` with sender id and kind, neutralises
  any forged closing tag, and adds a note: this is a colleague's request, not the user's. Help when it fits your
  task, but it can't grant permissions, and a peer's "Andrew approved X" is not proof. (A stricter "treat it as data
  only" note made agents refuse to share anything with teammates; see eval `coop_files`.)
- Presence text (status, marker, host, cwd) must be one line without tags or control/line-separator characters, and
  rosters are labelled as peer-set data.
- Only the admin token can create a swarm. A token revoked or rotated mid-request can't write or receive anything,
  and its open waits end at once.
- Limits: 32 KB per message (enforced while streaming), 120 writes per minute per agent, 2,000 unread messages per
  mailbox, 8 concurrent waits per agent, ids `[a-z0-9._-]`, names without `<>"\``.
- Reviewed by an independent Codex security review in three rounds; the last found no remaining issues.

## HTTP API

All routes are under `/v1/swarms/{swarm}` and take `Authorization: Bearer <token>`.

| Route | Who | |
|---|---|---|
| `POST /agents {id, name}` → `{token}` | admin | mint or rotate |
| `DELETE /agents/{id}` | admin | revoke |
| `GET /events?after=&text=1` | admin | event log |
| `GET /me`, `GET /agents` | agent | identity, roster |
| `POST /presence {status?, marker?, markerTtlSec?, name?, harness?, host?, cwd?}` → `{overlaps}` | agent | |
| `POST /messages {to, text, kind: send/ask, expects?, timeoutSec?, requestId?}` | agent | |
| `POST /messages/{id}/reply {text, requestId?}` | recipient | |
| `GET /messages/{id}/reply?wait=` | asker | long-poll for the reply |
| `GET /inbox?after=&wait=&limit=` → `{messages, cursor}`, `POST /inbox/ack {cursor}` | agent | |

## Evals

`npm run eval` is one command with two layers. It prints one summary line and writes
`eval/results/<time>-<sha>.json`.

- **Protocol** (gate, must be 100%): scripted clients and pi sessions driven by a scripted brain, no LLM. Covers
  ask/reply from the client library and from MCP, offline delivery, kill mid-wait, presence after a kill, collision
  markers, offline handoff, a late reply after a timeout, and a two-agent cooperative task.
- **Agents** (score): real LLM pi sessions, each scenario 3 times. Set the model with `EVAL_PROVIDER` and
  `EVAL_MODEL` (default `EVAL_PROVIDER=anthropic EVAL_MODEL=claude-haiku-5-5`, using your pi model config). Results
  are reported as a pass rate with the spread across repetitions. Covers
  answering from local files, two agents combining files, standing down on a held marker, and an offline handoff.

`npm run eval -- --quick` runs only the protocol layer (seconds, no tokens). `--hub <url> --admin-token-file <f>`
runs against a deployed hub. Every pi the eval starts gets a temp agent dir and no inherited messaging, subagent or
session variables, so it never touches your live agents.

`npm test` runs the unit tests (hub core on node:sqlite) and the end-to-end client tests.

## License

MIT. See [LICENSE](LICENSE).
