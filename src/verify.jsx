// FreightMind · Document Verification UI (CG inbox, SU pre-check, customer view, knowledge store)
const { useState, useEffect, useRef } = React;
const API = "/api/v";
const KEY_LS = "fm_key";
const getKey = () => { try { return sessionStorage.getItem(KEY_LS) || ""; } catch (_) { return ""; } };
const hdrs = () => ({ "content-type": "application/json", ...(getKey() ? { "x-api-key": getKey() } : {}) });
const get = (p) => fetch(API + p, { headers: hdrs() }).then((r) => r.json());
const post = (p, b) => fetch(API + p, { method: "POST", headers: hdrs(), body: JSON.stringify(b || {}) }).then((r) => r.json());
const money = (n) => "$" + Number(n || 0).toLocaleString();
const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 6e4); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
const toB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });

const LEVELS = [
  { n: 0, label: "Documents only", hint: "Rulebook + the attachments" },
  { n: 1, label: "+ Booking & loading plan", hint: "Containers, batches, vessel" },
  { n: 2, label: "+ ETA", hint: "Urgency by arrival" },
  { n: 3, label: "+ Cost of delay", hint: "$ at risk per day" },
  { n: 4, label: "+ History", hint: "Track record, auto-clear" },
];
const ST = { match: ["✓", "ok", "Match"], mismatch: ["✗", "bad", "Mismatch"], uncertain: ["?", "warn", "Uncertain"], skipped: ["·", "muted", "Not checked"], accepted: ["✓", "ok", "Accepted by CG"] };
const DOC = { commercial_invoice: "Invoice", packing_list: "Packing list", bill_of_lading: "BL", certificate_of_origin: "COO", certificate_of_analysis: "COA", booking_confirmation: "Booking", loading_plan: "Loading plan", other: "Other" };

function App() {
  const [view, setView] = useState("cg");
  const [level, setLevel] = useState(0);
  const [state, setState] = useState({ packets: [], mail: {} });
  const [sel, setSel] = useState(null);
  const [toast, setToast] = useState(null);
  const say = (t) => { setToast(t); setTimeout(() => setToast(null), 3500); };
  const refresh = () => get("/state?level=" + level).then(setState).catch(() => {});
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [level]);
  useEffect(() => { const m = (window.location.hash || "").match(/p=(\d+)/); if (m) setSel(Number(m[1])); }, []);
  useEffect(() => { if (!sel && state.packets.length) setSel(state.packets[0].id); }, [state.packets.length]);
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><b>FreightMind</b><span>Document verification</span></div>
        <nav className="views">
          {[["cg", "CG · Validator"], ["su", "SU · Supplier"], ["customer", "Customer"], ["knowledge", "Knowledge store"]].map(([k, l]) => (
            <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>))}
          <span className="demo-tag" title="In the product, each party signs in to its own organisation. This switch is for the demo.">demo switcher</span>
        </nav>
        <div className="right">
          <MailPill mail={state.mail} onPoll={() => post("/mail/poll").then((r) => { say(r.skipped ? "Mailbox not connected" : r.error ? "Mailbox error: " + r.error : r.fetched + " new email(s)"); refresh(); })} />
          <a className="link" href="/" title="Part 1: ask questions over all of this data">Ask the data ↗</a>
        </div>
      </header>
      <div className="levels">
        <span className="lv-label">Data connected</span>
        {LEVELS.map((l) => <button key={l.n} className={"lv" + (level >= l.n ? " on" : "")} onClick={() => setLevel(l.n)} title={l.hint}>{l.label}</button>)}
        <span className="lv-note">{LEVELS[level].hint}. Same documents; more data changes what the agent can check and how it ranks the work.</span>
      </div>
      {view === "cg" && <CG state={state} level={level} sel={sel} setSel={setSel} refresh={refresh} say={say} />}
      {view === "su" && <SU level={level} say={say} prechecks={state.prechecks || []} mail={state.mail} goCG={(id) => { setView("cg"); setSel(id); refresh(); }} />}
      {view === "customer" && <Customer />}
      {view === "knowledge" && <Knowledge say={say} />}
      {toast && <div className="toast">{toast}</div>}
    </div>);
}

