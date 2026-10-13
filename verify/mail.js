// Email as a surface: IMAP in, threaded SMTP reply out. Email stays the universal fallback channel.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const { db } = require("./store");

const cfg = () => ({
  user: process.env.MAIL_USER, pass: (process.env.MAIL_PASS || "").replace(/\s/g, ""),
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
  } catch (e) { state.lastError = e.message; try { await client.logout(); } catch (_) {} }
  state.polling = false; state.lastPoll = new Date().toISOString(); state.fetched += n;
  return { fetched: n, error: state.lastError };
}

function start(onMessage) {
  if (!configured()) return;
  const tick = () => pollOnce(onMessage).finally(() => setTimeout(tick, cfg().everyMs));
  setTimeout(tick, 3000);
}

// Reply in the same thread. Only ever called from a CG click.
async function sendReply({ to, subject, body, inReplyTo }) {
  if (!configured()) return { sent: false, simulated: true, reason: "No mailbox connected (set MAIL_USER and MAIL_PASS). Marked as sent for the demo." };
  const c = cfg();
  const t = nodemailer.createTransport({ host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, auth: { user: c.user, pass: c.pass } });
  const info = await t.sendMail({ from: c.user, to, subject, text: body, ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}) });
  return { sent: true, messageId: info.messageId };
}

const status = () => ({ configured: configured(), user: configured() ? cfg().user : null, host: cfg().imapHost, ...state, every_s: cfg().everyMs / 1000 });
module.exports = { start, pollOnce, sendReply, status, configured };
