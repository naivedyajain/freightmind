// HTTP routes for document verification. Mounted by server.js under /api/v.
const express = require("express");
const { db, J } = require("./store");
const agent = require("./agent");
const mail = require("./mail");
const { normParty } = require("./engine");

module.exports = function mount(app, { callWithKeys }) {
  let browserKey = null; // a key pasted in the UI is used when the server has none
  agent.setLLM((payload) => callWithKeys([process.env.ANTHROPIC_API_KEY, browserKey].filter(Boolean), payload));
  const r = express.Router();
  r.use((req, res, next) => { const k = req.get("x-api-key"); if (k) browserKey = k; next(); });
  const lvl = (req) => Math.max(0, Math.min(4, Number(req.query.level || 0)));

  r.get("/state", (req, res) => res.json({ packets: agent.listPackets(lvl(req)), mail: mail.status(), level: lvl(req) }));
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
  r.post("/packet/:id/decide", (req, res) => { try { res.json(agent.decide(Number(req.params.id), Number(req.body.check_id), req.body.cg_status, req.body.note)); } catch (e) { res.status(400).json({ error: e.message }); } });
  r.post("/packet/:id/draft", (req, res) => { agent.saveDraft(Number(req.params.id), req.body); res.json({ ok: true }); });
  r.post("/packet/:id/send", async (req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare("SELECT message_id, channel FROM packets WHERE id=?").get(id);
    const { to, subject, body, kind } = req.body || {};
    try {
      const out = p.channel === "email" ? await mail.sendReply({ to, subject, body, inReplyTo: p.message_id }) : { sent: false, simulated: true, reason: p.channel === "a2a" ? "Returned to the SU agent over A2A (simulated)." : "Uploaded set: reply shown, not emailed." };
      agent.saveDraft(id, { to, subject, body, kind });
      agent.markSent(id, kind || "reply", out.sent ? "emailed to " + to : out.reason);
      res.json(out);
    } catch (e) { res.status(502).json({ error: "Send failed: " + e.message }); }
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
  r.post("/mail/poll", async (req, res) => res.json(await mail.pollOnce(agent.createPacket)));
  r.post("/mail/connect", async (req, res) => res.json(await mail.connect(req.body.user, req.body.pass, agent.createPacket)));
  r.post("/mail/disconnect", (req, res) => { mail.disconnect(); res.json({ ok: true }); });

  app.use("/api/v", r);
  mail.start(agent.createPacket);
};