function MailPill({ mail, onPoll }) {
  const [open, setOpen] = useState(false);
  const pill = !mail || !mail.configured
    ? <button className="pill muted" onClick={() => setOpen(true)}>Connect mailbox</button>
    : <span className="pillwrap"><button className={"pill " + (mail.lastError ? "bad" : "ok")} onClick={onPoll} title={mail.lastError ? "Gmail said: " + mail.lastError : "Polling every " + mail.every_s + "s. Click to check now."}>
        ● {mail.user} {mail.lastError ? "· error" : mail.lastPoll ? "· checked " + ago(mail.lastPoll) : "· connecting"}</button>
        <button className="pill muted" onClick={() => setOpen(true)} title="Change mailbox">⚙</button></span>;
  return <>{pill}{open && <MailConnect mail={mail} onClose={() => setOpen(false)} />}</>;
}
const RELAY_CODE = `const SECRET = "";
function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (SECRET && d.secret !== SECRET) return out({ ok: false, error: "wrong secret" });
    if (d.inReplyTo) {
      const t = GmailApp.search("rfc822msgid:" + String(d.inReplyTo).replace(/[<>]/g, ""), 0, 1);
      if (t.length) { const m = t[0].getMessages(); m[m.length - 1].reply(d.text); return out({ ok: true, threaded: true }); }
    }
    GmailApp.sendEmail(d.to, d.subject, d.text);
    return out({ ok: true, threaded: false });
  } catch (err) { return out({ ok: false, error: String(err) }); }
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }`;
function ModelKey() {
  const [k, setK] = useState(""), [r, setR] = useState(null), [st, setSt] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => { get("/model").then(setSt); }, []);
  const save = () => { setBusy(true); post("/model", { key: k }).then((x) => { setBusy(false); setR(x); get("/model").then(setSt); }); };
  return (
    <details className="relay" open={st && !st.app_key}>
      <summary>AI model key {st && st.app_key ? <span className="tag ok">set in app</span> : <span className="tag warn">uses server key</span>}</summary>
      <p className="sub">Used to read documents. Kept in server memory only and tested before it's accepted. Overrides the server's key.</p>
      <label>Anthropic API key<input type="password" value={k} onChange={(e) => setK(e.target.value)} placeholder="sk-ant-…" /></label>
      <div className="row2"><button className="btn primary" disabled={!k || busy} onClick={save}>{busy ? "Testing…" : "Save and test"}</button></div>
      {r && (r.ok ? <div className="rhint">Key works. Use Retry on any set that stopped.</div> : <div className="err"><b>Key rejected:</b> {r.error}</div>)}
    </details>);
}
function Relay({ mail }) {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = () => { setBusy(true); post("/mail/relay", { url, secret }).then((x) => { setBusy(false); setR(x); }); };
  return (
    <details className="relay" open={!!mail.smtp_blocked && !mail.relay}>
      <summary>Outgoing email {mail.relay ? <span className="tag ok">relay connected</span> : mail.smtp_blocked ? <span className="tag bad">blocked on this server</span> : <span className="tag muted">optional</span>}</summary>
      <p className="sub">Pre-check replies are sent to suppliers. Some hosts block outgoing mail, so send through your own Gmail over HTTPS instead (3 minutes, free):</p>
      <ol className="sub steps2">
        <li>Signed in as {mail.user}, open <a href="https://script.google.com/home/projects/create" target="_blank">script.google.com → New project</a></li>
        <li>Replace the code with this, then Save: <button className="btn ghost sm" onClick={() => { try { navigator.clipboard.writeText(RELAY_CODE); } catch (_) {} }}>Copy code</button></li>
        <li>Deploy → New deployment → type <b>Web app</b> · Execute as <b>Me</b> · Who has access <b>Anyone</b> → Deploy → Authorise</li>
        <li>Copy the <b>Web app URL</b> and paste it here:</li>
      </ol>
      <pre className="code">{RELAY_CODE}</pre>
      <label>Web app URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://script.google.com/macros/s/…/exec" /></label>
      <div className="row2"><button className="btn primary" disabled={!url || busy} onClick={save}>{busy ? "Testing…" : "Save and send a test"}</button></div>
      {r && (r.ok ? <div className="rhint">{r.tested ? "Test email sent to " + mail.user + " through the relay. Pre-check replies will now go out." : r.note || "Saved."}</div> : <div className="err"><b>Relay error:</b> {r.error}</div>)}
    </details>);
}
function MailConnect({ mail, onClose }) {
  const [user, setUser] = useState((mail && mail.user) || "");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState(null);
  const go = () => { setBusy(true); setR(null); post("/mail/connect", { user, pass }).then((x) => { setBusy(false); setR(x); if (x.ok) setTimeout(onClose, 6000); }); };
  return (
    <div className="drawer-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>Connect the CG mailbox</h3>
      <p className="sub">The agent reads new emails with attachments over IMAP and replies in the same thread over SMTP, only when you click Send. The password is kept in server memory only: not saved, and cleared on restart.</p>
      <label>Gmail address<input value={user} onChange={(e) => setUser(e.target.value)} placeholder="cg-team@gmail.com" /></label>
      <label>App password (16 characters; spaces are fine)<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
      {r && (r.ok ? <div className="rhint">Connected to {r.user} ({r.inbox_messages} messages). New emails with attachments are picked up every 20 seconds.<br /><br />
          <b>Suppliers send documents to</b> {r.addresses.cg}: the CG agent checks them and leaves a draft reply in the thread.<br />
          <b>Suppliers pre-check at</b> {r.addresses.precheck}: the supplier's agent replies with what to fix. Nothing goes to CG.</div>
        : <div className="err"><b>Gmail said:</b> {r.error}{r.hint && <><br /><b>Fix:</b> {r.hint}</>}</div>)}
      <ModelKey />
      {mail && mail.configured && <Relay mail={mail} />}
      {mail && mail.lastError && !r && <div className="err"><b>Last error:</b> {mail.lastError}{mail.hint && <><br /><b>Fix:</b> {mail.hint}</>}</div>}
      <div className="row2"><button className="btn ghost" onClick={onClose}>Close</button>{mail && mail.configured && <button className="btn ghost" onClick={() => post("/mail/disconnect").then(onClose)}>Disconnect</button>}
        <button className="btn primary" disabled={!user || !pass || busy} onClick={go}>{busy ? "Testing login…" : "Connect"}</button></div>
    </div></div>);
}

