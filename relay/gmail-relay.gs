// FreightMind send relay. Deploy in the CG Gmail account:
// script.google.com → New project → paste this → Deploy → New deployment → Web app
//   Execute as: Me · Who has access: Anyone → Deploy → authorise → copy the Web app URL.
// Optional: set SECRET here and type the same secret in FreightMind.
const SECRET = "";

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (SECRET && d.secret !== SECRET) return out({ ok: false, error: "wrong secret" });
    if (d.inReplyTo) {
      // reply inside the supplier's own thread
      const threads = GmailApp.search("rfc822msgid:" + String(d.inReplyTo).replace(/[<>]/g, ""), 0, 1);
      if (threads.length) {
        const msgs = threads[0].getMessages();
        msgs[msgs.length - 1].reply(d.text);
        return out({ ok: true, threaded: true });
      }
    }
    GmailApp.sendEmail(d.to, d.subject, d.text);
    return out({ ok: true, threaded: false });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
