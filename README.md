# Widem Agent Desk

One brain, two doors. A service desk for a client-services business: it answers a customer's questions, prices their order and books a kickoff call. A person can type to it on a chat page, or a person's own AI agent can call it as an MCP server. Both doors call the same desk code with the same tool definitions, so the same order gets the same quote on both, and a model never decides a price, a tier or a free slot.

> **Demo business, fictional.** The business in `data/demo-business.json` (Darb Career Studio) is invented for this demo. Its name, services and prices are made up, and no real person or company appears in this repository.

## For judges: try it

The desk is live at **https://desk.n8nwidem.uk**.

- **Human door (chat page):** open https://desk.n8nwidem.uk in a browser and ask, for example, "What does a CV rewrite cost with 6 years of experience?" Then pick a time and book. Booking holds the slot until a simulated payment: the pay button charges nothing and asks for no card details.
- **Agent door (MCP):** the endpoint is `https://desk.n8nwidem.uk/mcp` (Streamable HTTP, no sign-in). In Claude, add it as a remote custom connector: Settings, Connectors, Add custom connector, paste the URL. Then ask Claude to quote and book the same order and compare the total with the chat page. Any other MCP client works the same way, for example the MCP Inspector (`npx @modelcontextprotocol/inspector`) pointed at that URL.

## NVIDIA and Nebius

- **Model:** NVIDIA Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`, the default in `src/chat.mjs`) on Nebius Token Factory, with tool calling, temperature 0. The server can name another Token Factory model with `DESK_MODEL` without a code change; the startup log prints the model in use. Until 2026-10-16 the default was Nemotron 3 Super 120B (`nvidia/nemotron-3-super-120b-a12b`); we moved because NVIDIA's API catalog lists that model as deprecated on 2026-10-19, and the judged demo must not depend on it. Models tested through the desk's own chat path on 2026-10-16: one quote request each ("How much is a CV rewrite with 6 years of experience?"): `nvidia/Nemotron-3.5-Super-VL` answered 550 SAR after calling `list_services`, `quote` and `check_availability` (4.4 s) and moved to booking; `nvidia/Nemotron-3_5-Lightning` answered 550 SAR after `list_services` and `quote` (1.3 s) but offered add-ons instead of booking. Super VL then passed all 11 cases of the adversarial set (`scripts/live-adversarial.mjs`: injection, fake authority, system prompt, other customers' data, invented price, outside hours, spam, off-topic, card in chat, mixed language, fake tool output) in one run: 25 model calls, about 103,000 input and 9,900 output tokens, 36 s in total.
- **Nebius Token Factory** serves that model through its OpenAI-compatible API. It runs only the human door's conversation: choosing which tool to call and wording the reply. Prices, tiers, slots and bookings come from the desk code, and a guard (`src/guard.mjs`) blocks any reply that states an amount or a time the tools did not return. The agent door needs no model at all.
- **Other Nebius services:** none. The server runs on our own VPS behind a Cloudflare tunnel.

## Limits on the public demo

- Agent door: 60 requests per address per 10 minutes, 300 per minute from everyone together, 10 new connections per address per 10 minutes.
- Chat door: 20 messages per address per 10 minutes, 60 per minute together, 5 new chats per address per 10 minutes.
- At most 3 active bookings per caller, so one script cannot empty the calendar.
- A total cap on stored records (bookings and handovers; default 1000, `DESK_MAX_RECORDS`) and a daily cap on model calls (Riyadh day; default 150, `DESK_MODEL_CALLS_PER_DAY`), so the Token Factory credit lasts through judging. When the daily cap is reached the chat says so and the agent door keeps working.

## How we test it

- **Two doors, one answer:** `test/two-doors.test.mjs` sends the same five customer profiles through the chat door (scripted model, no network) and through the agent door (a real MCP client over HTTP), and asserts the identical quote and the identical stored booking; only the door and the transcript may differ.
- **Adversarial set:** `scripts/live-adversarial.mjs` runs 11 hostile prompts (invented prices, hidden instructions, discount pressure and similar) twice on the real model and checks every reply with code; each checker is self-tested on a hand-written good and bad reply first.
- **`npm run check`** runs every gate, including the unit tests, a secret scan of the files and the git history, and a check that this README names every agent-door tool. `npm run check -- --plant` also plants one deliberate break per guard and fails unless each break turns its gate red. `npm run check -- --live` adds the adversarial set and spends a few cents of Token Factory credit.

## Run it locally

Node 22 or later.

```
npm install
npm test                 # unit tests, no network
npm run check            # every gate
npm start                # http://127.0.0.1:8790 (chat page at /, agent door at /mcp)
```

Without `NEBIUS_API_KEY` and `NEBIUS_BASE_URL` (in a gitignored `.env`, read with `node --env-file=.env src/mcp-server.mjs`) the agent door works fully and `/chat` answers 503. Details below.

## Status

Built so far: the core (prices, free slots, bookings and handover to a person), the agent door (MCP, six tools), the chat endpoint for people (POST /chat, Nemotron calling the same tools) and the chat page at `/` (English). The owner page is built (read only). The desk is hosted at https://desk.n8nwidem.uk.

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
npm run check -- --live    # adds the adversarial set (11 prompts, 2 runs) on the real model; spends a few cents of Token Factory credit
npm start       # agent door on http://127.0.0.1:8790/mcp
node --env-file=.env src/mcp-server.mjs   # both doors: /mcp, and the chat at /chat
```

`PORT` and `HOST` change where it listens. Bookings and handovers are kept in `var/desk-store.json` (not committed); `DESK_STORE` points it at another file. Two caps protect a public demo. `DESK_MAX_RECORDS` (default 1000) is the most bookings and handovers kept in total; once reached, a new booking or handover is refused and the customer is told the desk cannot take more requests right now, nothing stored is deleted and the owner page still works. `DESK_MODEL_CALLS_PER_DAY` (default 150) is the most model calls a Riyadh day across everyone; once spent, `/chat` answers 503 `daily_limit` with "The demo is resting until tomorrow (Riyadh time)" and calls no model. The count is kept in `var/model-calls.json` next to the store (`DESK_MODEL_CALLS_FILE` to move it), so a restart does not refill the day. A value that is not a whole number above 0 falls back to the default. `DESK_MODEL` names the Token Factory model the chat door calls (default `nvidia/Nemotron-3.5-Super-VL`; unset or blank keeps the default). The chat door (`POST /chat` with JSON `{ "message": "..." }`; the first reply carries a `sessionId` issued by the server, which later messages send back; answers `{ sessionId, reply, booked?, handover? }`; per-IP and global limits answer 429, set in `CHAT_LIMITS` in `src/mcp-server.mjs`) needs a Nebius Token Factory key: copy `.env.example` to `.env` and set `NEBIUS_API_KEY` and `NEBIUS_BASE_URL`. Without them the server still runs and `/chat` answers 503. Every SAR amount and time in a chat reply is checked against what the desk tools returned; a reply that states one they did not is re-asked once, then handed to a person. `node --env-file=.env smoke/chat-live-http.mjs` runs one Arabic conversation through the real model on a memory store.

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