// ======================= CG =======================
function CG({ state, level, sel, setSel, refresh, say }) {
  const [up, setUp] = useState(false);
  const [metrics, setMetrics] = useState(null);
  useEffect(() => { get("/metrics").then(setMetrics); }, [state.packets.length]);
  return (
    <div className="cg">
      <aside className="inbox">
        <div className="inbox-head"><b>Inbox</b><span>{state.packets.length} document set(s){level >= 2 ? " · sorted by urgency" : " · newest first"}</span></div>
        {state.mail && state.mail.configured ? <div className="addr">
          <div><span>Suppliers send documents to</span><b>{state.mail.addresses.cg}</b></div>
          <div><span>Pre-check before sending</span><b>{state.mail.addresses.precheck}</b></div>
          <i>Replies wait as drafts in the Gmail thread. CG sends from Gmail as always.</i>
          {state.mail.smtp_blocked && !state.mail.relay && <i className="bad-t">Pre-check replies can't leave this server. Click ⚙ (top right) → Outgoing email.</i>}
        </div> : <div className="addr muted"><i>Connect the mailbox (top right) to receive documents by email. Or upload a set:</i></div>}
        <button className="btn ghost full" onClick={() => setUp(true)}>+ Upload an SU email</button>
        {state.packets.map((p) => <InboxRow key={p.id} p={p} level={level} on={sel === p.id} onClick={() => setSel(p.id)} />)}
        {!state.packets.length && <div className="empty">No document sets yet. Send an email with attachments to the connected mailbox, or upload one.</div>}
        {metrics && <div className="metrics">
          <div><b>{metrics.median_minutes_to_reply == null ? "—" : Math.round(metrics.median_minutes_to_reply) + " min"}</b><span>median email → reply</span></div>
          <div><b className={metrics.match_overridden ? "bad-t" : "ok-t"}>{metrics.match_overridden}</b><span>agent "match" overridden by CG (guardrail: 0)</span></div>
          <p>{metrics.baseline_hours_note}</p>
        </div>}
      </aside>
      <main className="detail">{sel ? <Packet id={sel} level={level} refresh={refresh} say={say} /> : <div className="empty big">Select a document set</div>}</main>
      {up && <Upload channel="upload" onClose={() => setUp(false)} onDone={(id) => { setUp(false); setSel(id); refresh(); }} />}
    </div>);
}

function InboxRow({ p, level, on, onClick }) {
  const s = p.summary || {};
  const open = (s.mismatch || 0) + (s.uncertain || 0);
  const status = p.status === "replied" ? <span className="tag muted">Replied · {p.outcome}</span>
    : p.status === "ready" ? (open ? <span className="tag bad">{s.mismatch || 0} to fix · {s.uncertain || 0} to decide</span> : <span className="tag ok">All matched</span>)
    : p.status === "error" ? <span className="tag bad">Error</span> : <span className="tag warn">Reading…</span>;
  return (
    <button className={"row" + (on ? " on" : "")} onClick={onClick}>
      <div className="r1"><span className={"ch " + p.channel}>{p.channel === "a2a" ? "A2A" : p.channel === "email" ? "Email" : "Upload"}</span><b>{p.from_addr}</b><span className="t">{ago(p.received_at)}</span></div>
      <div className="r2">{p.subject}</div>
      <div className="r3">{status}{p.status === "ready" && p.draft_placed_at && <span className="tag gm">Draft in Gmail</span>}{level >= 2 && p.days_to_eta != null && <span className="tag muted">ETA in {p.days_to_eta}d</span>}{level >= 3 && p.risk_per_day ? <span className="tag bad-o">{money(p.risk_per_day)}/day at risk</span> : null}</div>
    </button>);
}

function Packet({ id, level, refresh, say }) {
  const [d, setD] = useState(null);
  const [focus, setFocus] = useState(null);
  const [tab, setTab] = useState("result");
  const load = () => get("/packet/" + id + "?level=" + level).then(setD);
  useEffect(() => { setD(null); setFocus(null); setTab("result"); }, [id]);
  useEffect(() => { load(); const t = setInterval(() => { if (!d || !["ready", "replied", "error"].includes(d.packet.status)) load(); }, 1500); return () => clearInterval(t); }, [id, level, d && d.packet.status]);
  useEffect(() => { if (d && ["ready", "error"].includes(d.packet.status)) refresh(); }, [d && d.packet.status]);
  if (!d) return <div className="empty big">Loading…</div>;
  const p = d.packet;
  const reading = !["ready", "replied", "error"].includes(p.status);
  return (
    <div className="packet">
      <EmailHeader p={p} docs={d.docs} />
      {reading || p.status === "error" ? <Incoming d={d} /> : <>
        <div className="tabs">
          <button className={tab === "result" ? "on" : ""} onClick={() => setTab("result")}>Verification</button>
          <button className={tab === "reply" ? "on" : ""} onClick={() => setTab("reply")}>Draft reply {p.status === "replied" ? "· sent" : ""}</button>
          <button className={tab === "learn" ? "on" : ""} onClick={() => setTab("learn")}>Versions & learning{d.learned.length ? " (" + d.learned.length + ")" : ""}</button>
          <button className={tab === "trace" ? "on" : ""} onClick={() => setTab("trace")}>Agent trace</button>
        </div>
        {tab === "result" && <Result d={d} level={level} onFocus={setFocus} />}
        {tab === "reply" && <Reply d={d} id={id} onSent={() => { load(); refresh(); }} say={say} />}
        {tab === "learn" && <Learned d={d} />}
        {tab === "trace" && <Trace d={d} />}
      </>}
      {focus && <Detail c={d.checks.find((c) => c.id === focus)} packetId={id} onClose={() => setFocus(null)} onDecided={(r) => { load(); refresh(); if (r && r.proposed_fact) say("Proposed rule added to the knowledge store: a CG lead must confirm it"); }} />}
    </div>);
}

function EmailHeader({ p, docs }) {
  return (
    <div className="mail">
      <div className="m1"><span className={"ch " + p.channel}>{p.channel === "a2a" ? "A2A · pre-checked by SU agent, re-verified here" : p.channel === "email" ? "Email" : "Uploaded"}</span><b>{p.subject}</b></div>
      <div className="m2">From <b>{p.from_addr}</b> · {new Date(p.received_at).toLocaleString()}{p.shipment_ref ? <> · Shipment <b>{p.shipment_ref}</b></> : null}{p.customer ? <> · Customer <b>{p.customer}</b></> : null}</div>
      <div className="atts">{docs.map((x) => <a key={x.id} className={"att " + x.status} href={API + "/doc/" + x.id + "/file"} target="_blank" title={x.error || x.extractor || ""}>
        <span>{DOC[x.doc_type] || (x.status === "reading" ? "…" : "?")}</span>{x.filename}{x.status === "duplicate" ? " (copy)" : ""}</a>)}</div>
    </div>);
}

function Incoming({ d }) {
  const steps = d.packet.progress || [];
  const read = d.docs.filter((x) => x.status !== "reading").length;
  return (
    <div className="incoming">
      <h3>{d.packet.status === "error" ? "The agent stopped" : "New email from SU · the agent is reading it"}</h3>
      {d.packet.status === "error" && <div className="err">{d.packet.error}<div className="row2" style={{ marginTop: 8 }}><button className="btn primary" onClick={() => post("/packet/" + d.packet.id + "/retry")}>Retry</button><span className="sub">Fix the key in ⚙ (top right) first.</span></div></div>}
      <div className="bar"><div style={{ width: (d.docs.length ? (read / d.docs.length) * 100 : 5) + "%" }} /></div>
      <p className="sub">{read}/{d.docs.length || "?"} documents read. Text documents are read directly; scans go to vision. Nothing is approved until every document is read.</p>
      <ol className="steps">{steps.map((s, i) => <li key={i}><b>{s.step}</b>{s.detail ? <span> · {s.detail}</span> : null}</li>)}</ol>
    </div>);
}

function Result({ d, level, onFocus }) {
  const cs = d.checks;
  const eff = (c) => (c.decision && c.decision.cg_status === "accepted" ? "accepted" : c.status);
  const groups = [["mismatch", "Needs a fix", true], ["uncertain", "Needs your decision", true], ["accepted", "Accepted by you", true], ["match", "Matched", false], ["skipped", "Not checked", false]];
  const e = d.enrichment || {};
  const s = d.packet.summary;
  return (
    <div className="result">
      <div className="summary">
        <div className="big bad"><b>{s.mismatch || 0}</b><span>to fix</span></div>
        <div className="big warn"><b>{s.uncertain || 0}</b><span>to decide</span></div>
        <div className="big ok"><b>{s.match || 0}</b><span>matched</span></div>
        <div className="verdict">{(s.mismatch || s.uncertain) ? <>The agent drafted an <b>amendment request</b>. Nothing is approved while a field is uncertain.</> : <>Everything matched. The agent drafted an <b>approval</b>.</>}<br /><span className="sub">{d.docs.filter((x) => x.status === "read").length} documents · {cs.length} checks · reading confidence shown per field</span></div>
      </div>
      {level >= 1 && <Enrich e={e} level={level} />}
      {groups.map(([k, title, open]) => { const rows = cs.filter((c) => eff(c) === k); if (!rows.length) return null;
        return <details key={k} open={open} className={"grp " + k}><summary><span className={"dot " + ST[k][1]}>{ST[k][0]}</span>{title} <span className="n">{rows.length}</span></summary>
          {rows.map((c) => <CheckRow key={c.id} c={c} onClick={() => onFocus(c.id)} />)}</details>; })}
    </div>);
}

function CheckRow({ c, onClick }) {
  const k = c.decision && c.decision.cg_status === "accepted" ? "accepted" : c.status;
  return (
    <button className="chk" onClick={onClick}>
      <span className={"dot " + ST[k][1]}>{ST[k][0]}</span>
      <div className="cmain"><b>{c.subject}</b>
        <div className="cf"><span>Found</span> {c.found}</div>
        {c.expected && c.status !== "match" && <div className="cf"><span>Expected</span> {c.expected}</div>}
      </div>
      <div className="cmeta">
        <div className="docs">{[...new Set((c.docs || []).map((x) => DOC[x.doc_type] || x.doc_type))].map((t) => <span key={t} className="dchip">{t}</span>)}</div>
        <span className={"sev " + c.severity}>{c.severity}</span>{c.level > 0 && <span className="sev conn">connected data</span>}
        {c.confidence != null && <span className="conf" title="How sure the agent is that it READ the values correctly">read {Math.round(c.confidence * 100)}%</span>}
      </div>
    </button>);
}

function Enrich({ e, level }) {
  return (
    <div className="enrich">
      {level >= 1 && <div><span className="k">Connected data</span>{e.connected && (e.connected.booking || e.connected.loading_plan) ? <b>{[e.connected.booking && "booking", e.connected.loading_plan && "loading plan"].filter(Boolean).join(" + ")}</b> : <b className="muted">none found for this shipment</b>}
        <i>{e.connected && e.connected.source ? "from " + e.connected.source + " (stands in for GoComet's booking / factory feed)" : "Checks that need it show as not checked."}</i></div>}
      {level >= 2 && <div><span className="k">Vessel arrives</span>{e.eta ? <b>{e.eta} · in {e.days_to_eta} days</b> : <b className="muted">no ETA</b>}<i>{e.clock_note}</i></div>}
      {level >= 3 && <div><span className="k">Cost if docs miss arrival</span><b>{e.risk_per_day ? money(e.risk_per_day) + " / day" : "$0: nothing open"}</b><i>{e.containers} container(s) × {money(e.rate_per_container_day)}/day. {e.cost_note}</i></div>}
      {level >= 4 && e.history && <div><span className="k">Auto-clear (L2 autonomy)</span><b className={e.history.would_auto_clear ? "ok-t" : ""}>{e.history.would_auto_clear ? "Would auto-clear" : "Human review needed"}</b>
        <i>{e.history.would_auto_clear ? "Every rule involved has ≥99% agreement with CG over ≥50 sets." : "Rules not yet trusted enough: " + e.history.blocking_rules.slice(0, 5).join(", ") + (e.history.blocking_rules.length > 5 ? "…" : "") + ". Autonomy is earned per rule."} <span className="concept">concept preview</span> {e.history.synthetic_note}</i></div>}
    </div>);
}

function Detail({ c, packetId, onClose, onDecided }) {
  const [note, setNote] = useState("");
  if (!c) return null;
  const k = c.decision && c.decision.cg_status === "accepted" ? "accepted" : c.status;
  const decide = (cg_status) => post("/packet/" + packetId + "/decide", { check_id: c.id, cg_status, note }).then((r) => { onDecided(r); onClose(); });
  return (
    <div className="drawer-bg" onClick={onClose}><div className="drawer" onClick={(e) => e.stopPropagation()}>
      <button className="x" onClick={onClose}>×</button>
      <div className={"dh " + ST[k][1]}><span className={"dot " + ST[k][1]}>{ST[k][0]}</span>{ST[k][2]} · {c.severity}</div>
      <h3>{c.subject}</h3>
      <table className="fe"><tbody>
        <tr><th>Found</th><td>{c.found}</td></tr>
        <tr><th>Expected</th><td>{c.expected || "—"}</td></tr>
      </tbody></table>
      <h4>Where it was read</h4>
      <div className="where">{(c.docs || []).map((x, i) => <a key={i} href={API + "/doc/" + x.doc_id + "/file"} target="_blank" className="wrow">
        <span className="dchip">{DOC[x.doc_type] || x.doc_type}</span><span className="wf">{x.filename}</span><span className="wv">{x.value}</span><span className="conf">read {Math.round((x.confidence ?? 1) * 100)}%</span></a>)}
        {!c.docs || !c.docs.length ? <span className="sub">No single document: this check is about the set.</span> : null}</div>
      <h4>Why the agent says this</h4>
      <p>{c.explanation}</p>
      <ol className="path">{(c.path || []).map((s, i) => <li key={i}>{s}</li>)}</ol>
      {c.decision && <p className="sub">Your decision: <b>{c.decision.cg_status}</b>{c.decision.note ? " · " + c.decision.note : ""}</p>}
      {(c.status === "mismatch" || c.status === "uncertain") && <div className="decide">
        <input placeholder="Note (why), saved to the audit trail" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row2">
          <button className="btn ok" onClick={() => decide("accepted")}>Accept as correct</button>
          <button className="btn bad" onClick={() => decide("confirmed_issue")}>Keep in amendment</button>
        </div>
        <p className="sub">Your call is logged against this rule. It is how the agent earns (or loses) the right to decide this rule alone later.</p>
      </div>}
    </div></div>);
}

function Reply({ d, id, onSent, say }) {
  const [m, setM] = useState(d.draft);
  const [busy, setBusy] = useState(false);
  useEffect(() => setM(d.draft), [d.draft && d.draft.body]);
  const p = d.packet;
  const sent = p.status === "replied";
  const viaGmail = p.via === "email" && p.channel === "email";
  const act = (action) => { if (action === "send" && !confirm("Send this reply to " + m.to + " now?")) return; setBusy(true);
    post("/packet/" + id + "/send", { ...m, action }).then((r) => { setBusy(false); say(r.error ? r.error : r.sent ? "Sent in the same email thread" : r.placed ? "Gmail draft updated. Send it from Gmail." : r.drafted ? "Saved as a Gmail draft in the thread" : r.reason); onSent(); }); };
  return (
    <div className="reply">
      <div className="rhint">{m.kind === "amendment" ? "Amendment request" : "Approval"} drafted by the agent from the checks. Every line traces to a check. <b>The agent never sends to the supplier on its own.</b></div>
      {viaGmail && !sent && <div className={"gmail " + (p.draft_placed_at ? "on" : "")}>{p.draft_placed_at
        ? <>✉ This reply is already waiting as a <b>draft in the supplier's Gmail thread</b> (placed {new Date(p.draft_placed_at).toLocaleTimeString()}). Open Gmail, review, press Send. Edits here update that draft.</>
        : <>The draft will appear in the Gmail thread once the mailbox is connected.</>}</div>}
      {sent && <div className="gmail on">✓ Reply sent {p.replied_at && new Date(p.replied_at).toLocaleString()} · {Math.max(1, Math.round((new Date(p.replied_at) - new Date(p.received_at)) / 6e4))} min after the email arrived</div>}
      <label>To<input value={m.to || ""} onChange={(e) => setM({ ...m, to: e.target.value })} disabled={sent} /></label>
      <label>Subject<input value={m.subject || ""} onChange={(e) => setM({ ...m, subject: e.target.value })} disabled={sent} /></label>
      <textarea value={m.body || ""} onChange={(e) => setM({ ...m, body: e.target.value })} disabled={sent} rows={20} />
      {!sent && <div className="row2">
        {viaGmail ? <>
          <button className="btn primary" disabled={busy} onClick={() => act("gmail_draft")}>{busy ? "Working…" : "Update Gmail draft"}</button>
          <button className="btn ghost" disabled={busy} onClick={() => act("send")}>Send from here instead</button>
        </> : <button className="btn primary" disabled={busy} onClick={() => act("send")}>{busy ? "Working…" : "Send reply"}</button>}
      </div>}
    </div>);
}

function Learned({ d }) {
  return (
    <div className="learned">
      <p className="rhint">When a set holds two versions of a document (draft → final, or a re-issued BL), the agent compares them. Each difference is a correction someone made by hand, so it becomes a <b>proposed rule</b> for the supplier's agent. <span className="concept">concept preview</span></p>
      {!d.learned.length && <div className="empty">No draft/final pairs in this set.</div>}
      {d.learned.map((l, i) => <div key={i} className="lcard">
        <div className="lh"><span className="dchip">{DOC[l.doc_type]}</span>{l.kind}: <b>{l.draft}</b> → <b>{l.final}</b></div>
        <table className="ft"><thead><tr><th>Field</th><th>Before</th><th>After</th><th>Proposed rule for the SU agent</th></tr></thead><tbody>
          {l.diffs.map((x, k) => <tr key={k}><td>{x.field}</td><td className="b">{fmtV(x.draft)}</td><td className="a">{fmtV(x.final)}</td><td className="sub">{proposeRule(l, x)}</td></tr>)}
        </tbody></table></div>)}
    </div>);
}
const fmtV = (v) => (v == null ? "—" : Array.isArray(v) ? v.map((x) => (typeof x === "object" ? Object.values(x).join(" ") : x)).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));
function proposeRule(l, x) {
  if (x.field === "po_refs") return "Check PO numbers against the order system before issuing (a digit was missing).";
  if (x.field === "shipment_date") return "Take the shipment date from the BL on-board date, not the planned ETD.";
  if (x.field === "reference_no") return "Normal for a draft; no rule.";
  if (x.field === "place_of_delivery" || x.field === "port_of_discharge") return "Confirm final destination with CG before the BL is issued.";
  if (x.field === "hs_codes" || x.field === "goods_lines") return "Describe all products and the HS code consistently with the invoice.";
  return "Review: changed between versions.";
}

