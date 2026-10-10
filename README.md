# Widem Agent Desk

One brain, two doors. A service desk for a client-services business that answers customers in Arabic and English, prices their order correctly and books them, whether the customer types to it directly or sends their own AI agent.

- **The human door:** a chat page on the business's site (`/`), backed by `POST /chat`.
- **The agent door:** a remote MCP server that Claude, ChatGPT or any MCP client can connect to.

Both doors call the same core, so a person and an agent asking for the same thing get the same quote.

> **Demo business, fictional.** The business in `data/demo-business.json` (Darb Career Studio) is invented for this demo. Its name, services and prices are made up, and no real person or company appears in this repository.

## Status

Built so far: the core (prices, free slots, bookings and handover to a person), the agent door (MCP, six tools), the chat endpoint for people (POST /chat, Nemotron calling the same tools) and the chat page at `/` (English). The owner page is built (slice 1: read only). Public hosting comes next.

The tools are defined once in `src/tools.mjs`. Five are shared by both doors; `pay` is on the agent door only (people pay with the button on the chat page), and `ask_choice` is on the chat door only (it shows answer buttons to a person).

| Tool | Door | What it does |
|---|---|---|
| `list_services` | both | Services in English and Arabic, the price per tier (junior, mid, senior, executive) in SAR, bundles and add-ons. |
| `quote` | both | Prices an order: `{ services, years_experience, is_executive?, addons? }`. The desk works out the tier from the years and the executive flag; the caller never picks a tier. Applies the bundle discount and add-ons, and refuses anything outside the rules with a reason code instead of guessing a price. |
| `check_availability` | both | Free 60-minute kickoff-call slots in Riyadh time (UTC+3): `{ from?, days? }`. Leaves out closed days, blocked dates, past slots and booked slots. |
| `book` | both | Books one customer into a free slot: `{ services, years_experience, is_executive?, addons?, slot, customer_name, contact }`. Prices the order again with the same rules, refuses a slot that is taken, and returns a booking reference. The booking is held until it is paid. |
| `handover` | both | Passes the customer to a person: `{ reason, summary?, customer_name?, contact? }`. Returns what to tell the customer, in English and Arabic. |
| `pay` | agent | Demo payment for a held booking: `{ reference, contact }`. Simulated: no card details, nothing is charged. |
| `ask_choice` | chat | Shows the person answer buttons for one question: `{ topic }` (goal, timeline, years, declined). |

**Decisions for this slice** (easy to reverse):
- A request the rules cannot price (unknown service, tier or add-on, or an add-on that cannot apply) is handed to a person automatically, in code, from `quote` and from `book`. Fixable mistakes (a missing name, a taken slot) are not.
- Prices are unchanged from slice 1.
- Opening hours, slot length, blocked dates and handover triggers live in `data/demo-business.json`. All of them are fictional: Sunday to Thursday, 10:00 to 13:00 and 14:00 to 18:00 Riyadh time, one-hour slots, bookable up to 21 days ahead.
- Storage is a file for now (no hosted database, zero cost). It is kept behind a two-method interface in `src/store.mjs`, so it can be swapped later.

## Run it

Needs Node.js 22 or newer.

```bash
npm install
npm test        # unit tests for the core, plus a real MCP client over HTTP
npm run check   # every gate: tests, secret scan (tree + git history), README tools; add -- --plant to break each guard on purpose
npm run check -- --plant   # release checklist: run this before every push
npm start       # agent door on http://127.0.0.1:8790/mcp
node --env-file=.env src/mcp-server.mjs   # both doors: /mcp, and the chat at /chat
```

