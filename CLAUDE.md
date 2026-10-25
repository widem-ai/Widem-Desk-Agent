# Widem Desk Agent — rules for any agent working in this repo

A competition entry (hackathon) and a live demo: a booking desk with two doors, a chat page for people and an
MCP endpoint for AI agents, both calling the same deterministic desk. It runs on a shared production server,
behind a Cloudflare tunnel at https://desk.n8nwidem.uk. **This repo is public: write nothing here (code,
comments, docs, commit messages) that names a client or describes the server beyond ARCHITECTURE.md.**

**Read `ARCHITECTURE.md` before changing anything.** It names the modules and what each never does, the trust
boundaries, the caps, and the five things that must never break. If a change would break one, stop and say so.

## Never, without Mohannad's explicit yes in this conversation
- **No deploys, no SSH, no server changes.** The server carries other production services; a bad restart takes
  them down too. Mohannad ships.
- **No push, no merge into `main`.** Commit on your worktree's branch; Mohannad reviews and pushes. The repo is
  public (GitHub `widem-ai/Widem-Desk-Agent`), so everything committed is published.
- **No secrets anywhere but `.env`** (gitignored): `NEBIUS_API_KEY`, `OWNER_TOKEN`. Never print, log or commit
  them; never copy `.env` into a worktree unless a task needs the real model.
- **No live-model runs** (`npm run check -- --live`) without asking: they spend the day's model budget.
- No new dependency.

## How to work
- **One worktree = one task = its own files.**
- **Prices, tiers, slots and handover rules live in the desk** (`src/core.mjs`, `src/desk.mjs`,
  `data/demo-business.json`), never in a prompt or a model reply. The data is a fictional business: no real
  client data or prices, ever.
- **Tests before reporting:** `npm test` (Node test runner, `test/*.test.mjs`), then `npm run check` (every gate,
  including the secret scan over the tree and history). `npm run check -- --plant` proves each guard bites.
- If you start the server locally, give it a port no other worktree uses and stop it when you finish.

## Reporting back
Lead with what failed or wasn't checked, then what passed (command + result), then the commit hash and branch.