function Trace({ d }) {
  return (
    <div className="trace">
      <ol className="steps">{(d.packet.progress || []).map((s, i) => <li key={i}><b>{s.step}</b>{s.detail ? <span> · {s.detail}</span> : null}<span className="t">{new Date(s.at).toLocaleTimeString()}</span></li>)}</ol>
      <h4>Documents</h4>
      <table className="ft"><thead><tr><th>File</th><th>Type</th><th>Read by</th><th>Status</th></tr></thead><tbody>
        {d.docs.map((x) => <tr key={x.id}><td>{x.filename}</td><td>{DOC[x.doc_type] || x.doc_type}</td><td>{x.extractor}</td><td>{x.status}{x.error ? " · " + x.error : ""}</td></tr>)}</tbody></table>
    </div>);
}

// ======================= Upload (CG fallback + SU pre-check) =======================
function Upload({ channel, onClose, onDone, title }) {
  const [from, setFrom] = useState(channel === "precheck" ? "su-docs@factory.example" : "su-docs@factory.example");
  const [subject, setSubject] = useState("Shipment documents");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); const fs = await Promise.all([...files].map(async (f) => ({ filename: f.name, data: await toB64(f) })));
    const r = await post("/upload", { from, subject, files: fs, channel }); setBusy(false); r.id ? onDone(r.id) : alert(r.error || "Upload failed"); };
  return (
    <div className="drawer-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>{title || "Upload an SU email"}</h3>
      <p className="sub">{channel === "precheck" ? "Check your documents against the customer's rules before you send them." : "Same pipeline as an email arriving over IMAP. Use it when no mailbox is connected."}</p>
      <label>From<input value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
      <label>Attachments (PDF, images, Excel, zip)<input type="file" multiple onChange={(e) => setFiles(e.target.files)} /></label>
      <div className="row2"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!files.length || busy} onClick={go}>{busy ? "Uploading…" : channel === "precheck" ? "Run pre-check" : "Process as email"}</button></div>
    </div></div>);
}

