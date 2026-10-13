// Measure & automate: the agent proposes the next step on every set; every human response is a measurement;
// an action type earns the right to run on its own (per desk) once its measured agreement is high enough,
// capped by how costly a mistake would be. One override drops it a level.
//   0 Suggest · 1 One click · 2 Do and tell (runs after an undo window) · 3 Automatic (audit only)
const { db, J } = require("./store");

db.exec(`
CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, name TEXT, what TEXT, risk TEXT, ceiling INT, cap INT DEFAULT 3, reversible INT DEFAULT 1, ord INT);
CREATE TABLE IF NOT EXISTS action_log(id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id INT, action_id TEXT, status TEXT, outcome TEXT,
  title TEXT, detail TEXT, run_at TEXT, created_at TEXT DEFAULT (datetime('now')), done_at TEXT, synthetic INT DEFAULT 0);
`);

const LEVELS = ["Suggest", "One click", "Do and tell", "Automatic"];
const UNDO_MIN = Number(process.env.UNDO_MIN || 15);
const REMIND_HOURS = Number(process.env.REMIND_HOURS || 24);

const CATALOGUE = [
  // id, name, what it does, risk if wrong, ceiling (highest level it may ever reach), reversible
  ["REMIND_SU", "Remind the sender", "Emails the sender when an amendment has had no resubmission", "Low", 3, 1],
  ["REQUEST_DOC", "Ask for a missing document", "Emails the sender for a required document missing from the set", "Low", 3, 1],
  ["ACCEPT_ALIAS", "Accept a known-safe difference", "Accepts a difference that matches a confirmed fact (e.g. an address alias)", "Low", 3, 1],
  ["ESCALATE_LEAD", "Escalate to the team lead", "Flags a set pending over 24 h to the CG lead", "Low", 2, 1],
  ["WARN_BUYER_ETA", "Warn the buyer before arrival", "Tells the customer's buyer a shipment's papers are not final close to ETA", "Low", 2, 1],
  ["SEND_AMENDMENT", "Send the amendment", "Sends the drafted correction email to the sender", "Medium", 2, 0],
  ["APPROVE_FORWARD", "Approve the set", "Sends the approval and releases the set to the customer", "High", 1, 0],
  ["CONFIRM_FACT", "Confirm a proposed rule", "Turns a proposed fact into a confirmed rule for future checks", "Changes future checks", 0, 1],
];
// seeded track record for the demo (synthetic, labelled): [n, agreed]
const HISTORY = { REMIND_SU: [180, 178], REQUEST_DOC: [64, 63], ACCEPT_ALIAS: [240, 239], ESCALATE_LEAD: [90, 89], WARN_BUYER_ETA: [40, 39], SEND_AMENDMENT: [152, 148], APPROVE_FORWARD: [310, 309], CONFIRM_FACT: [12, 11] };

(function seed() {
  const ins = db.prepare("INSERT OR IGNORE INTO actions(id,name,what,risk,ceiling,reversible,ord) VALUES (?,?,?,?,?,?,?)");
  CATALOGUE.forEach((a, i) => ins.run(a[0], a[1], a[2], a[3], a[4], a[5], i));
  if (db.prepare("SELECT COUNT(*) n FROM action_log WHERE synthetic=1").get().n) return;
  const insL = db.prepare("INSERT INTO action_log(packet_id,action_id,status,outcome,created_at,synthetic) VALUES (NULL,?,?,?,?,1)");
  db.transaction(() => {
    for (const [id, [n, ok]] of Object.entries(HISTORY)) {
      const bad = n - ok; // overrides placed early in the history, so the last 20 decisions are clean
      for (let i = 0; i < n; i++) insL.run(id, "done", i < bad * 3 && i % 3 === 0 ? "rejected" : "agreed", new Date(Date.parse("2026-06-01") + i * 36e5 * 6).toISOString());
    }
  })();
})();

