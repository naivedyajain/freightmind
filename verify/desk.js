// Whose desk is this inbox? The same agent serves two setups; only this setting changes.
//   supplier: the supplier's CG team, receiving documents from the manufacturers that make its goods,
//             checking them against each end customer's requirements.
//   customer: the customer's CG team, receiving documents from its suppliers, checking them against its own rules.
// The setting picks the rules (engine.rulesFor), who the counterparty is, the reply's voice, and how dashboards group.
const { db, J } = require("./store");
const { sameParty } = require("./engine");

db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)");

const PRESETS = {
  supplier: { mode: "supplier", home: "Unilever", team: "Export documentation" },
  customer: { mode: "customer", home: "RP Investments International SL", team: "Import documentation" },
};
const ROLES = {
  supplier: { desk: "Supplier's CG team", counterparty: "manufacturer", counterparties: "manufacturers" },
  customer: { desk: "Customer's CG team", counterparty: "supplier", counterparties: "suppliers" },
};

function desk() {
  const r = db.prepare("SELECT value FROM settings WHERE key='desk'").get();
  const v = { ...PRESETS.supplier, ...(r ? J(r.value, {}) : {}) };
  return { ...v, ...ROLES[v.mode], presets: PRESETS };
}
function setDesk(d = {}) {
  const mode = d.mode === "customer" ? "customer" : "supplier";
  const base = PRESETS[mode];
  const v = { mode, home: String(d.home || "").trim() || base.home, team: String(d.team || "").trim() || base.team };
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('desk', ?)").run(JSON.stringify(v));
  return desk();
}

// the parties named on the documents themselves
function parties(docs, fromAddr) {
  const f = (t, k) => { const d = docs.find((x) => x.doc_type === t && x.fields && x.fields[k]); return d ? d.fields[k] : null; };
  const m = String(fromAddr || "").match(/@([^>\s]+)/);
  return {
    seller: f("commercial_invoice", "seller"),
    customer: f("commercial_invoice", "sold_to_name"),
    maker: f("bill_of_lading", "shipper") || f("certificate_of_origin", "exporter") || f("booking_confirmation", "shipper"),
    domain: m ? m[1].toLowerCase() : null,
  };
}
// who is on the other side of this desk: the manufacturer for a supplier's team, the supplier for a customer's team
function counterparty(p, d = desk()) {
  const order = d.mode === "supplier" ? [p.maker, p.seller] : [p.seller, p.maker];
  return order.find((x) => x && !sameParty(x, d.home)) || p.domain || null;
}

module.exports = { desk, setDesk, parties, counterparty, PRESETS, ROLES };
