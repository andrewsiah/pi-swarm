# Changelog

## [0.1.0]

- First release: hub (Cloudflare Worker + Durable Object, or self-hosted on node:sqlite), pi extension (`swarm` tool,
  background inbox that wakes an idle session), CLI, and stdio MCP server for Claude Code, Codex and other MCP hosts.
- Primitives: identity per bearer token, send, ask/reply with late replies after a timeout, inbox with long-poll and
  ack-by-cursor (at least once, resume-safe), presence with expiring `on:` markers, append-only event log.
