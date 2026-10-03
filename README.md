# Widem Agent Desk

One brain, two doors. A service desk for a client-services business that answers customers in Arabic and English, prices their order correctly and books them, whether the customer types to it directly or sends their own AI agent.

- **The human door:** a chat on the business's site. (The chat endpoint is built; the page is not yet.)
- **The agent door:** a remote MCP server that Claude, ChatGPT or any MCP client can connect to.

Both doors call the same core, so a person and an agent asking for the same thing get the same quote.

> **Demo business, fictional.** The business in `data/demo-business.json` (Darb Career Studio) is invented for this demo. Its name, services and prices are made up, and no real person or company appears in this repository.

## Status

Built so far: the core (prices, free slots, bookings and handover to a person), the agent door with all five tools, and the chat endpoint for people (POST /chat, Nemotron calling the same tools). The chat page and the owner page come next.

| Tool | What it does |
|---|---|
| `list_services` | Services in English and Arabic, the price per tier (junior, mid, senior, executive) in SAR, bundles and add-ons. |
| `quote` | Prices an order: `{ services, tier, addons? }`. Applies the bundle discount and add-ons, and refuses anything outside the rules with a reason code instead of guessing a price. |
| `check_availability` | Free 60-minute kickoff-call slots in Riyadh time (UTC+3): `{ from?, days? }`. Leaves out closed days, blocked dates, past slots and booked slots. |
| `book` | Books one customer into a free slot: `{ services, tier, addons?, slot, customer_name, contact }`. Prices the order again with the same rules, refuses a slot that is taken, and returns a booking reference. |
| `handover` | Passes the customer to a person: `{ reason, summary?, customer_name?, contact? }`. Returns what to tell the customer, in English and Arabic. |

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
npm start       # agent door on http://127.0.0.1:8790/mcp
node --env-file=.env src/mcp-server.mjs   # both doors: /mcp, and the chat at /chat
```

`PORT` and `HOST` change where it listens. Bookings and handovers are kept in `var/desk-store.json` (not committed); `DESK_STORE` points it at another file. The chat door (`POST /chat` with JSON `{ "message": "..." }`; the first reply carries a `sessionId` issued by the server, which later messages send back; answers `{ sessionId, reply, booked?, handover? }`; per-IP and global limits answer 429, set in `CHAT_LIMITS` in `src/mcp-server.mjs`) needs a Nebius Token Factory key: copy `.env.example` to `.env` and set `NEBIUS_API_KEY` and `NEBIUS_BASE_URL`. Without them the server still runs and `/chat` answers 503. Every SAR amount and time in a chat reply is checked against what the desk tools returned; a reply that states one they did not is re-asked once, then handed to a person. `node --env-file=.env smoke/chat-live-http.mjs` runs one Arabic conversation through the real model on a memory store.

To try the agent door by hand, run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP and connect to `http://127.0.0.1:8790/mcp`.

## Layout

```
data/demo-business.json   the fictional business: services, tiers, prices, bundle and add-on rules
src/core.mjs              the one brain, pricing: pure, deterministic listServices() and quote()
src/desk.mjs              the one brain, state: checkAvailability(), book(), handover()
src/store.mjs             storage behind all(kind) and add(kind, record): memory or one JSON file
src/tools.mjs             the five tools, defined once; both doors build their tool lists from here
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
