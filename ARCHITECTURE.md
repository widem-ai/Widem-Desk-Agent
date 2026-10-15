# Architecture

The intent the code cannot show: what the parts are, who owns what, where the trust boundaries are, and what must never break. Read this before changing anything. If a change would break a rule here, stop and raise it first.

## One desk, two doors

```
customer on the page ──> /  (chat page)  ──> POST /chat  ──> src/chat.mjs (Nemotron loop) ──┐
customer's AI agent ──────────────────────> POST /mcp   ──> MCP tools                    ──┼──> src/desk.mjs + src/core.mjs ──> store
owner ────────────────────────────────────> /owner      ──> src/owner.mjs (read only)    ──┘
```

Both doors call the same desk through the same tool definitions, so a person and an agent asking for the same thing get the same quote and the same booking (only the recorded door and the transcript differ). The desk, never a model, works out the tier, the price, the free slots and whether a request goes to a person.

## Who owns what

| Module | Owns | Never does |
|---|---|---|
| `data/demo-business.json` | The fictional business: services, tiers, prices, bundles, add-ons, opening hours, hold time, handover reasons, fit rules | Real client data or prices |
| `src/core.mjs` | Pricing: `listServices()`, `quote()`, `tierFor()`. Pure and deterministic | State, I/O |
| `src/desk.mjs` | State: free slots, `book()` (held until paid), `pay()`, `handover()`, the per-caller booking cap, `ownerView()` | Talk to a model or the network |
| `src/tools.mjs` | The tool definitions, once; which door gets which tool (`pay` agent only, `ask_choice` chat only) | Logic beyond calling the desk |
| `src/chat.mjs` | The human door's model loop and every reply post-step (labels, confirmation line, handover line) | Decide a price, tier or slot |
| `src/guard.mjs` | The check that no reply states an amount or time the tools did not return | |
| `src/mcp-server.mjs` | HTTP: `/`, `/chat`, `/chat/pay`, `/mcp`, `/owner`; sessions, rate limits, client IP | Business rules |
| `src/owner.mjs` | The owner page: token check, failure limits, escaping, rendering | Write anything |
| `src/store.mjs` | Storage behind `all(kind)`, `add`, `update`: memory or one JSON file | |
| `scripts/check.mjs` | `npm run check`: every gate; `--plant` breaks each guard on purpose; `--live` runs the adversarial set on the real model | |

## Trust boundaries

- **Network.** In production the server listens on `127.0.0.1` only and is reached through the Cloudflare tunnel. With `TRUST_PROXY=cloudflare` the client IP comes from `CF-Connecting-IP`; without it that header is ignored, so a direct caller cannot pick their own IP. Never set `TRUST_PROXY=cloudflare` on a server whose port is open to the internet.
- **Customer text is untrusted**, on both doors: chat messages, MCP tool arguments, names, contacts. Tool arguments are type-checked before they reach the desk (`checkArgs` and the MCP schemas). Instructions inside a customer message are not followed; anything outside the rules goes to a person. Customer text is escaped wherever it is shown (`esc()` on the owner page) and never written to a log.
- **The owner token** (`OWNER_TOKEN`, 32+ characters) is the only way into `/owner`: header or form post, never the URL; constant-time compare; failures limited per address (IPv6 by /64) and globally. Mohannad sets it on the server; no agent ever sees it.
- **The model key** (`NEBIUS_API_KEY`) lives only in `.env` (gitignored) and is read through `node --env-file=.env`. It is never printed or logged.

## Data

| What | Where | Survives a restart |
|---|---|---|
| Bookings and handovers (with transcripts, contacts, prices) | `var/desk-store.json` (`DESK_STORE` to move it), written atomically (temp file + rename) | Yes |
| Chat sessions and their history (capped at 40 messages) | Memory | No: a customer starts a new chat |
| Today's model-call count (Riyadh day) | `var/model-calls.json` next to the store (`DESK_MODEL_CALLS_FILE` to move it), written atomically | Yes: a restart does not refill the day |
| Rate-limit buckets, the per-caller booking list, owner sign-in failures | Memory | No: a restart resets them (slots already taken stay taken) |

**Caps.** The store takes at most `DESK_MAX_RECORDS` (default 1000) bookings and handovers in total: past it `add()` throws `store_full`, the desk refuses `book` and `handover` cleanly and the customer is told the desk cannot take more requests right now. Nothing stored is ever deleted to make room, and the owner page keeps reading. At about 22 KB for the largest handover, 1000 records keep the file that is rewritten on every write near 20 MB at worst.

Unpaid bookings free their slot after `payment.hold_minutes` (30); expiry is checked when slots are read, the record stays.

## The model

Nemotron 3 Super 120B (`nvidia/nemotron-3-super-120b-a12b`, the default; `DESK_MODEL` on the server names another model, shown in the startup log) on Nebius Token Factory, OpenAI-compatible chat completions with tool calling, temperature 0, 20-second timeout. Without `NEBIUS_API_KEY` and `NEBIUS_BASE_URL` the server still runs: the agent door works fully (it needs no model) and `/chat` answers 503. The agent door spends no model credit, so it keeps working when the chat door rests. The chat door's rate limits bound the speed; `DESK_MODEL_CALLS_PER_DAY` (default 150, `src/model-budget.mjs`) bounds the total: every call is counted before it is sent, and once the Riyadh day's calls are spent `/chat` answers the resting line (503 `daily_limit`) without calling the model, including a turn that reaches the cap halfway.

## What must never break

1. **No invented price or time reaches a customer.** Prices and slots come only from tool results; the guard re-asks once, then hands over.
2. **Both doors agree.** Same input, same quote, same booking fields (`test/two-doors.test.mjs`).
3. **The limits and the caps hold.** `/mcp` and `/chat` rate limits, the total record cap, the daily model-call cap, one message per MCP request (no batches), at most 3 bookings held per address on both doors.
4. **No secrets in logs or in git.** No key, token, contact or customer text in any log line; `npm run check` scans the tree and all history.
5. **The owner page is off without a strong token.** No `OWNER_TOKEN`, or one under 32 characters, means 404.

Each of these has a test, and `npm run check -- --plant` breaks each one on purpose to prove the test catches it.

## Hosting

Target: `widem-vps-1` (OVH, already paid), behind the existing Cloudflare tunnel, with `HOST=127.0.0.1`, `TRUST_PROXY=cloudflare`, `OWNER_TOKEN` and the Token Factory key set on the server. The devops engineer is preparing it; nothing is deployed yet.
