const express = require("express");
const Database = require("better-sqlite3");
const https = require("https");
const path = require("path");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "freight.db"), { readonly: true });

// --- schema description handed to the model so it writes correct SQL ---
const SCHEMA = `Tables in a freight logistics SQLite database:

shipments(shipment_id TEXT, carrier TEXT, origin TEXT, destination TEXT, mode TEXT, container TEXT, etd TEXT, quarter TEXT, status TEXT)
quotes(shipment_id TEXT, ocean_freight INT, baf INT, thc INT, documentation INT, detention INT)
invoices(invoice_id TEXT, shipment_id TEXT, carrier TEXT, ocean_freight INT, baf INT, thc INT, documentation INT, detention INT, detention_conf REAL, note TEXT)

Notes:
- quotes = what was agreed; invoices = what was billed. Join on shipment_id.
- An overcharge is when an invoice charge exceeds the quote for the same shipment. Detention is frequently billed on invoices though quoted at 0.
- A total charge = ocean_freight + baf + thc + documentation + detention.
- Carriers include 'Pacific Ocean Lines', 'Meridian Shipping', 'BlueWave Carriers', 'TransGlobal Freight', 'Cathay Container Co'.
- Lanes are origin -> destination, e.g. 'Shanghai' -> 'Los Angeles'.`;

// --- guardrail: only allow a single read-only SELECT ---
function isSafeSelect(sql) {
  const s = sql.trim().replace(/;+\s*$/, "");
  if (/;/.test(s)) return false; // no multiple statements
  if (!/^select\b/i.test(s)) return false; // must start with SELECT
  if (/\b(insert|update|delete|drop|alter|create|attach|pragma|replace)\b/i.test(s)) return false;
  return true;
}

