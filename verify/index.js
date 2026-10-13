// HTTP routes for document verification. Mounted by server.js under /api/v.
const express = require("express");
const { db, J } = require("./store");
const agent = require("./agent");
const mail = require("./mail");
const { normParty, rulesFor } = require("./engine");
const deskMod = require("./desk");
const autonomy = require("./autonomy");

module.exports = function mount(app, { callWithKeys }) {
  // Model key: one set in the app (memory only) wins over the server env var, then any key the browser sends.
  let appKey = null, browserKey = null;
  // reading model: "sonnet" (default) or "haiku" (20x cheaper per token); a cost/accuracy lever the economics page shows
  let reader = process.env.READER_MODEL || "sonnet";
  agent.setLLM((payload) => callWithKeys([appKey, process.env.ANTHROPIC_API_KEY, browserKey].filter(Boolean), payload, reader === "haiku" ? "fast" : null));
  const r = express.Router();
  let baseUrl = process.env.PUBLIC_URL || null; // for links inside emails
  r.use((req, res, next) => { const k = req.get("x-api-key"); if (k) browserKey = k; if (!process.env.PUBLIC_URL && req.get("host")) baseUrl = (req.get("x-forwarded-proto") || req.protocol) + "://" + req.get("host"); next(); });
  // a reply CG sent from Gmail counts as agreeing with the agent's proposed step
  const replyAction = (kind) => (kind === "approval" ? "APPROVE_FORWARD" : "SEND_AMENDMENT");
  const hooks = { onMessage: agent.createPacket, onReplied: (id, at, subject) => {
    const before = db.prepare("SELECT replied_at FROM packets WHERE id=?").get(id);
    agent.markRepliedFromMail(id, at, subject);
    if (before && !before.replied_at) { const d = agent.getPacket(id, 0); autonomy.record(id, replyAction(d.draft.kind), "agreed", null, "sent from Gmail"); }
  } };

  // When a set is verified: CG agent puts its reply as a DRAFT in the Gmail thread; SU agent answers a pre-check.
  agent.setOnReady(async (id) => {
    const p = db.prepare("SELECT * FROM packets WHERE id=?").get(id);
    if (!p || p.via !== "email" || !mail.configured()) return;
    const link = baseUrl ? "\n\n— Checks behind this reply: " + baseUrl + "/verify.html#p=" + id : "";
    if (p.channel === "email") {
      const d = agent.getPacket(id, 4).draft;
      const out = await mail.placeDraft({ to: d.to, subject: d.subject, text: d.body + link, inReplyTo: p.message_id, replaceId: p.draft_mail_id });
      if (out.placed) { agent.notePlaced(id, out.draft_id); agent.step(id, "Reply draft placed in the Gmail thread", "waiting for CG to review and send"); }
    } else if (p.channel === "precheck") {
      const m = agent.precheckReply(id, mail.addresses().cg);
      const out = await mail.deliver({ to: m.to, subject: m.subject, text: m.text + link, inReplyTo: p.message_id, agent: "su-precheck" });
      agent.step(id, out.sent ? "Pre-check result emailed to the supplier" : "Pre-check result saved as a draft", out.sent ? m.issues + " issue(s), " + m.unsure + " to explain" : out.reason);
    }
  });
  const lvl = (req) => Math.max(0, Math.min(4, Number(req.query.level || 0)));

  async function refreshGmailDraft(id) {
    const p = db.prepare("SELECT * FROM packets WHERE id=?").get(id);
    if (!p || p.replied_at) return;
    const d = agent.getPacket(id, 4).draft;
    const link = baseUrl ? "\n\n— Checks behind this reply: " + baseUrl + "/verify.html#p=" + id : "";
    const out = await mail.placeDraft({ to: d.to, subject: d.subject, text: d.body + link, inReplyTo: p.message_id, replaceId: p.draft_mail_id });
    if (out.placed) { agent.notePlaced(id, out.draft_id); agent.step(id, "Reply draft updated in the Gmail thread", "after CG's decision"); }
  }
  r.get("/state", (req, res) => res.json({ packets: agent.listPackets(lvl(req)), prechecks: agent.listPackets(lvl(req), ["precheck"]).slice(0, 10), mail: mail.status(), desk: deskMod.desk(), level: lvl(req) }));
  // whose desk is this inbox: the supplier's CG team or the customer's. Changing it re-checks live sets (no model calls)
  // and refreshes any Gmail draft still waiting, so the reply's voice and rules follow the desk.
  r.get("/desk", (req, res) => res.json({ ...deskMod.desk(), rules: rulesFor({ home: deskMod.desk().home }) }));
  r.post("/desk", (req, res) => {
    const d = deskMod.setDesk(req.body || {});
    const ids = agent.reverifyAll();
    if (mail.configured()) for (const id of ids) {
      const p = db.prepare("SELECT channel, via, draft_mail_id, replied_at FROM packets WHERE id=?").get(id);
      if (p && p.channel === "email" && p.via === "email" && p.draft_mail_id && !p.replied_at) refreshGmailDraft(id).catch(() => {});
    }
    res.json({ ...d, rechecked: ids.length });
  });
  r.get("/packet/:id", (req, res) => { const p = agent.getPacket(Number(req.params.id), lvl(req)); p ? res.json(p) : res.status(404).json({ error: "not found" }); });
  r.get("/doc/:id/file", (req, res) => {
    const d = db.prepare("SELECT filename, mime, bytes FROM documents WHERE id=?").get(Number(req.params.id));
    if (!d || !d.bytes) return res.status(404).end();
    res.set("content-type", d.mime || "application/octet-stream").set("content-disposition", "inline; filename=\"" + d.filename.replace(/"/g, "") + "\"").send(d.bytes);
  });

  // fallback intake (and SU pre-check): files uploaded from the browser, same pipeline as email
  r.post("/upload", (req, res) => {
    const { from, subject, body, files = [], channel = "upload" } = req.body || {};
    if (!files.length) return res.status(400).json({ error: "No files" });
    const id = agent.createPacket({ channel, from: from || "su@example.com", subject: subject || "Shipment documents", body,
      message_id: channel + ":" + Date.now(), files: files.map((f) => ({ filename: f.filename, bytes: Buffer.from(f.data, "base64") })) });
    res.json({ id });
  });
  // A2A: an SU agent's pre-checked packet goes to CG; CG's agent re-verifies (verify, don't trust)
  r.post("/packet/:id/a2a", (req, res) => {
    const id = Number(req.params.id);
    db.prepare("UPDATE packets SET channel='a2a', received_at=?, status='received' WHERE id=? AND channel='precheck'").run(new Date().toISOString(), id);
    agent.reverify(id);
    res.json({ ok: true, id });
  });
  r.post("/packet/:id/reverify", (req, res) => { agent.reverify(Number(req.params.id)); res.json({ ok: true }); });
  r.post("/packet/:id/decide", (req, res) => {
    try {
      const id = Number(req.params.id);
      const out = agent.decide(id, Number(req.body.check_id), req.body.cg_status, req.body.note);
      const p = db.prepare("SELECT channel, via FROM packets WHERE id=?").get(id);
      if (p && p.channel === "email" && p.via === "email" && mail.configured()) refreshGmailDraft(id).catch(() => {}); // CG's decision updates the draft in Gmail too
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.post("/packet/:id/draft", (req, res) => { agent.saveDraft(Number(req.params.id), req.body); res.json({ ok: true }); });
  r.post("/packet/:id/send", async (req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare("SELECT * FROM packets WHERE id=?").get(id);
    const { to, subject, body, kind, action } = req.body || {};
    const gen = agent.getPacket(id, 4).draft; // what the agent proposed, to measure agreement
    const measure = () => autonomy.record(id, replyAction(kind || gen.kind), gen.generated && (body || "").trim() === (gen.body || "").trim() ? "agreed" : "edited", null, "sent by CG");
    agent.saveDraft(id, { to, subject, body, kind });
    try {
      if (p.channel === "email" && p.via === "email" && mail.configured()) {
        const link = baseUrl ? "\n\n— Checks behind this reply: " + baseUrl + "/verify.html#p=" + id : "";
        if (action === "send") {
          const out = await mail.deliver({ to, subject, text: body + link, inReplyTo: p.message_id, agent: "cg-click" });
          if (out.sent) { agent.markSent(id, kind || "reply", "sent from FreightMind to " + to); measure(); }
          return res.json(out);
        }
        const out = await mail.placeDraft({ to, subject, text: body + link, inReplyTo: p.message_id, replaceId: p.draft_mail_id });
        if (out.placed) { agent.notePlaced(id, out.draft_id); agent.step(id, "Reply draft updated in the Gmail thread", "edited by CG"); }
        return res.json({ ...out, note: "Draft updated in the Gmail thread. Send it from Gmail; we'll see it in Sent." });
      }
      const why = p.channel === "a2a" ? "Returned to the SU agent over A2A (simulated)." : "This set was uploaded, not emailed: reply recorded, not emailed.";
      agent.markSent(id, kind || "reply", why); measure();
      res.json({ sent: false, simulated: true, reason: why });
    } catch (e) { res.status(502).json({ error: "Mailbox error: " + e.message }); }
  });

  // ---------- measure & automate: the logical next step on each set ----------
  async function execAction(aid, pid, row) {
    const d = agent.getPacket(pid, 4), p = d.packet, D = deskMod.desk();
    const viaMail = p.via === "email" && mail.configured();
    const link = baseUrl ? "\n\n— Checks behind this message: " + baseUrl + "/verify.html#p=" + pid : "";
    const sign = "\n\nRegards,\n" + D.team + ", " + D.home;
    const ref = p.shipment_ref ? "shipment " + p.shipment_ref : "your shipment";
    const send = async (subject, text) => {
      if (!viaMail) return false;
      const out = await mail.deliver({ to: p.from_addr, subject, text: text + link, inReplyTo: p.message_id, agent: "next-step" });
      if (!out.sent && !out.drafted) throw new Error(out.reason || "mail not sent");
      return true;
    };
    if (aid === "SEND_AMENDMENT" || aid === "APPROVE_FORWARD") {
      const dr = d.draft, sent = await send(dr.subject, dr.body);
      agent.markSent(pid, dr.kind || "reply", sent ? "sent by the next-step action to " + dr.to : "recorded (this set was not emailed)");
      return sent ? "Sent to " + dr.to : "Recorded; this set was uploaded, not emailed";
    }
    if (aid === "REMIND_SU") {
      const sent = await send("Reminder: corrected documents for " + ref, "Hello,\n\nA quick reminder: we are still waiting for the corrected documents for " + ref + ". The list of corrections is in our earlier email in this thread." + sign);
      agent.step(pid, "Reminder sent to " + p.from_addr, "next-step action, no resubmission yet");
      return sent ? "Reminder emailed to " + p.from_addr : "Reminder recorded (set was not emailed)";
    }
    if (aid === "REQUEST_DOC") {
      const sent = await send("Missing document for " + ref, "Hello,\n\n" + (row && row.title ? row.title.replace(/^Ask .* for the /, "We are missing the ") : "A required document is missing") + ". Please send it in this thread so we can complete the check." + sign);
      agent.step(pid, "Missing document requested", p.from_addr);
      return sent ? "Request emailed to " + p.from_addr : "Request recorded (set was not emailed)";
    }
    if (aid === "CONFIRM_FACT") {
      const n = db.prepare("UPDATE facts SET status='confirmed', source=source || ' · confirmed via next step' WHERE status='proposed' AND source LIKE ?").run("CG decision on packet " + pid + "%").changes;
      return "Confirmed " + n + " fact(s)";
    }
    const what = aid === "ESCALATE_LEAD" ? "Escalated to the CG team lead" : "Buyer warned about papers not final before arrival";
    agent.step(pid, what, "in-app notification (demo channel)");
    return what + " (in-app)";
  }
  setInterval(() => autonomy.tick(execAction).catch(() => {}), 30000);
  r.get("/packet/:id/next", (req, res) => {
    const d = agent.getPacket(Number(req.params.id), 4);
    if (!d) return res.status(404).json({ error: "not found" });
    res.json({ steps: d.packet.status === "ready" || d.packet.status === "replied" ? autonomy.forPacket(d) : [], undo_min: autonomy.UNDO_MIN, remind_hours: autonomy.REMIND_HOURS });
  });
  r.post("/packet/:id/next/:action", async (req, res) => {
    const id = Number(req.params.id), aid = req.params.action, op = (req.body || {}).op;
    try {
      if (op === "undo") return res.json(autonomy.undo(Number(req.body.log_id)));
      const d = agent.getPacket(id, 4), step = autonomy.forPacket(d).find((x) => x.action === aid);
      if (op === "dismiss") { autonomy.record(id, aid, "rejected", step && step.title, "dismissed by CG"); return res.json({ ok: true }); }
      const detail = await execAction(aid, id, step);
      autonomy.record(id, aid, "agreed", step && step.title, detail);
      res.json({ ok: true, detail });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  r.get("/autonomy", (req, res) => res.json({ actions: autonomy.all(), levels: autonomy.LEVELS, undo_min: autonomy.UNDO_MIN, touchless: autonomy.touchless() }));
  r.post("/autonomy/:id", (req, res) => res.json(autonomy.setCap(req.params.id, req.body.cap)));

  // knowledge store: proposed vs confirmed facts; humans confirm
  r.get("/knowledge", (req, res) => res.json({
    facts: db.prepare("SELECT * FROM facts WHERE valid_to IS NULL ORDER BY CASE status WHEN 'proposed' THEN 0 ELSE 1 END, id DESC").all(),
    rules: db.prepare("SELECT id, name, check_type, severity, scope_level, scope_key, level, explain, version, owner, visibility, party FROM rules ORDER BY rowid").all(),
    doc_types: db.prepare("SELECT id, name, description, connected_data, required_in_packet FROM doc_types").all(),
    aliases: db.prepare("SELECT kind, COUNT(*) n FROM aliases GROUP BY kind").all() }));
  r.post("/knowledge/:id", (req, res) => {
    const s = req.body.status; if (!["confirmed", "rejected"].includes(s)) return res.status(400).json({ error: "bad status" });
    db.prepare("UPDATE facts SET status=?, source=source || ' · ' || ? WHERE id=?").run(s, s + " by " + (req.body.by || "CG lead") + " " + new Date().toISOString().slice(0, 10), Number(req.params.id));
    res.json({ ok: true });
  });

  // customer view: every shipment, document status vs arrival
  r.get("/customer", (req, res) => res.json({ shipments: agent.listPackets(3, ["email", "upload", "a2a"]).map((p) => ({
    id: p.id, shipment_ref: p.shipment_ref, customer: p.customer, eta: p.eta, days_to_eta: p.days_to_eta, risk_per_day: p.risk_per_day,
    status: p.status === "replied" ? (p.outcome === "approval" ? "cleared" : "amendment requested") : p.status === "ready" ? "with CG" : "being read",
    open: (p.summary.mismatch || 0) + (p.summary.uncertain || 0) })) }));

  // metrics the CG lead watches (live packets; baseline labelled as assumed)
  r.get("/metrics", (req, res) => {
    const live = db.prepare("SELECT received_at, replied_at, outcome FROM packets WHERE synthetic=0 AND channel!='precheck'").all();
    const mins = live.filter((x) => x.replied_at).map((x) => (new Date(x.replied_at) - new Date(x.received_at)) / 6e4).sort((a, b) => a - b);
    const med = mins.length ? mins[Math.floor(mins.length / 2)] : null;
    const overrides = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN agent_status='match' AND cg_status!='match' AND cg_status!='accepted' THEN 1 ELSE 0 END) bad FROM decisions WHERE synthetic=0").get();
    res.json({ median_minutes_to_reply: med, replied: mins.length, received: live.length, baseline_hours_note: "Today: 4–24 hours per amendment cycle (from the brief).",
      match_overridden: overrides.bad || 0, decisions: overrides.n || 0, guardrail: "Agent said match, CG changed it: must stay at 0." });
  });

  r.get("/mail", (req, res) => res.json(mail.status()));
  r.post("/mail/poll", async (req, res) => res.json(await mail.pollOnce(hooks)));
  r.post("/mail/connect", async (req, res) => res.json(await mail.connect(req.body.user, req.body.pass, hooks)));
  // model key: test with a tiny call before accepting it
  const oc = require("./outcomes");
  r.get("/outcomes", (req, res) => res.json(oc.outcomes(req.query.party || "customer", req.query.demo !== "0", req.query.who || null)));
  r.get("/terms", (req, res) => res.json(oc.terms()));
  r.post("/terms", (req, res) => res.json(oc.setTerms(req.body || {})));
  r.get("/economics", (req, res) => res.json({ ...require("./usage").summary(), reader }));
  r.post("/reader", (req, res) => { reader = req.body.reader === "haiku" ? "haiku" : "sonnet"; res.json({ reader }); });
  r.get("/model", (req, res) => res.json({ reader, app_key: !!appKey, env_key: !!process.env.ANTHROPIC_API_KEY, browser_key: !!browserKey }));
  r.post("/model", async (req, res) => {
    const k = String((req.body && req.body.key) || "").replace(/[\s"']/g, "");
    if (!k) { appKey = null; return res.json({ ok: true, cleared: true }); }
    try { await callWithKeys([k], { max_tokens: 5, messages: [{ role: "user", content: "Reply OK" }] }); appKey = k; res.json({ ok: true }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  r.post("/packet/:id/retry", (req, res) => { agent.retry(Number(req.params.id)).catch(() => {}); res.json({ ok: true }); });
  r.post("/mail/disconnect", (req, res) => { mail.disconnect(); res.json({ ok: true }); });
  // send relay: save, then send a test message to the mailbox itself so the user sees it work
  r.post("/mail/relay", async (req, res) => {
    mail.setRelay(req.body.url, req.body.secret);
    if (!req.body.url) return res.json({ ok: true, cleared: true });
    if (!mail.configured()) return res.json({ ok: true, note: "Saved. Connect the mailbox to test it." });
    try { await mail.relaySend({ to: mail.addresses().cg, subject: "FreightMind: send relay works", text: "This test came through the Apps Script relay. Pre-check replies will now reach suppliers." }); res.json({ ok: true, tested: true }); }
    catch (e) { mail.setRelay(null); res.json({ ok: false, error: e.message }); }
  });

  app.use("/api/v", r);
  mail.start(hooks);
};