// ======================= SU =======================
function SU({ level, say, goCG, prechecks, mail }) {
  const [up, setUp] = useState(false);
  const [id, setId] = useState(null);
  const [d, setD] = useState(null);
  useEffect(() => { if (!id) return; const load = () => get("/packet/" + id + "?level=" + level).then(setD); load(); const t = setInterval(load, 1500); return () => clearInterval(t); }, [id, level]);
  const s = d && d.packet.summary;
  return (
    <div className="su">
      <div className="su-head">
        <div><h2>Pre-check before you send</h2><p className="sub">Your documents, checked against the same rules CG uses. Fix issues before they become an amendment cycle.</p></div>
        <button className="btn primary" onClick={() => setUp(true)}>Upload documents to pre-check</button>
      </div>
      {mail && mail.configured && <div className="addr wide"><div><span>Email your documents to</span><b>{mail.addresses.precheck}</b></div><i>You get a reply in about a minute: what CG would reject, before you send. Nothing goes to CG.</i></div>}
      {prechecks.length > 0 && <div className="pclist"><b>Recent pre-checks</b>{prechecks.map((x) => <button key={x.id} className={"row" + (id === x.id ? " on" : "")} onClick={() => setId(x.id)}>
        <div className="r1"><span className={"ch " + x.channel}>{x.via === "email" ? "Email" : "Upload"}</span><b>{x.from_addr}</b><span className="t">{ago(x.received_at)}</span></div><div className="r2">{x.subject}</div>
        <div className="r3">{x.status === "ready" ? ((x.summary.mismatch || 0) ? <span className="tag bad">{x.summary.mismatch} to fix</span> : <span className="tag ok">Ready to send</span>) : <span className="tag warn">Checking…</span>}</div></button>)}</div>}
      {!d && <div className="explain">
        <div><b>Works alone</b><p>No CG or customer adoption needed. Every rejection you avoid is a day saved and a payment that isn't held.</p></div>
        <div><b>Learns from your amendments</b><p>Corrections CG asked for before (draft → final) become rules your agent checks next time. <span className="concept">concept preview</span></p></div>
        <div><b>Sends over A2A</b><p>A pre-checked set goes to CG's agent as a structured packet. CG's agent re-checks it anyway: verify, don't trust.</p></div>
      </div>}
      {d && <div className="packet">
        <EmailHeader p={d.packet} docs={d.docs} />
        {!["ready", "error", "replied"].includes(d.packet.status) ? <Incoming d={d} /> : <>
          <div className={"su-verdict " + (s.mismatch ? "bad" : s.uncertain ? "warn" : "ok")}>
            {s.mismatch ? <><b>{s.mismatch} issue(s) will get this set rejected.</b> Fix them before sending.</> : s.uncertain ? <><b>{s.uncertain} item(s) CG will ask about.</b> Consider clarifying in your email.</> : <b>Ready to send. Nothing CG would bounce.</b>}
            {d.packet.channel === "precheck" ? <button className="btn primary" onClick={() => post("/packet/" + id + "/a2a").then(() => { say("Sent to CG's agent over A2A"); goCG(id); })}>Send to CG via agent (A2A)</button> : <span className="tag muted">Sent to CG</span>}
          </div>
          <Result d={d} level={level} onFocus={() => {}} />
          {d.learned.length > 0 && <Learned d={d} />}
        </>}
      </div>}
      {up && <Upload channel="precheck" title="Pre-check documents" onClose={() => setUp(false)} onDone={(x) => { setUp(false); setId(x); }} />}
    </div>);
}