function earned(rate, n) { return rate >= 0.99 && n >= 200 ? 3 : rate >= 0.98 && n >= 50 ? 2 : rate >= 0.9 && n >= 10 ? 1 : 0; }
function stats(id) {
  const a = db.prepare("SELECT * FROM actions WHERE id=?").get(id);
  const rows = db.prepare("SELECT outcome, synthetic FROM action_log WHERE action_id=? AND outcome IS NOT NULL ORDER BY id").all(id);
  const n = rows.length, agreed = rows.filter((r) => r.outcome === "agreed").length, rate = n ? agreed / n : 0;
  const last = rows.slice(-20), override = last.some((r) => r.outcome !== "agreed");
  const e = earned(rate, n), lvl = Math.max(0, Math.min(e - (override ? 1 : 0), a.ceiling, a.cap ?? 3));
  const why = e > a.ceiling ? "capped by risk (" + a.risk.toLowerCase() + ")" : (a.cap ?? 3) < e ? "capped by the team lead" : override ? "dropped one level after a recent override" : "earned";
  return { ...a, n, agreed, rate, earned: e, level: lvl, level_name: LEVELS[lvl], why, synthetic: rows.some((r) => r.synthetic), recent_override: override };
}
const all = () => db.prepare("SELECT id FROM actions ORDER BY ord").all().map((r) => stats(r.id));
function setCap(id, cap) { db.prepare("UPDATE actions SET cap=? WHERE id=?").run(Math.max(0, Math.min(3, Number(cap))), id); return stats(id); }

// what is the logical next step for this set? (d = agent.getPacket(id, 4))
function candidates(d) {
  const p = d.packet, out = [];
  const who = p.counterparty || p.from_addr;
  const open = d.checks.filter((c) => c.effective === "mismatch" || c.effective === "uncertain");
  const missing = d.checks.filter((c) => c.rule_id === "DOCS-REQ" && c.status === "mismatch").map((c) => c.subject);
  if (p.status === "ready" && missing.length) out.push(["REQUEST_DOC", "Ask " + who + " for the missing " + missing.join(", "), missing.length + " required document(s) not in the set"]);
  if (p.status === "ready" && open.length) out.push(["SEND_AMENDMENT", "Send the amendment to " + who, open.length + " correction(s) listed in the draft reply"]);
  if (p.status === "ready" && !open.length) out.push(["APPROVE_FORWARD", "Approve and release the set" + (p.customer ? " to " + p.customer : ""), "Every check matched"]);
  if (p.status === "replied" && p.outcome === "amendment") {
    const resent = db.prepare("SELECT COUNT(*) n FROM packets WHERE id>? AND synthetic=0 AND channel!='precheck' AND (shipment_ref=? OR from_addr=?)").get(p.id, p.shipment_ref || "-", p.from_addr).n;
    if (!resent) out.push(["REMIND_SU", "Remind " + who + " to resubmit", "Amendment sent " + (p.replied_at || "").slice(0, 16).replace("T", " ") + "; no corrected set yet", new Date(Date.parse(p.replied_at || new Date().toISOString()) + REMIND_HOURS * 36e5).toISOString()]);
  }
  const e = d.enrichment || {};
  if (p.status === "ready" && open.length && e.days_to_eta != null && e.days_to_eta <= 14) out.push(["WARN_BUYER_ETA", "Warn " + (p.customer || "the buyer") + ": papers not final, vessel due in " + e.days_to_eta + " days", open.length + " open item(s)"]);
  if (p.status === "ready" && Date.now() - Date.parse(p.received_at) > 24 * 36e5) out.push(["ESCALATE_LEAD", "Escalate to the CG team lead", "Waiting for a reply for over 24 h"]);
  const prop = db.prepare("SELECT COUNT(*) n FROM facts WHERE status='proposed' AND source LIKE ?").get("CG decision on packet " + p.id + "%").n;
  if (prop) out.push(["CONFIRM_FACT", "Confirm the rule learned from your decision", prop + " proposed fact(s) waiting for a person"]);
  return out;
}

