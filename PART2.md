# FreightMind Verify (Part 2): CG document verification agent

Builds on Part 1: the same store, the same extractor approach, and Ask can query everything below.
Open **`/verify.html`** (or "Verify trade documents" in the Part 1 rail).

## User journeys (setup once, then everything happens in email)

**Setup (CG, once):** open `/verify.html` → **Connect mailbox** → Gmail address + app password. Two addresses are now live on one mailbox:

| Address | Agent | Who uses it |
|---|---|---|
| `name@gmail.com` | CG agent | Suppliers send their document sets here, as today |
| `name+precheck@gmail.com` | Supplier's agent | Suppliers send here first to see what CG would reject |

| Persona | Journey | What changes for them |
|---|---|---|
| **Supplier, no agent** | Emails documents to CG → gets CG's reply in the same thread | Nothing. The reply is clearer (field by field) and ends with the pre-check address |
| **Supplier, with agent** | Emails documents to `+precheck` → about a minute later gets "2 issues will get this rejected" → fixes → emails CG | One extra address. Nothing reaches CG until they choose |
| **CG** | Opens Gmail as always → the supplier's thread already holds the agent's **draft reply** → reviews (details one click away in FreightMind) → presses Send in Gmail | Reads flags instead of every field. Decisions made in FreightMind update the Gmail draft |
| **Customer** | Opens the readiness page | Sees which shipments have documents cleared before the vessel arrives |

**Permissions.** The CG agent can only create drafts; it never emails a supplier on its own. The supplier's agent replies only to the supplier who asked it. Agent emails carry an `X-FreightMind-Agent` header and `Auto-Submitted`, so agents never react to each other (no loops). The reply time is measured when CG's reply appears in Gmail's Sent folder.

## What it does

```
SU email + attachments ──► CG mailbox (IMAP) ──► agent reads every document ──► checks ──► flags ──► draft reply
                                                                                                  │
                                       CG reviews flags, edits the draft, clicks Send ◄───────────┘
                                       (threaded SMTP reply; the agent never sends)
```

| Step | How |
|---|---|
| Trigger | IMAP poll of the CG mailbox (every 30 s), or "+ Upload an SU email" (same pipeline) |
| Read | Text-first (PDF text → model structures it), vision for scans, Excel loading plans, zipped COAs; cached by file hash |
| Compare | Deterministic rules from the knowledge store + cross-document checks |
| Flag | match / mismatch / uncertain, with documents, values, confidence and the reason path |
| Draft | Approval or field-by-field amendment, built only from the checks |
| Store | `packets`, `documents`, `checks`, `decisions`, `facts` in SQLite; queryable through Ask |

**Trust rules.** A field read below 90% confidence on a critical rule is *uncertain*, never a match.
A final document supersedes its draft. Identical copies are ignored; different versions are both checked and compared.
Approval is drafted only when every check passes. Only CG sends.

## Architecture: fixed; configuration: data

| Fixed (code) | Data (knowledge store tables) |
|---|---|
| Intake → read → resolve → verify → draft → store | `doc_types`: schema per document type |
| Extractor interface | `rules`: check type, severity, scope (regulation → agreement → customer), version, owner, visibility |
| Rule engine (check *types*) | `aliases`: ports, countries, parties |
| Ledger, autonomy policy | `facts`: classifications, learned rules; status proposed/confirmed, source, confidence |

Adding a customer, document type or country is a data change.

## Data-connected levels (switch at the top of the page)

| Level | Adds | Changes |
|---|---|---|
| Documents only | Attachments + rulebook | Cross-document and rule checks |
| + Booking & loading plan | Carrier booking, factory loading plan | Containers, COA batches, vessel |
| + ETA | Arrival date | Inbox sorted by urgency |
| + Cost of delay | Demurrage/detention rate (assumed $150/container/day, labelled) | $ at risk per day |
| + History | Track record per rule (demo history, labelled) | Auto-clear verdict, earned per rule |

## Setup

```bash
npm install
npm run build:db
npm run build:ui        # only if you change src/verify.jsx
npm start               # http://localhost:3000/verify.html
```

Environment (Render → Environment):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Model for reading documents (or paste a key in the Part 1 app) |
| `MAIL_USER`, `MAIL_PASS` | CG mailbox and its **app password** (Gmail: 2-step verification on → App passwords) |
| `IMAP_HOST`, `SMTP_HOST` | Default `imap.gmail.com` / `smtp.gmail.com` |
| `DEMURRAGE_USD_PER_DAY` | Assumed cost per container per day (default 150) |

Real shipment documents are **not** in this repo. They arrive by email or upload.

## Sample questions (Ask, Part 1 page)

- Which rules fail most often across document sets?
- Which customers have document sets with mismatches?
- How many document sets passed first time?
- Which products have HS codes that are only proposed, not confirmed?

## 2-minute demo script

**0:00 · Problem (15 s).** "CG opens every attachment and checks every field from memory. Two to four amendment cycles per shipment, 4 to 24 hours each. Wrong documents hold cargo at the port."

**0:15 · Trigger (15 s).** Send the SU email with shipment 580026's documents to the CG mailbox. "No portal for the supplier. Email in, email out. The agent is listening on the mailbox." The set appears in the inbox: *Reading…*, documents ticking through.

**0:30 · Verification (30 s).** "13 documents, one shipment. Four things to fix, two to decide." Open **Port of discharge**: "The invoices and BL say San Antonio, Chile. The COO and packing list say Malabo. That alone would stop this cargo." Open **Incoterm**: "FOB has to name the loading port; this one names the destination." Open **HS across documents**: "Three different national codes for the same soap. The first six digits agree, so it's a person's call, not the agent's."

**1:00 · Decide and reply (20 s).** Keep the port issue, accept the duplicate line as a split batch with a note. Draft reply: "Every line traces to a check. I edit, I send. It goes back in the same thread. The agent never sends on its own."

**1:20 · Data connected (25 s).** Move the switch: "Same documents. Add the booking and loading plan: vessel and container checks. Add the ETA: the inbox sorts by arrival. Add the contract: $ at risk per day. Add history: would this have auto-cleared? Not yet. Autonomy is earned per rule."

**1:45 · Learning + close (15 s).** Versions tab: "Draft to final COO, someone fixed a PO number by hand. That becomes a rule for the supplier's agent, so the error doesn't get created next time." Close: "The model reads, rules judge, a person sends. Part 1's Ask works over all of it."
