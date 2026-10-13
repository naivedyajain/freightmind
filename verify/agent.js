// The CG agent: packet in → read every document → verify → flag → draft a reply (never sends) → store.
const { db, J } = require("./store");
const { extract, expand, mimeOf } = require("./extract");
const { verify, docLabel, normParty } = require("./engine");

let callLLM = null, onReady = null;
function setLLM(fn) { callLLM = fn; }
function setOnReady(fn) { onReady = fn; }

const DEMURRAGE_PER_CONTAINER_DAY = Number(process.env.DEMURRAGE_USD_PER_DAY || 150); // assumed contract rate, shown as an assumption

// ---------------- intake ----------------
function createPacket(p) {
  const r = db.prepare(`INSERT INTO packets(channel,message_id,from_addr,to_addr,subject,body,received_at,status,progress_json,via)
    VALUES (@channel,@message_id,@from_addr,@to_addr,@subject,@body,@received_at,'received',@progress,@via)`).run({ via: p.via || "app",
    channel: p.channel || "email", message_id: p.message_id || null, from_addr: p.from || "", to_addr: p.to || "", subject: p.subject || "(no subject)",
    body: (p.body || "").slice(0, 4000), received_at: p.received_at || new Date().toISOString(),
    progress: JSON.stringify([{ step: "Email received", at: new Date().toISOString(), detail: (p.files || []).length + " attachment(s)" }]) });
  const id = r.lastInsertRowid;
  process_(id, p.files || []).catch((e) => { db.prepare("UPDATE packets SET status='error', error=? WHERE id=?").run(e.message, id); });
  return id;
}
const step = (id, s, detail) => {
  const p = db.prepare("SELECT progress_json FROM packets WHERE id=?").get(id);
  const list = J(p.progress_json, []); list.push({ step: s, at: new Date().toISOString(), detail });
  db.prepare("UPDATE packets SET progress_json=? WHERE id=?").run(JSON.stringify(list), id);
};

async function process_(id, rawFiles) {
  db.prepare("UPDATE packets SET status='reading' WHERE id=?").run(id);
  const files = expand(rawFiles);
  step(id, "Opened attachments", files.length + " document(s)" + (files.length > rawFiles.length ? " (incl. zipped)" : ""));
  const ins = db.prepare("INSERT INTO documents(packet_id, filename, mime, status, bytes) VALUES (?,?,?,?,?)");
  const docs = files.map((f) => ({ ...f, docId: ins.run(id, f.filename, mimeOf(f.filename), f.error ? "error" : "reading", f.bytes || null).lastInsertRowid }));
  if (!callLLM) throw new Error("No model configured");
  // read in small parallel batches
  let done = 0;
  const run = async (f) => {
    if (f.error) { db.prepare("UPDATE documents SET status='error', error=? WHERE id=?").run(f.error, f.docId); return; }
    try {
      const x = await extract(f, callLLM);
      db.prepare("UPDATE documents SET sha=?, doc_type=?, extractor=?, fields_json=?, confidence_json=?, unreadable_json=?, status='read', error=NULL WHERE id=?")
        .run(x.sha, x.doc_type, x.extractor + (x.cached ? " (cached)" : ""), JSON.stringify(x.fields), JSON.stringify(x.confidence), JSON.stringify(x.unreadable), f.docId);
    } catch (e) { db.prepare("UPDATE documents SET status='error', error=? WHERE id=?").run(e.message, f.docId); }
    done++; step(id, "Read " + f.filename, done + "/" + docs.length);
  };
  for (let i = 0; i < docs.length; i += 3) await Promise.all(docs.slice(i, i + 3).map(run));
  finish(id);
}

