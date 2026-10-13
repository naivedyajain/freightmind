// Email as the surface. One mailbox can host several agents via plus-addressing:
//   name@gmail.com            → CG agent (verify → draft reply in the thread; CG sends from Gmail)
//   name+precheck@gmail.com   → SU agent (pre-check → reply to the supplier before they submit)
// Permissions: the CG agent only ever DRAFTS (it cannot email an external party on its own).
// The SU agent replies to the supplier who asked it (its own user), which is the only automatic send.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { db } = require("./store");

// Credentials: env vars, or entered in the app (kept in memory only; never written to disk; gone on restart).
const runtime = { user: null, pass: null, relay: null, relaySecret: null };
// Outgoing relay over HTTPS (a Google Apps Script web app in the same Gmail account): works where hosts block SMTP.
const relayUrl = () => runtime.relay || process.env.MAIL_RELAY_URL || null;
const relaySecret = () => runtime.relaySecret || process.env.MAIL_RELAY_SECRET || "";
function setRelay(url, secret) { runtime.relay = url ? String(url).trim() : null; runtime.relaySecret = secret ? String(secret).trim() : null; }
async function relaySend({ to, subject, text, inReplyTo }) {
  const r = await fetch(relayUrl(), { method: "POST", headers: { "content-type": "application/json" }, redirect: "follow",
    body: JSON.stringify({ secret: relaySecret(), to, subject, text, inReplyTo: inReplyTo || null }) });
  const body = await r.text();
  let j; try { j = JSON.parse(body); } catch (_) { throw new Error("relay did not return JSON (HTTP " + r.status + "). Check the web app is deployed with access: Anyone. " + body.slice(0, 120)); }
  if (!j.ok) throw new Error("relay: " + (j.error || "failed"));
  return j;
}
// Gmail's app-password screen copies invisible non-breaking spaces; keep letters and digits only.
const clean = (p) => String(p || "").replace(/[^A-Za-z0-9]/g, "");
const cfg = () => ({
  user: (runtime.user || process.env.MAIL_USER || "").trim().toLowerCase(), pass: clean(runtime.pass || process.env.MAIL_PASS),
  imapHost: process.env.IMAP_HOST || "imap.gmail.com", imapPort: Number(process.env.IMAP_PORT || 993),
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  folder: process.env.IMAP_FOLDER || "INBOX", everyMs: Number(process.env.IMAP_POLL_MS || 20000),
});
const configured = () => !!(cfg().user && cfg().pass);
const state = { lastPoll: null, lastError: null, fetched: 0, polling: false, lastSentScan: null };
const addresses = () => { const u = cfg().user; if (!u) return null; const [n, d] = u.split("@"); return { cg: u, precheck: n + "+precheck@" + d }; };
const imap = () => { const c = cfg(); return new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: true, auth: { user: c.user, pass: c.pass }, logger: false }); };
const AGENT_HEADER = "X-FreightMind-Agent";

function roleOf(mail) {
  const all = [mail.to, mail.cc].filter(Boolean).flatMap((x) => x.value || []).map((a) => (a.address || "").toLowerCase());
  for (const h of ["delivered-to", "x-original-to"]) { const v = mail.headers.get(h); if (v) all.push(String(v.text || v).toLowerCase()); }
  return all.some((a) => a.includes("+precheck@")) ? "precheck" : "cg";
}

