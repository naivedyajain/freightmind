// Measured cost: every model call's real token usage, attributed to the document set being processed.
// Prices are data (USD per million tokens, standard tier; source: platform.claude.com/docs/en/about-claude/pricing, Oct 2026).
const { AsyncLocalStorage } = require("async_hooks");
const { db } = require("./store");

db.exec(`CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id INT, model TEXT, input INT, output INT,
  cache_read INT, cache_write INT, usd REAL, at TEXT DEFAULT (datetime('now')))`);

const PRICES = {
  "claude-opus-5-5": { in: 4, out: 20, cw: 5, cr: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cw: 2.5, cr: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01 },
  "claude-sonnet-4-5": { in: 3, out: 15, cw: 3.75, cr: 0.3 },
};
const als = new AsyncLocalStorage();
const costOf = (model, u) => {
  const p = PRICES[model] || PRICES["claude-sonnet-5-5"];
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_creation_input_tokens || 0) * p.cw + (u.cache_read_input_tokens || 0) * p.cr) / 1e6;
};
function record(model, u) {
  const s = als.getStore();
  db.prepare("INSERT INTO usage(packet_id, model, input, output, cache_read, cache_write, usd) VALUES (?,?,?,?,?,?,?)")
    .run(s ? s.packet : null, model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, costOf(model, u));
}
global.__fmUsage = record; // called by server.js after every model call

function forPacket(id) {
  const r = db.prepare("SELECT COUNT(*) calls, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(usd) usd, GROUP_CONCAT(DISTINCT model) models FROM usage WHERE packet_id=?").get(id);
  return { calls: r.calls || 0, input: r.input || 0, output: r.output || 0, cache_read: r.cache_read || 0, usd: r.usd || 0, models: r.models || "" };
}
function summary() {
  const per = db.prepare(`SELECT p.id, COUNT(u.id) calls, SUM(u.input) input, SUM(u.output) output, SUM(u.usd) usd,
      (SELECT COUNT(*) FROM documents d WHERE d.packet_id=p.id AND d.status IN ('read','duplicate')) docs
    FROM packets p JOIN usage u ON u.packet_id=p.id WHERE p.synthetic=0 GROUP BY p.id`).all();
  const sets = per.length, usd = per.reduce((a, r) => a + (r.usd || 0), 0), docs = per.reduce((a, r) => a + (r.docs || 0), 0);
  const calls = per.reduce((a, r) => a + r.calls, 0), input = per.reduce((a, r) => a + (r.input || 0), 0), output = per.reduce((a, r) => a + (r.output || 0), 0);
  const cached = db.prepare("SELECT COUNT(*) n FROM documents WHERE extractor LIKE '%(cached)%'").get().n;
  return { sets, usd, docs, calls, input, output, cached_reads: cached,
    per_set_usd: sets ? usd / sets : null, per_doc_usd: docs ? usd / docs : null,
    per_call_in: calls ? Math.round(input / calls) : null, per_call_out: calls ? Math.round(output / calls) : null, prices: PRICES };
}
module.exports = { als, record, forPacket, summary, PRICES, costOf };
