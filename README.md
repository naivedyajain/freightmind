# FreightMind — agentic assistant for logistics

A working MVP for the GoComet Agentic AI PM assignment (Part 1). The analytics agent takes a **freeform natural-language question**, uses **Claude to generate SQL**, runs it **read-only against a real SQLite database**, and returns a grounded answer with the exact query shown. Document extraction, reconciliation, the scan-for-similar delighter, governance, and workflows round out the harness.

## Architecture

```
Browser (React)  ──POST /api/ask──▶  Node/Express server
  types a question                    ├─ calls Claude → generates SQL
                                       ├─ guardrail: read-only SELECT only
                                       └─ runs SQL on real SQLite (better-sqlite3)
  ◀── answer + table + chart + trace ──┘
```

- **Live LLM → SQL → result.** Every analytics question is answered by a real model call and a real query. Nothing is canned.
- **The key stays server-side.** The browser never holds your Anthropic key in the deployed version — it's an env var on the server. (For quick local demos there's also a paste-key field; in production you set it as an env var and remove the field.)
- **Guardrails.** Generated SQL is rejected unless it's a single read-only `SELECT`; the agent refuses ("I can't answer that from the connected data") rather than inventing answers.

## Run locally

```bash
npm install
npm run build:db        # builds freight.db from the seed
npm start               # http://localhost:3000
```

Open the page, paste your Anthropic API key in the agent panel (session-only), and ask anything:
- "Which carrier overcharges us the most on detention?"
- "Show me all invoices billed more than they were quoted"
- "What did we spend by carrier?"

## Deploy to Render

1. Push this folder to a GitHub repo.
2. On Render: **New → Web Service → connect the repo.**
3. Render reads `render.yaml`: build `npm install && npm run build:db`, start `npm start`.
4. (Optional, to hide the key server-side) add an env var `ANTHROPIC_API_KEY` and switch the server to read it — see the note in `server.js`. Otherwise the demo uses the paste-key field, which is fine for a driven demo.
5. Render gives you a real always-on URL.

## What's real vs roadmap

Real: live NL→SQL analytics, real SQLite, extraction review flow, reconcile, scan-for-similar (real 3-way join), governance traces, cost, model selection, workflow composer.
Roadmap (shown, not built): live vision extraction on arbitrary uploads, connectors (TMS/ERP/carrier/email), shared skill library, scheduled surveillance agents.

## The data

200 synthetic shipments, matching quotes, 18 invoices with a deliberate discoverable pattern: Pacific Ocean Lines billing detention quoted at $0 across 5 Shanghai→LA shipments ($3,450). Ask "which carrier overcharges us the most on detention?" and the agent finds it live.

## Files

- `server.js` — Express backend, `/api/ask` agent endpoint, guardrails, Claude call.
- `public/index.html` — React app (pre-compiled, no in-browser Babel).
- `seed.js` — SQL schema + 418 inserts. `build_db.js` turns it into `freight.db`.
- `DEMO_SCRIPT.md` — 2-minute demo path.

## UI (v2)
Single conversational surface — no numbered tabs. A thread in the center, a composer pinned at the bottom, and a left rail of capabilities you invoke in any order (ask, read a document, reconcile, run workflow), a live cost meter, and greyed "coming soon" connectors. Document upload is real: drop a PDF or image and Claude vision extracts the fields; low-confidence fields are editable inline before storing. The "invoice check" workflow runs a real capability chain with a human-approval pause. Sample invoice included as PDF and PNG (downloadable in-app).