// ======================= Customer =======================
function Customer() {
  const [d, setD] = useState(null);
  useEffect(() => { const l = () => get("/customer").then(setD); l(); const t = setInterval(l, 4000); return () => clearInterval(t); }, []);
  return (
    <div className="cust">
      <h2>Shipment readiness</h2>
      <p className="sub">Are the documents cleared before the vessel arrives? That is what decides release on landing, port days and demurrage.</p>
      <table className="ft big"><thead><tr><th>Shipment</th><th>Buyer</th><th>Vessel arrives</th><th>Documents</th><th>Open items</th><th>$ at risk / day</th></tr></thead><tbody>
        {(d ? d.shipments : []).map((s) => <tr key={s.id}><td><b>{s.shipment_ref || "#" + s.id}</b></td><td>{s.customer || "—"}</td><td>{s.eta ? s.eta + " (" + s.days_to_eta + "d)" : "—"}</td>
          <td><span className={"tag " + (s.status === "cleared" ? "ok" : s.status === "amendment requested" ? "bad" : "warn")}>{s.status}</span></td><td>{s.open}</td><td>{s.risk_per_day ? money(s.risk_per_day) : "—"}</td></tr>)}
      </tbody></table>
      {d && !d.shipments.length && <div className="empty">No shipments yet.</div>}
      <p className="sub">The customer sees status, not the supplier's error history: "share the rule, not the data".</p>
    </div>);
}