// classify → store connected data → verify → store checks → draft
// the same document often arrives twice (scan + PDF, or a zip sent twice): keep the best copy, mark the rest
function markDuplicates(id) {
  const docs = loadDocs(id).filter((d) => d.status === "read");
  const key = (d) => d.doc_type + ":" + (d.fields.invoice_no || d.fields.bl_no || d.fields.reference_no || d.fields.batch || d.fields.doc_no || d.fields.booking_no || "") + ":" + (d.fields.is_draft ? "draft" : "final");
  const groups = new Map();
  for (const d of docs) { const k = key(d); if (k.split(":")[1] === "") continue; (groups.get(k) || groups.set(k, []).get(k)).push(d); }
  const same = (x, y) => { const ks = new Set([...Object.keys(x.fields), ...Object.keys(y.fields)]); for (const k of ks) if (norm(x.fields[k]) !== norm(y.fields[k])) return false; return true; };
  for (const g of groups.values()) if (g.length > 1) {
    const score = (d) => (d.extractor && d.extractor.startsWith("text") ? 1 : 0) + Object.values(d.confidence || {}).reduce((a, b) => a + b, 0) / 100;
    g.sort((x, y) => score(y) - score(x));
    for (const d of g.slice(1)) if (same(d, g[0])) db.prepare("UPDATE documents SET status='duplicate', error=? WHERE id=?").run("copy of " + g[0].filename, d.id);
      else db.prepare("UPDATE documents SET error=? WHERE id=?").run("another version of " + g[0].filename + " with different content", d.id);
  }
}
function finish(id) {
  markDuplicates(id);
  const docs = loadDocs(id).filter((d) => d.status !== "duplicate");
  // documents that are "connected data" (booking, loading plan) become system records, as if they came from GoComet's systems
  for (const d of docs) if (["booking_confirmation", "loading_plan"].includes(d.doc_type)) {
    for (const k of [d.fields.invoice_ref, d.fields.bl_no, d.fields.booking_no].filter(Boolean)) db.prepare("INSERT OR REPLACE INTO system_records VALUES (?,?,?,?)").run(d.doc_type, String(k), JSON.stringify({ ...d.fields, _source: d.filename }), "loaded from file (stands in for GoComet booking / factory data)");
  }
  const inv = docs.find((d) => d.doc_type === "commercial_invoice");
  const shipmentRef = inv ? inv.fields.shipment_ref || inv.fields.invoice_no : null;
  const customer = inv ? inv.fields.sold_to_name : null;
  step(id, "Classified documents", summarizeTypes(docs));
  const checks = verify(forVerification(docs), connectedFor(docs), 4);
  db.prepare("DELETE FROM checks WHERE packet_id=?").run(id);
  const ins = db.prepare(`INSERT INTO checks(packet_id,rule_id,rule_name,subject,status,severity,level,docs_json,expected,found,confidence,explanation,path_json,customer,shipment_ref)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const c of checks) ins.run(id, c.rule_id, c.rule_name, c.subject, c.status, c.severity, c.level || 0, JSON.stringify(c.docs || []), c.expected == null ? null : String(c.expected), c.found == null ? null : String(c.found), c.confidence ?? null, c.explanation || null, JSON.stringify(c.path || []), customer, shipmentRef);
  const s = tally(checks.filter((c) => c.level === 0 || c.level == null));
  step(id, "Checked " + checks.length + " items", s.mismatch + " mismatch · " + s.uncertain + " uncertain · " + s.match + " match");
  db.prepare("UPDATE packets SET status='ready', shipment_ref=?, customer=?, summary_json=? WHERE id=?").run(shipmentRef, customer, JSON.stringify(s), id);
  step(id, "Drafted reply", s.mismatch + s.uncertain ? "amendment request" : "approval");
  if (onReady) Promise.resolve(onReady(id)).catch((e) => step(id, "Could not hand the reply to the mailbox", e.message));
}
function reverify(id) { finish(id); }

// a final document supersedes its draft; connected-data documents are not part of the set being checked
function forVerification(docs) {
  const finals = new Set(docs.filter((d) => !d.fields.is_draft).map((d) => d.doc_type));
  return docs.filter((d) => !["booking_confirmation", "loading_plan"].includes(d.doc_type) && !(d.fields.is_draft && finals.has(d.doc_type)));
}
// ---------------- reads ----------------
function loadDocs(id) {
  return db.prepare("SELECT id, filename, doc_type, extractor, fields_json, confidence_json, unreadable_json, status, error FROM documents WHERE packet_id=? ORDER BY id").all(id)
    .map((d) => ({ id: d.id, filename: d.filename, doc_type: d.doc_type, extractor: d.extractor, status: d.status, error: d.error, fields: J(d.fields_json, {}), confidence: J(d.confidence_json, {}), unreadable: J(d.unreadable_json, []) }));
}
function connectedFor(docs) {
  const keys = new Set();
  for (const d of docs) for (const k of [d.fields.shipment_ref, d.fields.invoice_no, d.fields.bl_no, d.fields.booking_no, d.fields.invoice_ref]) if (k) keys.add(String(k));
  const get = (kind) => { for (const k of keys) { const r = db.prepare("SELECT json FROM system_records WHERE kind=? AND ref=?").get(kind, k); if (r) return J(r.json); } return null; };
  return { booking: get("booking_confirmation"), loading_plan: get("loading_plan") };
}
const summarizeTypes = (docs) => { const m = {}; for (const d of docs) m[d.doc_type || "unknown"] = (m[d.doc_type || "unknown"] || 0) + 1; return Object.entries(m).map(([k, v]) => v + "× " + k.replace(/_/g, " ")).join(", "); };
function tally(cs) { const t = { match: 0, mismatch: 0, uncertain: 0, skipped: 0 }; for (const c of cs) t[c.status] = (t[c.status] || 0) + 1; return t; }

function getPacket(id, level = 0) {
  const p = db.prepare("SELECT * FROM packets WHERE id=?").get(id);
  if (!p) return null;
  const docs = loadDocs(id);
  const decisions = db.prepare("SELECT * FROM decisions WHERE packet_id=? AND synthetic=0 ORDER BY id").all(id);
  const decided = new Map(decisions.map((d) => [d.check_id, d]));
  const checks = db.prepare("SELECT * FROM checks WHERE packet_id=? AND level<=? ORDER BY id").all(id, level).map((c) => {
    const d = decided.get(c.id);
    return { ...c, docs: J(c.docs_json, []), path: J(c.path_json, []), decision: d ? { cg_status: d.cg_status, note: d.note, at: d.at } : null,
      effective: d && d.cg_status === "accepted" ? "accepted" : c.status };
  });
  const enrich = enrichment(p, docs, checks, level);
  return { packet: { ...p, progress: J(p.progress_json, []), summary: tally(checks.map((c) => ({ status: c.effective === "accepted" ? "match" : c.status }))) },
    docs, checks, enrichment: enrich, draft: J(p.draft_json) || composeDraft(p, docs, checks, enrich), learned: learnedFromAmendments(docs) };
}

function listPackets(level = 0, channelFilter) {
  const rows = db.prepare("SELECT id, channel, via, from_addr, subject, received_at, status, shipment_ref, customer, replied_at, outcome, draft_placed_at FROM packets WHERE synthetic=0 ORDER BY id DESC").all();
  return rows.filter((r) => (channelFilter ? channelFilter.includes(r.channel) : r.channel !== "precheck")).map((r) => {
    const cs = db.prepare("SELECT status FROM checks WHERE packet_id=? AND level<=?").all(r.id, level);
    const docs = loadDocs(r.id);
    const e = level >= 2 ? enrichment(r, docs, [], level) : {};
    return { ...r, summary: tally(cs), docs: docs.length, eta: e.eta || null, days_to_eta: e.days_to_eta ?? null, risk_per_day: e.risk_per_day ?? null, urgency: e.urgency ?? null };
  }).sort((a, b) => (level >= 2 ? (b.urgency || 0) - (a.urgency || 0) : 0) || b.id - a.id);
}

// ---------------- data-connected layers ----------------
function enrichment(p, docs, checks, level) {
  const out = { level };
  if (level < 1) return out;
  const con = connectedFor(docs);
  out.connected = { booking: !!con.booking, loading_plan: !!con.loading_plan, source: (con.loading_plan && con.loading_plan._source) || (con.booking && con.booking._source) || null };
  if (level < 2) return out;
  const eta = (con.loading_plan && con.loading_plan.eta) || (con.booking && con.booking.eta) || null;
  const inv = docs.find((d) => d.doc_type === "commercial_invoice");
  const asOf = parseDate(inv && inv.fields.invoice_date) || new Date(p.received_at);
  const etaD = parseDate(eta);
  if (etaD) { out.eta = etaD.toISOString().slice(0, 10); out.as_of = asOf.toISOString().slice(0, 10); out.days_to_eta = Math.round((etaD - asOf) / 864e5); out.clock_note = "Days counted from the invoice date (demo clock), since the sample shipments are from February."; }
  const open = checks.filter((c) => c.effective === "mismatch" || c.effective === "uncertain").length;
  out.urgency = etaD ? Math.max(0, 30 - out.days_to_eta) + open * 2 : open;
  if (level < 3) return out;
  const bl = docs.find((d) => d.doc_type === "bill_of_lading");
  const containers = (bl && (bl.fields.containers || []).length) || (con.loading_plan && new Set((con.loading_plan.lines || []).map((l) => l.container).filter(Boolean)).size) || 1;
  out.containers = containers;
  out.rate_per_container_day = DEMURRAGE_PER_CONTAINER_DAY;
  out.risk_per_day = open ? containers * DEMURRAGE_PER_CONTAINER_DAY : 0;
  out.cost_note = "Assumed demurrage/detention of $" + DEMURRAGE_PER_CONTAINER_DAY + " per container per day once docs miss the vessel's arrival. In production this comes from the carrier contract.";
  if (level < 4) return out;
  out.history = history(p, checks);
  return out;
}
function parseDate(s) {
  if (!s) return null; const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/); if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  m = t.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{2,4})$/); if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(m[2] + " " + m[1] + " " + y + " UTC"); }
  const d = new Date(t); return isNaN(d) ? null : d;
}

// history + autonomy: per rule, how often CG agreed with the agent (demo history is labelled synthetic)
const AUTONOMY = { min_n: 50, min_agreement: 0.99 };
function history(p, checks) {
  const rows = db.prepare("SELECT rule_id, COUNT(*) n, SUM(CASE WHEN agent_status=cg_status OR (agent_status='match' AND cg_status='accepted') THEN 1 ELSE 0 END) agree, MAX(synthetic) syn FROM decisions GROUP BY rule_id").all();
  const per = {}; for (const r of rows) per[r.rule_id] = { n: r.n, agreement: r.n ? r.agree / r.n : 0, synthetic: !!r.syn, eligible: r.n >= AUTONOMY.min_n && r.agree / r.n >= AUTONOMY.min_agreement };
  const ruleIds = [...new Set(checks.map((c) => c.rule_id))];
  const allMatch = checks.every((c) => c.effective === "match" || c.effective === "skipped" || c.effective === "accepted");
  const blocking = ruleIds.filter((r) => !(per[r] && per[r].eligible));
  return { per_rule: per, gate: AUTONOMY, would_auto_clear: allMatch && blocking.length === 0, blocking_rules: blocking, synthetic_note: "Track record seeded for the demo; in production it is every CG decision.",
    shipper_profile: shipperProfile(p) };
}
function shipperProfile(p) {
  const shipper = db.prepare("SELECT d.fields_json FROM documents d WHERE d.packet_id=? AND d.doc_type='bill_of_lading' LIMIT 1").get(p.id);
  const name = shipper ? J(shipper.fields_json, {}).shipper : null;
  const past = db.prepare("SELECT rule_name, COUNT(*) n FROM checks WHERE status IN ('mismatch','uncertain') AND packet_id IN (SELECT id FROM packets WHERE synthetic=1 AND from_addr=?) GROUP BY rule_name ORDER BY n DESC LIMIT 3").all(normParty(name || ""));
  return { shipper: name, top_issues: past, note: past.length ? "From earlier document sets (demo history)." : "No earlier document sets from this shipper yet." };
}

// ---------------- draft reply (deterministic: every line traces to a check) ----------------
function composeDraft(p, docs, checks, enrich) {
  const open = checks.filter((c) => c.effective === "mismatch");
  const unsure = checks.filter((c) => c.effective === "uncertain");
  const ref = p.shipment_ref ? "shipment " + p.shipment_ref : "your shipment";
  const cust = p.customer ? " for " + p.customer : "";
  const subject = /^re:/i.test(p.subject) ? p.subject : "Re: " + p.subject;
  const where = (c) => (c.docs || []).map((d) => d.filename).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(", ");
  let body;
  if (!open.length && !unsure.length) {
    body = `Hello,\n\nThank you for the documents for ${ref}${cust}.\n\nWe checked ${checks.filter((c) => c.status !== "skipped").length} items across ${docs.length} documents and everything matches. The set is approved and will be released to the customer.\n\nRegards,\nExport Documentation (CG)`;
  } else {
    const lines = open.map((c, i) => `${i + 1}. ${c.subject}\n   Found: ${c.found}\n   Expected: ${c.expected || "—"}\n   In: ${where(c) || "—"}`);
    const qs = unsure.map((c, i) => `${i + 1}. ${c.subject}: ${c.found}${c.expected ? " (expected " + c.expected + ")" : ""}`);
    body = `Hello,\n\nThank you for the documents for ${ref}${cust}. We can't release the set yet.\n` +
      (lines.length ? `\nPlease correct and resend:\n\n${lines.join("\n\n")}\n` : "") +
      (qs.length ? `\nPlease confirm the following, which we could not verify:\n\n${qs.join("\n")}\n` : "") +
      (enrich && enrich.days_to_eta != null ? `\nThe vessel is due on ${enrich.eta}, so corrections are needed before then to avoid delays at destination.\n` : "") +
      `\nTip: you can check your next set against this customer's requirements before sending: https://freightmind/precheck (concept)\n\nRegards,\nExport Documentation (CG)`;
  }
  return { to: p.from_addr, subject, body, kind: open.length || unsure.length ? "amendment" : "approval", generated: true };
}

