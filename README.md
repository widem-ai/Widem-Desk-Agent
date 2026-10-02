# Widem Agent Desk

One brain, two doors. A service desk for a client-services business that answers customers in Arabic and English, prices their order correctly and books them, whether the customer types to it directly or sends their own AI agent.

- **The human door:** a chat page on the business's site. (Planned, not built yet.)
- **The agent door:** a remote MCP server that Claude, ChatGPT or any MCP client can connect to.

Both doors call the same core, so a person and an agent asking for the same thing get the same quote.

> **Demo business, fictional.** The business in `data/demo-business.json` (Darb Career Studio) is invented for this demo. Its name, services and prices are made up, and no real person or company appears in this repository.

## Status

Built so far: the core (`listServices`, `quote`) and the agent door with two tools. Availability, booking, handover to a human, the chat page and the owner page come next.

| Tool | What it does |
|---|---|
| `list_services` | Services in English and Arabic, the price per tier (junior, mid, senior, executive) in SAR, bundles and add-ons. |
| `quote` | Prices an order: `{ services, tier, addons? }`. Applies the bundle discount and add-ons, and refuses anything outside the rules with a reason code instead of guessing a price. |

## Run it

Needs Node.js 22 or newer.

```bash
npm install
npm test        # unit tests for the core, plus a real MCP client over HTTP
npm start       # agent door on http://127.0.0.1:8790/mcp
```

`PORT` and `HOST` change where it listens. To try it by hand, run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP and connect to `http://127.0.0.1:8790/mcp`.

## Layout

```
data/demo-business.json   the fictional business: services, tiers, prices, bundle and add-on rules
src/core.mjs              the one brain: pure, deterministic listServices() and quote()
src/mcp-server.mjs        the agent door: MCP over Streamable HTTP, calls the core only
test/                     core tests, the five scripted customer profiles, the MCP door test
smoke/                    the day-1 smoke test (model tool calling and a first MCP server)
```

## Built for

The Nebius x NVIDIA hackathon, by [Widem](https://github.com/widem-ai).

## License

MIT. See `LICENSE`.
