// Email as a surface: IMAP in, threaded SMTP reply out. Email stays the universal fallback channel.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const { db } = require("./store");

// Credentials: env vars, or entered in the app (kept in memory only; never written to disk; gone on restart).
const runtime = { user: null, pass: null };
// Gmail's app-password screen copies invisible non-breaking spaces; keep letters and digits only.
const clean = (p) => String(p || "").replace(/[^A-Za-z0-9]/g, "");
const cfg = () => ({
  user: (runtime.user || process.env.MAIL_USER || "").trim(), pass: clean(runtime.pass || process.env.MAIL_PASS),
  imapHost: process.env.IMAP_HOST || "imap.gmail.com", imapPort: Number(process.env.IMAP_PORT || 993),
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com", smtpPort: Number(process.env.SMTP_PORT || 465),
  folder: process.env.IMAP_FOLDER || "INBOX", everyMs: Number(process.env.IMAP_POLL_MS || 30000),
});
const configured = () => !!(cfg().user && cfg().pass);
const state = { lastPoll: null, lastError: null, fetched: 0, polling: false };

async function pollOnce(onMessage) {
  if (!configured() || state.polling) return { skipped: true };
  state.polling = true;
  const c = cfg();
  const client = new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
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
        const files = (mail.attachments || []).filter((a) => a.content && a.filename).map((a) => ({ filename: a.filename, bytes: a.content }));
        if (!files.length) continue; // no documents → not a submission
        onMessage({ channel: "email", message_id: mid, from: mail.from && mail.from.value[0] && mail.from.value[0].address, to: c.user,
          subject: mail.subject, body: mail.text, received_at: (mail.date || new Date()).toISOString(), files, references: mail.references });
        n++;
      }
    } finally { lock.release(); }
    await client.logout();
    state.lastError = null;
  } catch (e) { state.lastError = (e && (e.responseText || e.message)) || String(e); try { await client.logout(); } catch (_) {} }
  state.polling = false; state.lastPoll = new Date().toISOString(); state.fetched += n;
  return { fetched: n, error: state.lastError };
}

let started = false;
function start(onMessage) {
  if (started) return; started = true;
  const tick = () => (configured() ? pollOnce(onMessage) : Promise.resolve()).finally(() => setTimeout(tick, cfg().everyMs));
  setTimeout(tick, 3000);
}

// Map Gmail's real error to the fix (from the Gmail runbook)
function hint(msg) {
  const m = String(msg || "");
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|Application-specific password/i.test(m)) return "Login rejected. Check: the app password was created for THIS Gmail account; 2-Step Verification is on; the app password wasn't revoked (new ones can take 1–2 minutes).";
  if (/web browser|IMAP.*disabled|not enabled/i.test(m)) return "IMAP is off for this account. Gmail → Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP → Save.";
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket/i.test(m)) return "Could not reach imap.gmail.com:993. The network may block it; try another network.";
  return null;
}
async function connect(user, pass, onMessage) {
  runtime.user = String(user || "").trim(); runtime.pass = pass;
  const len = clean(pass).length;
  if (len !== 16) { runtime.user = null; runtime.pass = null; return { ok: false, error: "App password has " + len + " letters/digits after cleaning; a Gmail app password has 16.", hint: "Copy the app password again (Google Account → Security → 2-Step Verification → App passwords)." }; }
  const c = cfg();
  const client = new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(c.folder);
    let total = 0; try { total = client.mailbox.exists; } finally { lock.release(); }
    await client.logout();
    state.lastError = null;
    start(onMessage);
    setTimeout(() => pollOnce(onMessage), 500);
    return { ok: true, user: c.user, inbox_messages: total };
  } catch (e) {
    const msg = (e && (e.responseText || e.message)) || String(e);
    state.lastError = msg;
    runtime.user = null; runtime.pass = null; // never keep polling with credentials that failed
    try { await client.logout(); } catch (_) {}
    return { ok: false, error: msg, hint: hint(msg) };
  }
}
function disconnect() { runtime.user = null; runtime.pass = null; state.lastError = null; }

// Reply in the same thread. Only ever called from a CG click.
async function sendReply({ to, subject, body, inReplyTo }) {
  if (!configured()) return { sent: false, simulated: true, reason: "No mailbox connected (set MAIL_USER and MAIL_PASS). Marked as sent for the demo." };
  const c = cfg();
  const msg = { from: c.user, to, subject, text: body, ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}) };
  try {
    const t = nodemailer.createTransport({ host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, auth: { user: c.user, pass: c.pass }, connectionTimeout: 12000, greetingTimeout: 12000 });
    const info = await t.sendMail(msg);
    return { sent: true, messageId: info.messageId };
  } catch (e) {
    // Some hosts block outgoing SMTP. Fall back to a Gmail draft in the same thread (IMAP works), so CG sends it from Gmail.
    try { await saveDraft(msg); return { sent: false, drafted: true, reason: "SMTP unavailable here (" + e.message + "). Saved as a Gmail draft in the same thread: open Gmail → Drafts → Send." }; }
    catch (e2) { throw new Error("SMTP failed (" + e.message + ") and saving a Gmail draft failed (" + e2.message + ")"); }
  }
}
async function saveDraft(msg) {
  const MailComposer = require("nodemailer/lib/mail-composer");
  const raw = await new Promise((res, rej) => new MailComposer(msg).compile().build((e, m) => (e ? rej(e) : res(m))));
  const c = cfg();
  const client = new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  await client.connect();
  try {
    const boxes = await client.list();
    const drafts = (boxes.find((b) => b.specialUse === "\\Drafts") || {}).path || "[Gmail]/Drafts";
    await client.append(drafts, raw, ["\\Draft"]);
  } finally { await client.logout(); }
}

const status = () => ({ configured: configured(), user: configured() ? cfg().user : null, host: cfg().imapHost, source: runtime.pass ? "entered in app (memory only)" : configured() ? "environment" : null, ...state, hint: hint(state.lastError), every_s: cfg().everyMs / 1000 });
module.exports = { start, pollOnce, sendReply, status, configured, connect, disconnect };