// ---------------- learning from amendments: draft vs final of the same document ----------------
function learnedFromAmendments(docs) {
  const pairs = [];
  for (const t of ["bill_of_lading", "certificate_of_origin"]) {
    const ds = docs.filter((d) => d.doc_type === t);
    const drafts = ds.filter((d) => d.fields.is_draft), finals = ds.filter((d) => !d.fields.is_draft);
    const versions = [];
    for (const dr of drafts) for (const fi of finals) versions.push([dr, fi, "draft → final"]);
    for (let i = 0; i < finals.length; i++) for (let k = i + 1; k < finals.length; k++) versions.push([finals[i], finals[k], "two versions"]);
    for (const [dr, fi, kind] of versions) {
      const diffs = [];
      for (const k of Object.keys({ ...dr.fields, ...fi.fields })) {
        if (["is_draft"].includes(k)) continue;
        const a = norm(dr.fields[k]), b = norm(fi.fields[k]);
        if (a !== b && (a || b)) diffs.push({ field: k, draft: dr.fields[k], final: fi.fields[k] });
      }
      if (diffs.length) pairs.push({ doc_type: t, kind, draft: dr.filename, final: fi.filename, diffs });
    }
  }
  return pairs;
}
const norm = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).toUpperCase().replace(/[^A-Z0-9]/g, ""));