async function pollOnce(hooks) {
  if (!configured() || state.polling) return { skipped: true };
  state.polling = true;
  const c = cfg();
  const client = imap();
  let n = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(c.folder);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const mid = mail.messageId || "uid:" + uid;
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); // mark first, so a crash never processes twice
        if (db.prepare("SELECT 1 FROM packets WHERE message_id=?").get(mid)) continue;
        const from = (mail.from && mail.from.value[0] && mail.from.value[0].address || "").toLowerCase();
        // loop guards: never react to our own agents or to automatic mail
        if (mail.headers.get(AGENT_HEADER.toLowerCase()) || /auto-replied|auto-generated/i.test(String(mail.headers.get("auto-submitted") || ""))) continue;
        if (from === c.user && roleOf(mail) === "cg") continue;
        const files = (mail.attachments || []).filter((a) => a.content && a.filename && !/^packet\.json$/i.test(a.filename)).map((a) => ({ filename: a.filename, bytes: a.content }));
        if (!files.length) continue; // no documents → not a submission
        const role = roleOf(mail);
        hooks.onMessage({ channel: role === "precheck" ? "precheck" : "email", message_id: mid, from, to: role === "precheck" ? addresses().precheck : c.user,
          subject: mail.subject, body: mail.text, received_at: (mail.date || new Date()).toISOString(), files, via: "email" });
        n++;
      }
    } finally { lock.release(); }
    await scanSent(client, hooks).catch(() => {});
    await client.logout();
    state.lastError = null;
  } catch (e) { state.lastError = (e && (e.responseText || e.message)) || String(e); try { await client.logout(); } catch (_) {} }
  state.polling = false; state.lastPoll = new Date().toISOString(); state.fetched += n;
  return { fetched: n, error: state.lastError };
}

// CG sends from Gmail as always; we see it in Sent and record the reply time (the north-star metric).
async function scanSent(client, hooks) {
  const open = db.prepare("SELECT id, message_id FROM packets WHERE channel='email' AND replied_at IS NULL AND message_id LIKE '<%'").all();
  if (!open.length) return;
  const byMid = new Map(open.map((p) => [p.message_id, p.id]));
  const boxes = await client.list();
  const sent = (boxes.find((b) => b.specialUse === "\\Sent") || {}).path || "[Gmail]/Sent Mail";
  const lock = await client.getMailboxLock(sent);
  try {
    const since = new Date(Date.now() - 3 * 864e5);
    for await (const m of client.fetch({ since }, { envelope: true })) {
      const irt = m.envelope && m.envelope.inReplyTo;
      if (irt && byMid.has(irt)) { hooks.onReplied(byMid.get(irt), (m.envelope.date || new Date()).toISOString(), m.envelope.subject); byMid.delete(irt); }
    }
  } finally { lock.release(); }
  state.lastSentScan = new Date().toISOString();
}

let started = false;
function start(hooks) {
  if (started) return; started = true;
  const tick = () => (configured() ? pollOnce(hooks) : Promise.resolve()).finally(() => setTimeout(tick, cfg().everyMs));
  setTimeout(tick, 3000);
}

// Map Gmail's real error to the fix (from the Gmail runbook)
function hint(msg) {
  const m = String(msg || "");
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|Application-specific password/i.test(m)) return "Login rejected. Check: the app password was created for THIS Gmail account; 2-Step Verification is on; the app password wasn't revoked (new ones can take 1–2 minutes).";
  if (/web browser|IMAP.*disabled|not enabled/i.test(m)) return "IMAP is off for this account. Gmail → Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP → Save.";
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket/i.test(m)) return "Could not reach the mail server. The network may block it; try another network.";
  return null;
}
async function connect(user, pass, hooks) {
  runtime.user = String(user || "").trim(); runtime.pass = pass;
  const len = clean(pass).length;
  if (len !== 16) { runtime.user = null; runtime.pass = null; return { ok: false, error: "App password has " + len + " letters/digits after cleaning; a Gmail app password has 16.", hint: "Copy the app password again (Google Account → Security → 2-Step Verification → App passwords)." }; }
  const c = cfg();
  const client = imap();
  try {
    await client.connect();
    const lock = await client.getMailboxLock(c.folder);
    let total = 0; try { total = client.mailbox.exists; } finally { lock.release(); }
    await client.logout();
    state.lastError = null;
    start(hooks);
    setTimeout(() => pollOnce(hooks), 500);
    return { ok: true, user: c.user, inbox_messages: total, addresses: addresses() };
  } catch (e) {
    const msg = (e && (e.responseText || e.message)) || String(e);
    state.lastError = msg;
    runtime.user = null; runtime.pass = null; // never keep polling with credentials that failed
    try { await client.logout(); } catch (_) {}
    return { ok: false, error: msg, hint: hint(msg) };
  }
}
function disconnect() { runtime.user = null; runtime.pass = null; state.lastError = null; }