// ======================= Knowledge store =======================
function Knowledge({ say }) {
  const [d, setD] = useState(null);
  const load = () => get("/knowledge").then(setD);
  useEffect(() => { load(); }, []);
  if (!d) return <div className="empty big">Loading…</div>;
  const act = (f, status) => post("/knowledge/" + f.id, { status }).then(() => { say("Fact " + status); load(); });
  return (
    <div className="kn">
      <h2>Trade knowledge store</h2>
      <p className="sub">Rules, classifications and aliases are data, not code. Agents only <b>propose</b>; a person confirms. Every fact carries status, source, confidence, owner and visibility.</p>
      <h3>Facts</h3>
      <table className="ft"><thead><tr><th>Status</th><th>Subject</th><th>Relation</th><th>Object</th><th>Confidence</th><th>Source</th><th>Owner · visibility</th><th></th></tr></thead><tbody>
        {d.facts.map((f) => <tr key={f.id} className={f.status}><td><span className={"tag " + (f.status === "confirmed" ? "ok" : f.status === "proposed" ? "warn" : "muted")}>{f.status}</span></td>
          <td>{f.subject}</td><td>{f.predicate}</td><td>{f.object}</td><td>{Math.round((f.confidence || 0) * 100)}%</td><td className="sub">{f.source}</td><td className="sub">{f.owner} · {f.visibility}</td>
          <td>{f.status === "proposed" && <span className="row2"><button className="btn ok sm" onClick={() => act(f, "confirmed")}>Confirm</button><button className="btn ghost sm" onClick={() => act(f, "rejected")}>Reject</button></span>}</td></tr>)}
      </tbody></table>
      <h3>Rules <span className="sub">(precedence: regulation → trade agreement → customer → shipment)</span></h3>
      <table className="ft"><thead><tr><th>ID</th><th>Rule</th><th>Scope</th><th>Severity</th><th>Needs</th><th>Why</th></tr></thead><tbody>
        {d.rules.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td>{r.name}</td><td>{r.scope_level} · {r.scope_key}</td><td>{r.severity}</td><td>{r.level ? LEVELS[r.level].label : "documents"}</td><td className="sub">{r.explain}</td></tr>)}
      </tbody></table>
      <h3>Document types</h3>
      <div className="dts">{d.doc_types.map((t) => <span key={t.id} className="dchip">{t.name}{t.connected_data ? " · connected data" : t.required_in_packet ? " · required" : ""}</span>)}</div>
      <p className="sub">Adding a new customer, document type or country is a data change: new facts, a new type, a new rule pack. No code.</p>
    </div>);
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