// ---------------- CG actions ----------------
function decide(packetId, checkId, cg_status, note, by = "CG") {
  const c = db.prepare("SELECT * FROM checks WHERE id=? AND packet_id=?").get(checkId, packetId);
  if (!c) throw new Error("check not found");
  db.prepare("DELETE FROM decisions WHERE packet_id=? AND check_id=? AND synthetic=0").run(packetId, checkId);
  db.prepare("INSERT INTO decisions(packet_id,check_id,rule_id,agent_status,cg_status,note,by) VALUES (?,?,?,?,?,?,?)").run(packetId, checkId, c.rule_id, c.status, cg_status, note || null, by);
  // learning loop: accepting a consignee-address difference proposes a customer rule (a human must confirm it)
  let proposed = null;
  if (cg_status === "accepted" && c.rule_id === "CNEE-MATCH" && /address/i.test(c.subject)) {
    const docs = J(c.docs_json, []);
    const bl = docs.find((d) => d.doc_type === "bill_of_lading");
    if (bl && c.customer) {
      const r = db.prepare("INSERT INTO facts(subject,predicate,object,scope,status,confidence,source,owner,visibility,valid_from) VALUES (?,?,?,?,?,?,?,?,?,date('now'))")
        .run(normParty(c.customer), "consignee_address", (bl.value || "").split(" — ").pop(), c.customer, "proposed", 0.7, "CG decision on packet " + packetId + (note ? ": " + note : ""), "CG", "shared with suppliers");
      proposed = r.lastInsertRowid;
    }
  }
  db.prepare("UPDATE packets SET draft_json=NULL WHERE id=?").run(packetId); // draft regenerates from decisions unless CG edited it
  return { ok: true, proposed_fact: proposed };
}
// what the SU agent tells its own supplier after a pre-check (sent only to the person who asked)
function precheckReply(id, cgAddress) {
  const d = getPacket(id, 1);
  const p = d.packet;
  const open = d.checks.filter((c) => c.status === "mismatch"), unsure = d.checks.filter((c) => c.status === "uncertain");
  const where = (c) => [...new Set((c.docs || []).map((x) => x.filename))].slice(0, 3).join(", ");
  const n = d.docs.filter((x) => x.status !== "duplicate").length;
  const headline = open.length ? "PRE-CHECK: " + open.length + " issue(s) will get this set rejected. Fix before sending to CG." : unsure.length ? "PRE-CHECK: ready to send; " + unsure.length + " item(s) CG may ask about." : "PRE-CHECK: ready to send. Nothing CG would reject.";
  let text = headline + "\n\nHello,\n\nI checked your " + n + " documents" + (p.customer ? " for " + p.customer : "") + " before you send them to CG.\n";
  if (open.length) text += "\nThese will get the set rejected. Please fix them first:\n\n" + open.map((c, i) => (i + 1) + ". " + c.subject + "\n   Found: " + c.found + "\n   Expected: " + (c.expected || "—") + "\n   In: " + where(c)).join("\n\n") + "\n";
  if (unsure.length) text += "\nCG is likely to ask about these. Add a line of explanation in your email:\n\n" + unsure.map((c, i) => (i + 1) + ". " + c.subject + ": " + c.found).join("\n") + "\n";
  if (!open.length && !unsure.length) text += "\nEverything matches. The set is ready for CG.\n";
  text += "\nWhen ready, send the documents to CG at " + cgAddress + ".\n\nYour document agent (FreightMind)\nAutomatic reply to your own pre-check request. Nothing was sent to CG.";
  const subject = "Pre-check: " + (open.length ? open.length + " issue(s) to fix" : unsure.length ? "ready, " + unsure.length + " item(s) to explain" : "ready to send") + " · " + (p.subject || "").replace(/^(re|fwd?):\s*/i, "");
  return { to: p.from_addr, subject, text, issues: open.length, unsure: unsure.length };
}
function notePlaced(id, mailId) { db.prepare("UPDATE packets SET draft_mail_id=?, draft_placed_at=? WHERE id=?").run(mailId, new Date().toISOString(), id); }
function markRepliedFromMail(id, at, subject) {
  const p = db.prepare("SELECT replied_at FROM packets WHERE id=?").get(id); if (!p || p.replied_at) return;
  const d = getPacket(id, 0);
  db.prepare("UPDATE packets SET status='replied', replied_at=?, outcome=? WHERE id=?").run(at, d.draft.kind || "reply", id);
  step(id, "CG sent the reply from Gmail", subject || "");
}
function saveDraft(id, draft) { db.prepare("UPDATE packets SET draft_json=? WHERE id=?").run(JSON.stringify({ ...draft, generated: false }), id); }
function markSent(id, outcome, info) { db.prepare("UPDATE packets SET status='replied', replied_at=?, outcome=? WHERE id=?").run(new Date().toISOString(), outcome, id); step(id, "Reply sent by CG", info); }