const build = (msg) => new Promise((res, rej) => new MailComposer(msg).compile().build((e, m) => (e ? rej(e) : res(m))));
const newId = () => "<fm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "@freightmind>";

// Put a reply draft into the sender's thread in Gmail (replacing our previous draft for that packet).
async function placeDraft({ to, subject, text, inReplyTo, replaceId, attachments }) {
  if (!configured()) return { placed: false, reason: "No mailbox connected" };
  const id = newId();
  const raw = await build({ from: cfg().user, to, subject, text, messageId: id, headers: { [AGENT_HEADER]: "cg-draft" }, attachments, ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}) });
  const client = imap();
  await client.connect();
  try {
    const boxes = await client.list();
    const drafts = (boxes.find((b) => b.specialUse === "\\Drafts") || {}).path || "[Gmail]/Drafts";
    if (replaceId) {
      const lock = await client.getMailboxLock(drafts);
      try { const old = await client.search({ header: { "message-id": replaceId } }, { uid: true }); if (old && old.length) await client.messageDelete(old, { uid: true }); } finally { lock.release(); }
    }
    await client.append(drafts, raw, ["\\Draft"]);
  } finally { await client.logout(); }
  return { placed: true, draft_id: id };
}

// Direct send: used by the SU agent replying to its own user, or when CG explicitly clicks "Send from here".
async function deliver({ to, subject, text, inReplyTo, attachments, agent }) {
  if (!configured()) return { sent: false, reason: "No mailbox connected" };
  const c = cfg();
  if (relayUrl()) {
    try { const j = await relaySend({ to, subject, text, inReplyTo }); return { sent: true, via: "relay", threaded: !!j.threaded }; }
    catch (e) { state.lastRelayError = e.message; }
  }
  const msg = { from: c.user, to, subject, text, attachments, headers: { [AGENT_HEADER]: agent || "cg", "Auto-Submitted": agent === "su-precheck" ? "auto-replied" : "no" }, ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}) };
  let lastErr;
  for (const [port, secure] of [[465, true], [587, false]]) {
    try {
      const t = nodemailer.createTransport({ host: c.smtpHost, port, secure, auth: { user: c.user, pass: c.pass }, connectionTimeout: 10000, greetingTimeout: 10000 });
      const info = await t.sendMail(msg);
      return { sent: true, messageId: info.messageId };
    } catch (e) { lastErr = e; }
  }
  // outgoing SMTP blocked by the host: leave it as a draft in the thread instead
  const d = await placeDraft({ to, subject, text, inReplyTo, attachments });
  state.smtpBlocked = true;
  return { sent: false, drafted: d.placed, reason: (relayUrl() ? "Relay failed (" + state.lastRelayError + ") and outgoing" : "Outgoing") + " mail is blocked on this server (" + (lastErr && lastErr.message) + "). Saved as a Gmail draft in the thread: open Gmail → Drafts → Send. Fix: connect the send relay." };
}

const status = () => ({ relay: !!relayUrl(), relay_error: state.lastRelayError || null, smtp_blocked: !!state.smtpBlocked, configured: configured(), user: configured() ? cfg().user : null, addresses: configured() ? addresses() : null, mode: "drafts-only for CG",
  host: cfg().imapHost, source: runtime.pass ? "entered in app (memory only)" : configured() ? "environment" : null, ...state, hint: hint(state.lastError), every_s: cfg().everyMs / 1000 });
module.exports = { start, pollOnce, status, configured, connect, disconnect, placeDraft, deliver, addresses, setRelay, relaySend };