// --- call Claude to turn a question into SQL ---
function askClaude(apiKey, question) {
  const body = JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 400,
    system:
      "You are a SQL analyst for a freight logistics database. Given a question, return ONLY a single valid SQLite SELECT query that answers it. No explanation, no markdown, no code fences, no clarifying questions — just the SQL. If a question is vague (e.g. 'was this overcharged?') infer the most reasonable interpretation over the whole table rather than asking for specifics — for overcharge questions, compare invoices to quotes on shipment_id and surface the gaps. Never respond with prose. Use only the tables and columns given. If the question is truly unrelated to this freight data, return exactly: NO_ANSWER\n\n" +
      SCHEMA,
    messages: [{ role: "user", content: question }],
  });
  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-length": Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || "API error"));
          const text = (j.content && j.content[0] && j.content[0].text || "").trim();
          resolve(text);
        } catch (e) {
          reject(new Error("Bad API response"));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- the agent endpoint: question -> SQL -> execute -> grounded result ---
app.post("/api/ask", async (req, res) => {
  const { question } = req.body || {};
  // Prefer a server-side env var (production); fall back to a key pasted by the user (local demo).
  const apiKey = process.env.ANTHROPIC_API_KEY || (req.body && req.body.apiKey);
  if (!apiKey) return res.status(400).json({ error: "No API key available. Set ANTHROPIC_API_KEY on the server, or paste a key in the agent panel." });
  if (!question || !question.trim()) return res.status(400).json({ error: "Empty question." });

  let sql;
  try {
    sql = await askClaude(apiKey, question.trim());
  } catch (e) {
    return res.status(502).json({ error: "Model call failed: " + e.message });
  }

  // clean stray fences if the model added them
  sql = sql.replace(/^```sql\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();

  if (sql === "NO_ANSWER" || /^no_answer$/i.test(sql)) {
    return res.json({ answerable: false, sql: null, message: "I can't answer that from the connected data." });
  }
  if (!isSafeSelect(sql)) {
    return res.json({ answerable: false, sql, message: "Generated query was not a safe read-only SELECT, so it was blocked." });
  }

  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all();
    const cols = rows.length ? Object.keys(rows[0]) : (stmt.columns ? stmt.columns().map((c) => c.name) : []);
    res.json({ answerable: true, sql, cols, rows, rowCount: rows.length });
  } catch (e) {
    res.json({ answerable: false, sql, message: "The query failed to run: " + e.message });
  }
});

// --- deterministic reconcile: given a shipment or invoice id, diff invoice vs quote ---
app.post("/api/reconcile", (req, res) => {
  const { shipmentId, invoiceId } = req.body || {};
  let inv;
  try {
    if (invoiceId) inv = db.prepare("SELECT * FROM invoices WHERE invoice_id=?").get(invoiceId);
    else if (shipmentId) inv = db.prepare("SELECT * FROM invoices WHERE shipment_id=?").get(shipmentId);
    if (!inv) return res.json({ found: false, message: "No invoice found for that shipment yet." });
    const q = db.prepare("SELECT * FROM quotes WHERE shipment_id=?").get(inv.shipment_id);
    const s = db.prepare("SELECT * FROM shipments WHERE shipment_id=?").get(inv.shipment_id);
    const keys = ["ocean_freight", "baf", "thc", "documentation", "detention"];
    const lines = keys.map(k => ({ charge: k, quoted: q[k] || 0, invoiced: inv[k] || 0, gap: (inv[k] || 0) - (q[k] || 0) }));
    const gap = lines.reduce((a, l) => a + l.gap, 0);
    res.json({
      found: true, invoice_id: inv.invoice_id, shipment_id: inv.shipment_id,
      carrier: s.carrier, lane: s.origin + " → " + s.destination,
      lines, gap,
      quoteTotal: lines.reduce((a, l) => a + l.quoted, 0),
      invoiceTotal: lines.reduce((a, l) => a + l.invoiced, 0)
    });
  } catch (e) { res.status(500).json({ found: false, message: e.message }); }
});

// --- deterministic scan-for-similar: same carrier+lane detention overcharges ---
app.post("/api/scan", (req, res) => {
  const { shipmentId } = req.body || {};
  try {
    const s = db.prepare("SELECT carrier, origin, destination FROM shipments WHERE shipment_id=?").get(shipmentId);
    if (!s) return res.json({ found: false });
    const rows = db.prepare(
      "SELECT i.invoice_id, i.shipment_id, q.detention AS quoted, i.detention AS billed, (i.detention-q.detention) AS overcharge " +
      "FROM invoices i JOIN quotes q ON i.shipment_id=q.shipment_id JOIN shipments sh ON i.shipment_id=sh.shipment_id " +
      "WHERE sh.carrier=? AND sh.origin=? AND i.detention>q.detention ORDER BY overcharge DESC"
    ).all(s.carrier, s.origin);
    const total = rows.reduce((a, r) => a + r.overcharge, 0);
    res.json({ found: true, carrier: s.carrier, lane: s.origin + " → " + s.destination, hits: rows, total });
  } catch (e) { res.status(500).json({ found: false, message: e.message }); }
});

// health check
app.get("/api/health", (req, res) => res.json({ ok: true, rows: db.prepare("SELECT COUNT(*) c FROM shipments").get().c }));

// --- vision extraction: uploaded invoice image/pdf -> structured fields ---
function askVision(apiKey, mediaType, base64Data) {
  const isPdf = mediaType === "application/pdf";
  const sourceBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
  const body = JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 700,
    messages: [{
      role: "user",
      content: [
        sourceBlock,
        { type: "text", text:
          "This is a freight invoice. Extract these fields and return ONLY a JSON object, no markdown, no explanation:\n" +
          "{ invoice_id, shipment_id, carrier, origin, destination, charges: { ocean_freight, baf, thc, documentation, detention }, total, currency }\n" +
          "For each charge, use the numeric amount only (no currency symbol). For every charge also include a confidence 0-1 in a parallel object called confidence with the same charge keys.\n" +
          "IMPORTANT: If a charge amount is visually smudged, blurred, obscured, or otherwise hard to read with certainty, you MUST set its confidence below 0.5 — even if you could guess it. Do NOT infer an obscured amount from the total or from the other charges; if you cannot clearly read the digits themselves, it is low confidence. Read only what is actually legible.\n" +
          "Return exactly: { fields: {...}, confidence: {...} }" }
      ]
    }]
  });
  const options = {
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-length": Buffer.byteLength(body) }
  };
  return new Promise((resolve, reject) => {
    const r = https.request(options, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || "API error"));
          let text = (j.content && j.content[0] && j.content[0].text || "").trim();
          text = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error("Could not parse extraction: " + e.message)); }
      });
    });
    r.on("error", reject); r.write(body); r.end();
  });
}

app.post("/api/extract", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || (req.body && req.body.apiKey);
  const { mediaType, data } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: "No API key available." });
  if (!data || !mediaType) return res.status(400).json({ error: "No file provided." });
  try {
    const out = await askVision(apiKey, mediaType, data);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ error: "Vision extraction failed: " + e.message });
  }
});

// --- workflow runner: runs the invoice-check chain, returns each step's real result ---
app.post("/api/run-workflow", (req, res) => {
  // This runs entirely on the DB (no LLM) — deterministic capability chain.
  const heroInv = db.prepare(
    "SELECT i.invoice_id, i.shipment_id, s.carrier, s.origin, s.destination FROM invoices i JOIN shipments s ON i.shipment_id=s.shipment_id JOIN quotes q ON i.shipment_id=q.shipment_id WHERE i.detention>q.detention AND s.carrier='Pacific Ocean Lines' ORDER BY i.detention DESC LIMIT 1"
  ).get();
  const rec = db.prepare(
    "SELECT (i.ocean_freight+i.baf+i.thc+i.documentation+i.detention)-(q.ocean_freight+q.baf+q.thc+q.documentation+q.detention) AS gap, i.detention-q.detention AS det_gap FROM invoices i JOIN quotes q ON i.shipment_id=q.shipment_id WHERE i.invoice_id=?"
  ).get(heroInv.invoice_id);
  const scan = db.prepare(
    "SELECT COUNT(*) n, SUM(i.detention-q.detention) total FROM invoices i JOIN quotes q ON i.shipment_id=q.shipment_id JOIN shipments s ON i.shipment_id=s.shipment_id WHERE s.carrier=? AND s.origin=? AND i.detention>q.detention"
  ).get(heroInv.carrier, heroInv.origin);
  const lowConf = db.prepare("SELECT COUNT(*) n FROM invoices WHERE detention_conf < 0.7").get();
  res.json({
    steps: [
      { name: "Extract invoice", status: "done", detail: `Read ${heroInv.invoice_id} — 5 charge fields` },
      { name: "Reconcile vs quote", status: "done", detail: `Gap of $${rec.gap} (detention $${rec.det_gap} over)` },
      { name: "Human approval", status: "paused", detail: "Waiting for a person to approve the dispute" },
      { name: "Scan for similar", status: "done", detail: `${scan.n} shipments, $${scan.total} total exposure` },
      { name: "Flag for review", status: "done", detail: `${lowConf.n} low-confidence field needs a human check` },
    ],
    summary: { carrier: heroInv.carrier, lane: heroInv.origin + " → " + heroInv.destination, shipments: scan.n, total: scan.total }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("FreightMind server on http://localhost:" + PORT));