// ---------------- demo history (labelled synthetic) ----------------
function seedHistory() {
  if (db.prepare("SELECT COUNT(*) n FROM decisions WHERE synthetic=1").get().n) return;
  const plan = { "DOCS-REQ": [230, 230], "INC-VALID": [190, 190], "INC-PLACE": [190, 186], "PORT-IS-PORT": [100, 95], "POL-MATCH": [220, 220], "POD-MATCH": [220, 220],
    "CNEE-MATCH": [210, 201], "QTY-MATCH": [220, 219], "SKU-QTY": [210, 210], "WGT-MATCH": [201, 200], "HS-FORMAT": [230, 230], "HS-KNOWN": [180, 172],
    "DUP-LINE": [52, 40], "ORIGIN-MATCH": [150, 150], "COA-BATCH": [121, 120], "CNTR-MATCH": [140, 140], "VSL-MATCH": [140, 140] };
  const ins = db.prepare("INSERT INTO decisions(packet_id,check_id,rule_id,agent_status,cg_status,note,by,synthetic) VALUES (0,0,?,?,?,?,?,1)");
  db.transaction(() => { for (const [rule, [n, agree]] of Object.entries(plan)) for (let i = 0; i < n; i++) { const ok = i < agree; ins.run(rule, "match", ok ? "match" : "mismatch", ok ? null : "CG disagreed", "demo history"); } })();
}
seedHistory();

module.exports = { setLLM, setOnReady, precheckReply, notePlaced, markRepliedFromMail, step, createPacket, getPacket, listPackets, decide, saveDraft, markSent, reverify, loadDocs, tally };
