const express = require("express");
const Database = require("better-sqlite3");
const https = require("https");
const path = require("path");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(__dirname));

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

// --- guardrail: only allow a single read-only query (SELECT, or WITH ... SELECT) ---
// The database is also opened read-only, so a write could never succeed anyway; this check is the first line.
function isSafeSelect(sql) {
  const s = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim().replace(/;+\s*$/, "");
  if (/;/.test(s)) return false; // no multiple statements
  if (!/^(select|with)\b/i.test(s)) return false;
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex)\b/i.test(s)) return false;
  if (/\breplace\s+into\b/i.test(s)) return false; // REPLACE() the string function is fine; REPLACE INTO is not
  return true;
}

// --- pull the SQL out of whatever the model returned (fences, a sentence before it, a trailing note) ---
function extractSql(text) {
  let t = (text || "").trim();
  if (/^no_answer\b/i.test(t) || /^NO_ANSWER$/m.test(t)) return "NO_ANSWER";
  const fence = t.match(/```(?:sql|sqlite)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/\b(with|select)\b/i);
  if (start > 0) t = t.slice(start);
  const semi = t.indexOf(";");
  if (semi !== -1 && t.slice(semi + 1).trim()) t = t.slice(0, semi); // drop any prose after the first statement
  return t.trim().replace(/;+\s*$/, "");
}

// --- one shared Claude caller: model from env, automatic fallback if a model id is retired ---
const MODELS = [process.env.CLAUDE_MODEL, "claude-sonnet-5-5", "claude-sonnet-4-5", "claude-haiku-5-5"].filter(Boolean);
let workingModel = null; // remembered after the first success
let lastModel = null;
function postMessages(apiKey, payload) {
  const body = JSON.stringify(payload);
  const options = {
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", timeout: 45000,
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-length": Buffer.byteLength(body) },
  };
  return new Promise((resolve, reject) => {
    const r = https.request(options, (res) => {
      let data = ""; res.on("data", (c) => (data += c));
      res.on("end", () => {
        let j; try { j = JSON.parse(data); } catch (e) { return reject(new Error("Bad API response (HTTP " + res.statusCode + ")")); }
        if (j.error) { const err = new Error(j.error.message || "API error"); err.type = j.error.type; err.status = res.statusCode; return reject(err); }
        resolve(((j.content && j.content[0] && j.content[0].text) || "").trim());
      });
    });
    r.on("timeout", () => r.destroy(new Error("Model call timed out")));
    r.on("error", reject); r.write(body); r.end();
  });
}
// prefer: "fast" routes to the cheaper model first (the UI's model picker), otherwise the default order
// clean a key: strip spaces, line breaks and quotes that sneak in when pasting (often on mobile)
function cleanKey(k) { return (k || "").toString().replace(/[\s"']/g, ""); }
// try the server key first, then a key pasted in the browser; only move on if the first one is rejected as invalid
async function callWithKeys(keys, payload, prefer) {
  const list = keys.map(cleanKey).filter((k, i, a) => k && a.indexOf(k) === i);
  if (!list.length) throw new Error("No API key available");
  let lastErr;
  for (const k of list) {
    try { return await callClaude(k, payload, prefer); }
    catch (e) { lastErr = e; if (!(e.status === 401 || /x-api-key|authentication/i.test(e.message || ""))) throw e; }
  }
  throw lastErr;
}
async function callClaude(apiKey, payload, prefer) {
  let order = workingModel ? [workingModel, ...MODELS.filter((m) => m !== workingModel)] : MODELS;
  if (prefer === "fast") order = ["claude-haiku-5-5", ...order.filter((m) => m !== "claude-haiku-5-5")];
  let lastErr;
  for (const model of order) {
    try { const out = await postMessages(apiKey, { ...payload, model }); if (prefer !== "fast") workingModel = model; lastModel = model; return out; }
    catch (e) {
      lastErr = e;
      const modelProblem = e.type === "not_found_error" || /model/i.test(e.message || "");
      if (!modelProblem) throw e; // auth, credit, rate-limit: don't hide it behind retries
    }
  }
  throw lastErr;
}

const SYSTEM_SQL =
      "You are a SQL analyst for a freight logistics database. Given a question, return ONLY a single valid SQLite SELECT query that answers it. No explanation, no markdown, no code fences, no clarifying questions — just the SQL. If a question is vague (e.g. 'was this overcharged?') infer the most reasonable interpretation over the whole table rather than asking for specifics — for overcharge questions, compare invoices to quotes on shipment_id and surface the gaps. Never respond with prose. Use only the tables and columns given. If the question is truly unrelated to this freight data, return exactly: NO_ANSWER\n\n" +
      SCHEMA;

// --- call Claude to turn a question into SQL ---
function askClaude(apiKey, question, prefer) {
  return callWithKeys([].concat(apiKey), {
    max_tokens: 400,
    system: SYSTEM_SQL,
    messages: [{ role: "user", content: question }],
  }, prefer);
}

// --- the agent endpoint: question -> SQL -> execute -> grounded result ---
app.post("/api/ask", async (req, res) => {
  const { question } = req.body || {};
  // Prefer a server-side env var (production); fall back to a key pasted by the user (local demo).
  const apiKey = [process.env.ANTHROPIC_API_KEY, req.body && req.body.apiKey].filter(Boolean);
  if (!apiKey.length) return res.status(400).json({ error: "No API key available. Set ANTHROPIC_API_KEY on the server, or paste a key in the agent panel." });
  if (!question || !question.trim()) return res.status(400).json({ error: "Empty question." });

  let sql;
  try {
    sql = await askClaude(apiKey, question.trim(), /haiku/i.test(req.body.model || "") ? "fast" : null);
  } catch (e) {
    return res.status(502).json({ error: "Model call failed: " + e.message });
  }

  const rawModelText = sql;
  sql = extractSql(sql);

  if (sql === "NO_ANSWER" || /^no_answer$/i.test(sql)) {
    return res.json({ answerable: false, sql: null, message: "I can't answer that from the connected data." });
  }
  if (!isSafeSelect(sql)) {
    console.warn("blocked model output:", rawModelText.slice(0, 300));
    return res.json({ answerable: false, sql, message: "Generated query was not a safe read-only SELECT, so it was blocked." });
  }

  try {
    const stmt = db.prepare(sql);
    if (!stmt.reader) return res.json({ answerable: false, sql, message: "Generated query does not read data, so it was blocked." });
    const rows = stmt.all();
    const cols = rows.length ? Object.keys(rows[0]) : (stmt.columns ? stmt.columns().map((c) => c.name) : []);
    res.json({ answerable: true, sql, cols, rows, rowCount: rows.length, model: lastModel });
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

// self-test: proves key + model work before a live demo. Open /api/selftest in the browser.
app.get("/api/selftest", async (req, res) => {
  const raw = process.env.ANTHROPIC_API_KEY || "";
  const k = cleanKey(raw);
  const info = { keySet: !!raw, keyStart: k ? k.slice(0, 10) + "…" : null, keyLength: k.length, hadSpacesOrQuotes: raw !== k,
    looksRight: /^sk-ant-/.test(k) && k.length > 80 };
  if (!k) return res.json({ ok: false, problem: "ANTHROPIC_API_KEY is not set on the server (check the variable name)", ...info });
  try { const t = await callClaude(k, { max_tokens: 10, messages: [{ role: "user", content: "Reply OK" }] }); res.json({ ok: true, model: workingModel, reply: t, ...info }); }
  catch (e) { res.json({ ok: false, problem: e.message, tried: MODELS, ...info }); }
});

// $ at risk: every invoice charge billed above its quote, across all invoices (deterministic)
app.get("/api/exposure", (req, res) => {
  const r = db.prepare(
    "SELECT COUNT(*) AS invoices, SUM(gap) AS total, SUM(det) AS detention FROM (" +
    " SELECT MAX(i.ocean_freight-q.ocean_freight,0)+MAX(i.baf-q.baf,0)+MAX(i.thc-q.thc,0)+MAX(i.documentation-q.documentation,0)+MAX(i.detention-q.detention,0) AS gap," +
    " MAX(i.detention-q.detention,0) AS det FROM invoices i JOIN quotes q ON i.shipment_id=q.shipment_id) WHERE gap>0"
  ).get();
  const top = db.prepare(
    "SELECT s.carrier, SUM(MAX(i.detention-q.detention,0)) AS d FROM invoices i JOIN quotes q ON i.shipment_id=q.shipment_id JOIN shipments s ON s.shipment_id=i.shipment_id GROUP BY s.carrier ORDER BY d DESC LIMIT 1"
  ).get();
  const hero = db.prepare(
    "SELECT i.shipment_id FROM invoices i JOIN quotes q ON i.shipment_id=q.shipment_id ORDER BY (i.detention-q.detention) DESC LIMIT 1"
  ).get();
  res.json({ invoices: r.invoices || 0, total: r.total || 0, detention: r.detention || 0, topCarrier: top && top.d > 0 ? top.carrier : null, heroShipment: hero && hero.shipment_id });
});

// health check
app.get("/api/health", (req, res) => res.json({ ok: true, rows: db.prepare("SELECT COUNT(*) c FROM shipments").get().c }));

// --- vision extraction: uploaded invoice image/pdf -> structured fields ---
function askVision(apiKey, mediaType, base64Data) {
  const isPdf = mediaType === "application/pdf";
  const sourceBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
  return callWithKeys([].concat(apiKey), {
    max_tokens: 900,
    messages: [{
      role: "user",
      content: [
        sourceBlock,
        { type: "text", text:
          "This is a freight invoice. Extract these fields and return ONLY a JSON object, no markdown, no explanation:\n" +
          "{ invoice_id, shipment_id, carrier, origin, destination, charges: { ocean_freight, baf, thc, documentation, detention }, total, currency }\n" +
          "For each charge, use the numeric amount only (no currency symbol). Also return a FLAT object called confidence whose keys are exactly ocean_freight, baf, thc, documentation, detention and whose values are 0-1 numbers. Do NOT nest confidence under 'charges'.\n" +
          "CRITICAL RULES for unreadable amounts: If a charge amount is smudged, blurred, obscured, stained, or you cannot clearly read the actual digits, you MUST (a) set that charge's value to null, and (b) set its confidence to 0.3 or lower. NEVER output 0 or a guessed number for an amount you cannot actually read — 0 is a real value and must only be used when the invoice clearly shows zero. Do NOT infer an obscured amount from the total or from the other charges.\n" +
          "Return exactly: { fields: { ...all fields..., charges: {...} }, confidence: { ocean_freight:.., baf:.., thc:.., documentation:.., detention:.. } }" }
      ]
    }]
  }).then((text) => {
    text = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    const m = text.match(/\{[\s\S]*\}/); // tolerate stray prose around the JSON
    try { return JSON.parse(m ? m[0] : text); }
    catch (e) { throw new Error("Could not parse extraction: " + e.message); }
  });
}

app.post("/api/extract", async (req, res) => {
  const apiKey = [process.env.ANTHROPIC_API_KEY, req.body && req.body.apiKey].filter(Boolean);
  const { mediaType, data } = req.body || {};
  if (!apiKey.length) return res.status(400).json({ error: "No API key available." });
  if (!data || !mediaType) return res.status(400).json({ error: "No file provided." });
  try {
    const out = await askVision(apiKey, mediaType, data);
    // Normalize: guarantee a FLAT confidence object keyed by charge name, no matter how the model nested it.
    const CHARGES = ["ocean_freight", "baf", "thc", "documentation", "detention"];
    const charges = (out.fields && out.fields.charges) || {};
    let conf = out.confidence || {};
    if (conf.charges && typeof conf.charges === "object") conf = conf.charges; // un-nest if the model nested it
    const flatConf = {};
    for (const k of CHARGES) {
      let c = conf[k];
      const v = charges[k];
      // If value is missing/null (model couldn't read it), force low confidence regardless of what it claimed.
      if (v === null || v === undefined || v === "") { c = Math.min(c != null ? c : 0.3, 0.3); }
      flatConf[k] = (typeof c === "number") ? c : 0.95;
    }
    res.json({ ok: true, fields: out.fields, confidence: flatConf });
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