`PORT` and `HOST` change where it listens. Bookings and handovers are kept in `var/desk-store.json` (not committed); `DESK_STORE` points it at another file. The chat door (`POST /chat` with JSON `{ "message": "..." }`; the first reply carries a `sessionId` issued by the server, which later messages send back; answers `{ sessionId, reply, booked?, handover? }`; per-IP and global limits answer 429, set in `CHAT_LIMITS` in `src/mcp-server.mjs`) needs a Nebius Token Factory key: copy `.env.example` to `.env` and set `NEBIUS_API_KEY` and `NEBIUS_BASE_URL`. Without them the server still runs and `/chat` answers 503. Every SAR amount and time in a chat reply is checked against what the desk tools returned; a reply that states one they did not is re-asked once, then handed to a person. `node --env-file=.env smoke/chat-live-http.mjs` runs one Arabic conversation through the real model on a memory store.

Abuse limits, before anything is public. All limits count per address (one IP), so people sharing an office connection share them:

- Agent door (`MCP_LIMITS` in `src/mcp-server.mjs`): 60 requests per address per 10 minutes, 300 per minute from everyone together, and 10 new connections (`initialize`) per address per 10 minutes. Over a limit it answers 429 with `retry-after`. One JSON-RPC message per request: a batch is refused with 400 (MCP dropped batching in 2025-06-18).
- Chat door (`CHAT_LIMITS`): 20 messages per address per 10 minutes, 60 per minute together, 5 new chats per address per 10 minutes.
- Bookings, on both doors: one address holds at most 3 bookings at once, held or paid (`MAX_ACTIVE_BOOKINGS_PER_CLIENT` in `src/desk.mjs`). The next one is refused and handed to a person, who replies about another time.

Unpaid bookings free their slot after 30 minutes. Behind the Cloudflare tunnel set `TRUST_PROXY=cloudflare` and keep `HOST=127.0.0.1`, so the client IP comes from `CF-Connecting-IP`; without the setting that header is ignored.

The owner page is at `/owner`: every booking from both doors (door, customer, contact, service, tier, price, slot, paid or held) and every handover with its reason, newest first, each with its conversation. It is off (404) unless `OWNER_TOKEN` is set on the server to at least 32 characters; a shorter token keeps it off, and the server log says so (it never prints the token or its length). Make one with `openssl rand -base64 36`, or in PowerShell: `$b = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)`. Sign in with the token in the form, or send it as `Authorization: Bearer <token>`; a token in the URL is ignored, because URLs end up in logs. Wrong tokens are limited per address (5 in 15 minutes; an IPv6 address counts by its /64) and across all addresses together (30 in 15 minutes, after which every sign-in, the right token included, gets 429 until the window passes, and the log says only "owner sign-in locked: too many failures"). Limits and the 10,000-address memory cap are `OWNER_LIMITS` in `src/owner.mjs`. The global lock also keeps the owner out: during a guessing attack the page can stay locked for up to 15 minutes (a restart clears it). Accepted for the demo. Times on the page are Riyadh time. The page is never cached, indexed or framed, and all customer text on it is escaped.

To try the agent door by hand, run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP and connect to `http://127.0.0.1:8790/mcp`.

## Layout

```
data/demo-business.json   the fictional business: services, tiers, prices, bundle and add-on rules
src/core.mjs              the one brain, pricing: pure, deterministic listServices() and quote()
src/desk.mjs              the one brain, state: checkAvailability(), book(), handover()
src/store.mjs             storage behind all(kind) and add(kind, record): memory or one JSON file
src/tools.mjs             the desk tools, defined once; each door builds its tool list from here
src/mcp-server.mjs        the HTTP server: the agent door at /mcp (MCP, Streamable HTTP) and the chat at /chat
src/chat.mjs              the human door brain: a Nemotron chat loop calling the same tools in-process
src/guard.mjs             the check that no reply states a price or time the desk tools did not return
test/                     core, availability and booking tests, the five scripted profiles, the MCP door test
smoke/                    the day-1 smoke test (model tool calling and a first MCP server)
```

## Built for

The Nebius x NVIDIA hackathon, by [Widem](https://github.com/widem-ai).

## License

MIT. See `LICENSE`.
