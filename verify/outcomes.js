// Outcomes for the three buyers. Every number is either MEASURED from events (sets, rounds, replies, decisions,
// token cost) or MODELLED = measured events × deal terms (agreed rates). Demo history is flagged and can be excluded.
const { db, J } = require("./store");
require("./usage"); // makes sure the usage table exists

db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`);
for (const sql of ["ALTER TABLE packets ADD COLUMN demo_json TEXT"]) { try { db.exec(sql); } catch (_) {} }

// ---------------- deal terms (shared with /economics.html) ----------------
const DEFAULT_TERMS = { cgRate: 12, suRate: 8, cgMin1: 35, cgMin2: 8, suMin: 25, r1: 2.5, d1: 8, delayDays: 2, cntr: 2, dd: 150,
  share: 4, countCG: 1, countSU: 0, countDelay: 1, checkers: 12, liveFrom: "2026-06-01" };
function terms() { const r = db.prepare("SELECT value FROM settings WHERE key='terms'").get(); return { ...DEFAULT_TERMS, ...(r ? J(r.value, {}) : {}) }; }
function setTerms(t) { const clean = {}; for (const k of Object.keys(DEFAULT_TERMS)) if (t[k] !== undefined) clean[k] = k === "liveFrom" ? String(t[k]) : Number(t[k]); db.prepare("INSERT OR REPLACE INTO settings VALUES ('terms', ?)").run(JSON.stringify({ ...terms(), ...clean })); return terms(); }

// ---------------- demo history (6 months; agent goes live in month 3) ----------------
const CUSTOMERS = ["CHUAN SENG LEONG PTE LTD", "RADHA EXPORTS PTE. LTD.", "RP INVESTMENTS INTERNATIONAL SL", "MASCOT INTERNATIONAL PVT. LTD."];
const SUPPLIERS = [["PT Unilever Indonesia", "exports@unilever-id.example"], ["PT Alliance Consumer Products", "docs@alliance-cp.example"], ["Unilever South Africa", "export.docs@unilever-za.example"]];
const RULES = ["Incoterm names the right place", "Port of discharge agrees across documents", "Consignee agrees across documents", "HS code agrees across invoice, COO and BL", "Total quantity agrees (invoice, packing list, BL)", "Shipment date agrees (COO vs BL)"];
function seedDemo() {
  if (db.prepare("SELECT COUNT(*) n FROM packets WHERE synthetic=1").get().n) return;
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const months = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
  const plan = { // per month: [shipments, rounds, fpy, reply minutes, held %, precheck share]
    "2026-04": [1860, 2.6, 0.30, 690, 0.08, 0], "2026-05": [1940, 2.5, 0.32, 660, 0.082, 0],
    "2026-06": [2010, 1.7, 0.52, 34, 0.05, 0.15], "2026-07": [2080, 1.5, 0.61, 26, 0.04, 0.35], "2026-08": [2150, 1.35, 0.70, 21, 0.03, 0.55], "2026-09": [2230, 1.25, 0.78, 18, 0.02, 0.7] };
  const insP = db.prepare(`INSERT INTO packets(channel, via, from_addr, subject, received_at, status, shipment_ref, customer, replied_at, outcome, synthetic, demo_json, summary_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`);
  const insC = db.prepare("INSERT INTO checks(packet_id, rule_id, rule_name, subject, status, severity, level, customer, shipment_ref, created_at) VALUES (?,?,?,?,?,?,0,?,?,?)");
  let ref = 3040800000;
  db.transaction(() => {
    for (const m of months) {
      const [n, rounds, fpy, reply, held, pre] = plan[m];
      for (let i = 0; i < n; i++) {
        const cust = CUSTOMERS[i % 4], [supName, supAddr] = SUPPLIERS[(i * 7 + months.indexOf(m)) % 3];
        const day = 1 + Math.floor(rnd() * 27), shipment = String(ref++);
        const firstOk = rnd() < fpy;
        const extra = firstOk ? 0 : Math.max(1, Math.round((rounds - 1) / (1 - fpy) + (rnd() - 0.5)));
        const isHeld = rnd() < held, prechecked = rnd() < pre;
        if (prechecked) insP.run("precheck", "email", supAddr, "Pre-check " + shipment, `${m}-${String(day).padStart(2, "0")}T03:00:00Z`, "ready", shipment, cust, null, null, JSON.stringify({ supplier: supName }), JSON.stringify({ mismatch: firstOk ? 0 : 2 }));
        for (let r = 0; r <= extra; r++) {
          const t = new Date(`${m}-${String(day).padStart(2, "0")}T04:00:00Z`).getTime() + r * 26 * 3600e3;
          const mins = Math.max(4, reply * (0.6 + rnd() * 0.8));
          const last = r === extra, mism = last ? 0 : 1 + Math.floor(rnd() * 3);
          const p = insP.run("email", "email", supAddr, "Documents " + shipment, new Date(t).toISOString(), "replied", shipment, cust, new Date(t + mins * 6e4).toISOString(), last ? "approval" : "amendment",
            JSON.stringify({ supplier: supName, held: last && isHeld ? 1 : 0, containers: 2 }), JSON.stringify({ mismatch: mism })).lastInsertRowid;
          for (let k = 0; k < mism; k++) { const rule = RULES[Math.floor(rnd() * RULES.length)]; insC.run(p, "DEMO", rule, rule, "mismatch", "critical", cust, shipment, new Date(t).toISOString()); }
        }
      }
    }
  })();
}
seedDemo();

// ---------------- metrics ----------------
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
// The demo history is ~25k sets; recomputing it on every request blocks a small server for seconds.
// Rows and results are cached until the live data changes (new set, reply, decision or terms).
const cache = { key: null, rows: {}, out: {} };
function dataKey() {
  const r = db.prepare("SELECT MAX(id) m, COUNT(replied_at) r FROM packets WHERE synthetic=0").get();
  const c = db.prepare("SELECT MAX(id) c FROM checks").get().c, d = db.prepare("SELECT COUNT(*) n FROM decisions").get().n;
  return [r.m, r.r, c, d, JSON.stringify(terms())].join("|");
}
function fresh() { const k = dataKey(); if (k !== cache.key) { cache.key = k; cache.rows = {}; cache.out = {}; } }
let synthRows = null; // demo history never changes once seeded: read it once
function rows(includeDemo) {
  if (!cache.rows.live) cache.rows.live = rows_("synthetic=0");
  if (!includeDemo) return cache.rows.live;
  if (!synthRows) synthRows = rows_("synthetic=1");
  if (!cache.rows.demo) cache.rows.demo = synthRows.concat(cache.rows.live);
  return cache.rows.demo;
}
function rows_(where) {
  return db.prepare(`SELECT id, channel, from_addr, counterparty, received_at, replied_at, outcome, shipment_ref, customer, synthetic, demo_json, summary_json
    FROM packets WHERE ${where} ORDER BY received_at`).all().map((p) => {
    const demo = J(p.demo_json, {}), sum = J(p.summary_json, {});
    const mism = p.synthetic ? sum.mismatch || 0 : db.prepare("SELECT COUNT(*) n FROM checks WHERE packet_id=? AND status='mismatch' AND level=0").get(p.id).n;
    return { ...p, month: (p.received_at || "").slice(0, 7), supplier: demo.supplier || p.counterparty || p.from_addr, held: demo.held || 0, mism };
  });
}
function byMonth(list, includeDemo, filter) {
  const T = terms();
  const all = rows(includeDemo).filter(filter || (() => true));
  const months = [...new Set(all.map((p) => p.month))].filter(Boolean).sort();
  return months.map((m) => {
    const ps = all.filter((p) => p.month === m), sets = ps.filter((p) => p.channel !== "precheck");
    const ship = new Map(); for (const p of sets) { if (!ship.has(p.shipment_ref)) ship.set(p.shipment_ref, []); ship.get(p.shipment_ref).push(p); }
    const shipments = ship.size || 0;
    const firstPass = [...ship.values()].filter((g) => g[0].mism === 0).length;
    const rounds = shipments ? sets.length / shipments : 0;
    const replies = sets.filter((p) => p.replied_at).map((p) => (new Date(p.replied_at) - new Date(p.received_at)) / 6e4);
    const held = [...ship.values()].filter((g) => g.some((p) => p.held)).length;
    const prechecked = new Set(ps.filter((p) => p.channel === "precheck").map((p) => p.shipment_ref)).size;
    const live = m >= T.liveFrom.slice(0, 7);
    // modelled savings per shipment vs the pre-agent baseline in the deal terms
    const heldShare = shipments ? held / shipments : 0;
    const cgSave = live ? (T.r1 * T.cgMin1 - rounds * T.cgMin2) / 60 * T.cgRate * shipments : 0;
    const suSave = live ? Math.max(0, (T.r1 - 1) - (rounds - 1)) * T.suMin / 60 * T.suRate * shipments : 0;
    const delaySave = live ? Math.max(0, T.d1 / 100 - heldShare) * T.delayDays * T.cntr * T.dd * shipments : 0;
    const counted = (T.countCG ? cgSave : 0) + (T.countSU ? suSave : 0) + (T.countDelay ? delaySave : 0);
    const cgHours = live ? (T.r1 * T.cgMin1 - rounds * T.cgMin2) / 60 * shipments : 0;
    const liveIds = sets.filter((p) => !p.synthetic).map((p) => p.id); // demo sets have no usage rows
    const ai = liveIds.length ? db.prepare("SELECT SUM(usd) usd FROM usage WHERE packet_id IN (" + liveIds.join(",") + ")").get().usd : 0;
    const aiCost = (ai || 0) + sets.filter((p) => p.synthetic).length * 0.05; // demo sets at the modelled $0.05
    return { month: m, live, sets: sets.length, shipments, rounds: +rounds.toFixed(2), fpy: shipments ? firstPass / shipments : null,
      reply_median_min: median(replies), held, held_share: heldShare, prechecked, precheck_share: shipments ? prechecked / shipments : 0,
      savings: { cg: cgSave, supplier: suSave, delay: delaySave, counted, fee: counted * T.share / 100, net: counted * (1 - T.share / 100) },
      cg_hours_freed: cgHours, sets_per_checker_day: sets.length / T.checkers / 21, ai_cost: aiCost, ai_per_set: sets.length ? aiCost / sets.length : 0,
      demo: ps.every((p) => p.synthetic) };
  });
}
function topRules(filter, includeDemo) {
  if (!filter) return db.prepare(`SELECT c.rule_name, COUNT(*) n FROM checks c JOIN packets p ON p.id=c.packet_id WHERE c.status='mismatch' ${includeDemo ? "" : "AND p.synthetic=0"} GROUP BY c.rule_name ORDER BY n DESC LIMIT 5`).all();
  const ids = rows(includeDemo).filter(filter || (() => true)).map((p) => p.id);
  if (!ids.length) return [];
  return db.prepare(`SELECT rule_name, COUNT(*) n FROM checks WHERE status='mismatch' AND packet_id IN (${ids.join(",")}) GROUP BY rule_name ORDER BY n DESC LIMIT 5`).all();
}
function scorecard(includeDemo, key, filt) {
  const all = rows(includeDemo).filter((p) => p.channel !== "precheck").filter(filt || (() => true));
  const groups = new Map();
  for (const p of all) { const k = p[key] || "—"; if (!groups.has(k)) groups.set(k, new Map()); const g = groups.get(k); if (!g.has(p.shipment_ref)) g.set(p.shipment_ref, []); g.get(p.shipment_ref).push(p); }
  return [...groups.entries()].map(([k, ships]) => { const s = [...ships.values()]; return { name: k, shipments: s.length, fpy: s.filter((g) => g[0].mism === 0).length / s.length, rounds: s.reduce((a, g) => a + g.length, 0) / s.length }; })
    .sort((a, b) => b.shipments - a.shipments);
}
function guardrail() {
  const r = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN agent_status='match' AND cg_status NOT IN ('match','accepted') THEN 1 ELSE 0 END) bad FROM decisions WHERE synthetic=0").get();
  const auto = db.prepare("SELECT rule_id, COUNT(*) n, SUM(CASE WHEN agent_status=cg_status OR (agent_status='match' AND cg_status='accepted') THEN 1 ELSE 0 END) agree FROM decisions GROUP BY rule_id").all();
  return { decisions: r.n || 0, overridden_matches: r.bad || 0, rules_ready: auto.filter((x) => x.n >= 50 && x.agree / x.n >= 0.99).length, rules_total: auto.length };
}

function outcomes(party, includeDemo = true, who = null) {
  fresh();
  const k = [party, includeDemo ? 1 : 0, who || ""].join("|");
  if (!cache.out[k]) cache.out[k] = outcomes_(party, includeDemo, who);
  return cache.out[k];
}
function outcomes_(party, includeDemo = true, who = null) {
  const T = terms();
  const filt = party === "supplier" && who ? (p) => p.supplier === who : party === "customer" && who ? (p) => p.customer === who : null;
  const months = byMonth(null, includeDemo, filt);
  const live = months.filter((m) => m.live);
  const ytd = live.reduce((a, m) => ({ counted: a.counted + m.savings.counted, fee: a.fee + m.savings.fee, net: a.net + m.savings.net, cg: a.cg + m.savings.cg, supplier: a.supplier + m.savings.supplier, delay: a.delay + m.savings.delay, hours: a.hours + m.cg_hours_freed, ai: a.ai + m.ai_cost }), { counted: 0, fee: 0, net: 0, cg: 0, supplier: 0, delay: 0, hours: 0, ai: 0 });
  const all = rows(includeDemo);
  return { party, terms: T, months, ytd, who,
    options: { suppliers: [...new Set(all.map((p) => p.supplier))].filter(Boolean), customers: [...new Set(all.map((p) => p.customer))].filter(Boolean) },
    top_rules: topRules(filt, includeDemo), guardrail: guardrail(),
    scorecard: party === "customer" || party === "cg" ? scorecard(includeDemo, "supplier", filt) : party === "supplier" ? scorecard(includeDemo, "customer", filt) : null,
    desk: require("./desk").desk(),
    has_demo: all.some((p) => p.synthetic), has_live: all.some((p) => !p.synthetic) };
}
// warm the cache once at start-up so the first dashboard click is instant
setTimeout(() => { try { for (const p of ["cg", "customer", "supplier"]) outcomes(p, true); } catch (_) {} }, 2000);
module.exports = { outcomes, terms, setTerms };