// proposals with their level; level >= 2 schedules itself (undo window), level 3 runs at once
function forPacket(d, exec) {
  const p = d.packet, res = [];
  for (const [aid, title, detail, runAtOverride] of candidates(d)) {
    const s = stats(aid);
    let row = db.prepare("SELECT * FROM action_log WHERE packet_id=? AND action_id=? AND synthetic=0 ORDER BY id DESC LIMIT 1").get(p.id, aid);
    if (!row && s.level >= 2) {
      const runAt = runAtOverride || new Date(Date.now() + (s.level === 3 ? 0 : UNDO_MIN * 6e4)).toISOString();
      const id = db.prepare("INSERT INTO action_log(packet_id,action_id,status,title,detail,run_at) VALUES (?,?,?,?,?,?)").run(p.id, aid, "scheduled", title, detail, runAt).lastInsertRowid;
      row = db.prepare("SELECT * FROM action_log WHERE id=?").get(id);
    }
    res.push({ action: aid, title, detail, level: s.level, level_name: s.level_name, evidence: s.agreed + " of " + s.n + " past decisions agreed" + (s.synthetic ? " (demo history)" : ""), why: s.why, risk: s.risk,
      status: row ? row.status : "proposed", run_at: row ? row.run_at : null, done_at: row ? row.done_at : null, log_id: row ? row.id : null, result: row ? row.detail : null });
  }
  // steps already done or undone that are no longer candidates (keep the trail visible)
  const shown = new Set(res.map((r) => r.action));
  for (const row of db.prepare("SELECT * FROM action_log WHERE packet_id=? AND synthetic=0 ORDER BY id DESC").all(p.id)) {
    if (shown.has(row.action_id)) continue; shown.add(row.action_id);
    const s = stats(row.action_id);
    res.push({ action: row.action_id, title: row.title, detail: row.detail, level: s.level, level_name: s.level_name, evidence: s.agreed + " of " + s.n + " past decisions agreed", why: s.why, risk: s.risk, status: row.status, run_at: row.run_at, done_at: row.done_at, log_id: row.id, result: row.detail });
  }
  return res;
}

function log(packetId, actionId, status, outcome, title, detail) {
  return db.prepare("INSERT INTO action_log(packet_id,action_id,status,outcome,title,detail,done_at) VALUES (?,?,?,?,?,?,?)").run(packetId, actionId, status, outcome, title, detail, new Date().toISOString()).lastInsertRowid;
}
function finishRow(id, status, outcome, detail) { db.prepare("UPDATE action_log SET status=?, outcome=?, detail=COALESCE(?, detail), done_at=? WHERE id=?").run(status, outcome, detail, new Date().toISOString(), id); }
function undo(logId) {
  const r = db.prepare("SELECT * FROM action_log WHERE id=?").get(logId);
  if (!r || r.status !== "scheduled") return { ok: false, error: "Only a step that has not run yet can be undone" };
  finishRow(logId, "undone", "reversed", null); // a reversal is an override: it drops the action a level
  return { ok: true };
}
// run every scheduled step that is due
async function tick(exec) {
  const due = db.prepare("SELECT * FROM action_log WHERE status='scheduled' AND run_at<=? AND synthetic=0").all(new Date().toISOString());
  for (const r of due) {
    try { const detail = await exec(r.action_id, r.packet_id, r); finishRow(r.id, "done", "agreed", detail || null); }
    catch (e) { finishRow(r.id, "failed", null, "Could not run: " + e.message); }
  }
  return due.length;
}
// a person's response to a proposal is the measurement
function record(packetId, actionId, outcome, title, detail) {
  const open = db.prepare("SELECT id FROM action_log WHERE packet_id=? AND action_id=? AND synthetic=0 AND status IN ('proposed','scheduled') ORDER BY id DESC LIMIT 1").get(packetId, actionId);
  if (open) return finishRow(open.id, outcome === "rejected" ? "dismissed" : "done", outcome, detail);
  return log(packetId, actionId, outcome === "rejected" ? "dismissed" : "done", outcome, title, detail);
}
function touchless() {
  const r = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN status='done' AND outcome='agreed' AND run_at IS NOT NULL THEN 1 ELSE 0 END) auto, SUM(CASE WHEN outcome='reversed' THEN 1 ELSE 0 END) rev FROM action_log WHERE synthetic=0").get();
  return { steps: r.n || 0, automatic: r.auto || 0, reversed: r.rev || 0 };
}

module.exports = { LEVELS, UNDO_MIN, REMIND_HOURS, all, stats, setCap, forPacket, record, undo, tick, touchless };
