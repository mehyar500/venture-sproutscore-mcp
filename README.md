# SproutScore MCP Server

Public, read-only [Model Context Protocol](https://modelcontextprotocol.io) (Streamable HTTP) access to NYC childcare-center inspection summaries — so AI assistants can answer "is this daycare safe?" with real city data.

**Endpoint:** `POST https://mcp.sproutscore.mehyar.us/mcp`
(fallback: `https://sproutscore-mcp.<account>.workers.dev/mcp`)
**Usage doc:** `GET https://mcp.sproutscore.mehyar.us/`

## Data caveat (read this)

Inspection data covers **2020–2023 only** (last city update 2023-04-24). The city has not published newer daycare inspection data since April 2023. Every tool description and response carries this caveat — never present results as current/live.

Violation plain-English decodes are **AI-seeded and pending human review** — not expert-verified.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `search_centers` | `query` (name substring), `borough`, `limit` (default 10, max 50) | Matching centers: id, name, borough, address, inspection count, flagged count, SproutScore comparison grade (A–F vs NYC cohort average; "N/A" if <3 inspections) |
| `get_center_report` | `center_id` (e.g. `DC1000`) | Decoded summary: counts vs NYC cohort average (verdict + plain text), top violations in plain English with severity + inspection dates, statuses |
| `decode_violation` | `code` (e.g. `47.41(j)`; family prefix like `47.33` returns a family-level decode) | Plain-English meaning, severity tier (critical/major/minor), category, tour question. Unknown codes → clean `unknown_violation_code` error |

All tools are read-only. No auth. No email, no payments, no PII collection.

## Example requests

Initialize + list tools:
```bash
curl -X POST https://mcp.sproutscore.mehyar.us/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Search centers:
```bash
curl -X POST https://mcp.sproutscore.mehyar.us/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"search_centers",
                 "arguments":{"query":"jackson","borough":"queens"}}}'
```

Center report:
```bash
curl -X POST https://mcp.sproutscore.mehyar.us/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"get_center_report",
                 "arguments":{"center_id":"DC3133"}}}'
```

Decode a violation:
```bash
curl -X POST https://mcp.sproutscore.mehyar.us/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call",
       "params":{"name":"decode_violation",
                 "arguments":{"code":"47.41(j)"}}}'
```

Example response (`decode_violation` → `47.41(j)`):
```json
{
  "jsonrpc": "2.0", "id": 4,
  "result": { "content": [{ "type": "text", "text": "{\n  \"level\": \"code\",\n  \"code\": \"47.41(j)\",\n  \"plain_english\": \"Floors/walls ceilings were not maintained; ...\",\n  \"severity\": \"minor\",\n  \"category\": \"Physical plant upkeep\",\n  \"tour_question\": \"...\",\n  \"decode_caveat\": \"Plain-English violation decodes are AI-seeded and pending human review - not expert-verified.\",\n  \"data_as_of\": \"2023-04-24\"\n}" }] }
}
```

## Protocol notes

- MCP Streamable HTTP: send JSON-RPC 2.0 to `POST /mcp`. `initialize`, `tools/list`, `tools/call`, `ping` supported.
- `Accept: application/json` → JSON body; `Accept: text/event-stream` → SSE envelope.
- Notifications (`notifications/*`) return `202` with no body.

## Rate limiting

60 requests/minute per IP (best-effort, per edge isolate). Exceeding it returns HTTP `429` with a JSON-RPC error and `retry_after_seconds`.

## Regenerating the data pack

`src/data.js` and `src/codes.js` are generated from the SproutScore source bundles — never edit them by hand:

```bash
python3 pack.py   # reads ~/workspace/sproutscore/data/{centers,violation-translations}.json
python3 deploy.py # uploads worker + enables workers.dev + attaches custom domain
```

Source of truth: NYC DOHMH via NYC Open Data (`dsg6-ifza`), pulled 2026-09-19.

## Layout

- `src/worker.js` — MCP server (hand-written)
- `src/data.js` — packed center aggregates (generated)
- `src/codes.js` — trimmed violation translation table (generated)
- `pack.py` — regenerable pack script
- `deploy.py` — Cloudflare API deploy (no wrangler needed)
