// HTTP routes for document verification. Mounted by server.js under /api/v.
const express = require("express");
const { db, J } = require("./store");
const agent = require("./agent");
const mail = require("./mail");
const { normParty } = require("./engine");

module.exports = function mount(app, { callWithKeys }) {
  // Model key: one set in the app (memory only) wins over the server env var, then any key the browser sends.
  let appKey = null, browserKey = null;
  // reading model: "sonnet" (default) or "haiku" (20x cheaper per token); a cost/accuracy lever the economics page shows
  let reader = process.env.READER_MODEL || "sonnet";
  agent.setLLM((payload) => callWithKeys([appKey, process.env.ANTHROPIC_API_KEY, browserKey].filter(Boolean), payload, reader === "haiku" ? "fast" : null));
  const r = express.Router();
  let baseUrl = process.env.PUBLIC_URL || null; // for links inside emails
  r.use((req, res, next) => { const k = req.get("x-api-key"); if (k) browserKey = k; if (!process.env.PUBLIC_URL && req.get("host")) baseUrl = (req.get("x-forwarded-proto") || req.protocol) + "://" + req.get("host"); next(); });
  const hooks = { onMessage: agent.createPacket, onReplied: agent.markRepliedFromMail };

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
  r.get("/state", (req, res) => res.json({ packets: agent.listPackets(lvl(req)), prechecks: agent.listPackets(lvl(req), ["precheck"]).slice(0, 10), mail: mail.status(), level: lvl(req) }));
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
    agent.saveDraft(id, { to, subject, body, kind });
    try {
      if (p.channel === "email" && p.via === "email" && mail.configured()) {
        const link = baseUrl ? "\n\n— Checks behind this reply: " + baseUrl + "/verify.html#p=" + id : "";
        if (action === "send") {
          const out = await mail.deliver({ to, subject, text: body + link, inReplyTo: p.message_id, agent: "cg-click" });
          if (out.sent) agent.markSent(id, kind || "reply", "sent from FreightMind to " + to);
          return res.json(out);
        }
        const out = await mail.placeDraft({ to, subject, text: body + link, inReplyTo: p.message_id, replaceId: p.draft_mail_id });
        if (out.placed) { agent.notePlaced(id, out.draft_id); agent.step(id, "Reply draft updated in the Gmail thread", "edited by CG"); }
        return res.json({ ...out, note: "Draft updated in the Gmail thread. Send it from Gmail; we'll see it in Sent." });
      }
      const why = p.channel === "a2a" ? "Returned to the SU agent over A2A (simulated)." : "This set was uploaded, not emailed: reply recorded, not emailed.";
      agent.markSent(id, kind || "reply", why);
      res.json({ sent: false, simulated: true, reason: why });
    } catch (e) { res.status(502).json({ error: "Mailbox error: " + e.message }); }
  });

  // knowledge store: proposed vs confirmed facts; humans confirm
  r.get("/knowledge", (req, res) => res.json({
    facts: db.prepare("SELECT * FROM facts WHERE valid_to IS NULL ORDER BY CASE status WHEN 'proposed' THEN 0 ELSE 1 END, id DESC").all(),
    rules: db.prepare("SELECT id, name, check_type, severity, scope_level, scope_key, level, explain, version, owner, visibility FROM rules ORDER BY rowid").all(),
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
