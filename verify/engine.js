// Verification engine: deterministic checks over a packet's documents.
// Rules (what to check, severity, scope) come from the knowledge store; this file only
// implements the check TYPES. Adding a rule of an existing type needs no code.
const { db, J } = require("./store");

const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
const F_TERMS = ["FCA", "FAS", "FOB"];
const CORP = /\b(PTE|PT|LTD|LIMITED|PVT|PRIVATE|SL|TBK|INC|CO|COMPANY|CORP|CORPORATION|LLC|GMBH|BV|SA)\b/g;

// ---------- normalizers / entity resolution (driven by the aliases table) ----------
const up = (s) => (s == null ? "" : String(s)).toUpperCase().replace(/\s+/g, " ").trim();
const normParty = (s) => up(s).replace(/[.,'&()/-]/g, " ").replace(CORP, " ").replace(/\s+/g, " ").trim();
const addrTokens = (s) => new Set(up(s).replace(/[.,#()/-]/g, " ").split(" ").filter((t) => t.length > 1));
const jaccard = (a, b) => { const A = addrTokens(a), B = addrTokens(b); if (!A.size || !B.size) return 0; let i = 0; for (const t of A) if (B.has(t)) i++; return i / (A.size + B.size - i); };
const num = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/,/g, "").replace(/[^\d.-]/g, "")); return isNaN(n) ? null : n; };
const digits = (s) => (s == null ? "" : String(s).replace(/\D/g, ""));

let aliasCache = null;
function aliases() {
  if (aliasCache) return aliasCache;
  const rows = db.prepare("SELECT kind, alias, canonical FROM aliases").all();
  aliasCache = { port: {}, country: {} };
  for (const r of rows) aliasCache[r.kind] && (aliasCache[r.kind][r.alias] = r.canonical);
  return aliasCache;
}
function resolvePlace(raw) {
  const s = up(raw).replace(/[.]/g, "");
  if (!s || s === "-" || s === "N/A") return { kind: "missing", raw };
  const A = aliases();
  if (A.port[s]) return { kind: "port", code: A.port[s], raw };
  if (A.country[s]) return { kind: "country", country: A.country[s], raw };
  for (const [alias, code] of Object.entries(A.port)) if (alias.length > 3 && new RegExp("\\b" + alias.replace(/[,]/g, ",?") + "\\b").test(s)) return { kind: "port", code, raw };
  for (const [alias, c] of Object.entries(A.country)) if (alias.length > 2 && new RegExp("\\b" + alias + "\\b").test(s)) return { kind: "country", country: c, raw };
  return { kind: "unknown", raw };
}

// ---------- helpers ----------
const byType = (docs, t) => docs.filter((d) => d.doc_type === t);
const conf = (d, f) => { const c = d.confidence || {}; return typeof c[f] === "number" ? c[f] : 0.9; };
const unreadable = (d, f) => (d.unreadable || []).includes(f);
const ref = (d, field, value) => ({ doc_id: d.id, filename: d.filename, doc_type: d.doc_type, field, value: value == null ? null : String(value), confidence: conf(d, field) });
const LOW = { critical: 0.9, normal: 0.75 };

function result(rule, o) {
  return { rule_id: rule.id, rule_name: rule.name, severity: rule.severity, level: rule.level, scope: rule.scope_level + " · " + rule.scope_key,
    explanation: rule.explain, path: o.path || [rule.scope_level + ": " + rule.scope_key, "rule " + rule.id + " v" + rule.version], ...o };
}
// Low read confidence never becomes a silent match: it becomes "uncertain".
function guard(rule, status, refs) {
  const min = refs.reduce((m, r) => Math.min(m, r.confidence == null ? 1 : r.confidence), 1);
  const threshold = LOW[rule.severity] || 0.75;
  if (min < threshold && status !== "skipped") return { status: "uncertain", lowConf: true, confidence: min };
  return { status, confidence: min };
}

// ---------- check types ----------
const CHECKS = {
  incoterm_valid(rule, ctx) {
    const inv = byType(ctx.docs, "commercial_invoice");
    if (!inv.length) return [result(rule, { subject: "Incoterm", status: "skipped", found: "no invoice in packet", docs: [] })];
    return inv.map((d) => {
      const code = up(d.fields.incoterm).slice(0, 3);
      const r = [ref(d, "incoterm", d.fields.incoterm)];
      if (!code) return result(rule, { subject: "Incoterm · " + (d.fields.invoice_no || d.filename), status: "mismatch", expected: "one of " + INCOTERMS.join(", "), found: "missing", docs: r, ...pick(guard(rule, "mismatch", r)) });
      const ok = INCOTERMS.includes(code);
      const g = guard(rule, ok ? "match" : "mismatch", r);
      return result(rule, { subject: "Incoterm · " + (d.fields.invoice_no || d.filename), expected: "a valid Incoterms 2020 code", found: code, docs: r, ...g });
    });
  },
  incoterm_place(rule, ctx) {
    const inv = byType(ctx.docs, "commercial_invoice");
    const pol = ctx.voyage.pol, pod = ctx.voyage.pod;
    return inv.map((d) => {
      const code = up(d.fields.incoterm).slice(0, 3);
      const placeRaw = d.fields.incoterm_place;
      const place = resolvePlace(placeRaw);
      const r = [ref(d, "incoterm_place", (code + " " + (placeRaw || "")).trim())];
      const subject = "Incoterm named place · " + (d.fields.invoice_no || d.filename);
      if (!INCOTERMS.includes(code)) return result(rule, { subject, status: "skipped", found: "no valid Incoterm to check", docs: r });
      if (place.kind === "missing") return result(rule, { subject, status: "mismatch", expected: code + " + " + (F_TERMS.includes(code) ? "port of loading" : "destination"), found: code + " with no named place", docs: r, ...pick(guard(rule, "mismatch", r)) });
      const isF = F_TERMS.includes(code);
      const target = isF ? pol : pod;
      const other = isF ? pod : pol;
      let status = "uncertain", note = "";
      if (place.kind === "port" && target && place.code === target.code) status = "match";
      else if (place.kind === "port" && other && place.code === other.code) { status = "mismatch"; note = isF ? " (that is the destination port)" : " (that is the loading port)"; }
      else if (place.kind === "country" && !isF && target && target.country === place.country) status = "match";
      else if (place.kind === "port" && target && place.code !== target.code) status = "mismatch";
      const expected = code + " " + (target ? (target.raw + " (" + (isF ? "port of loading" : "destination") + ")") : (isF ? "<port of loading>" : "<destination>"));
      const g = guard(rule, status, r);
      return result(rule, { subject, expected, found: code + " " + placeRaw + note, docs: r, ...g,
        path: ["regulation: Incoterms 2020", isF ? code + " is an F-term → names the place of SHIPMENT" : code + " names the DESTINATION", "port of loading on " + (pol ? pol.source : "—") + ": " + (pol ? pol.raw : "unknown")] });
    });
  },
  port_is_port(rule, ctx) {
    const out = [];
    for (const d of ctx.docs) for (const f of ["port_of_loading", "port_of_discharge"]) {
      const v = d.fields[f]; if (!v) continue;
      const p = resolvePlace(v);
      if (p.kind === "country") out.push(result(rule, { subject: label(f) + " · " + docLabel(d), status: "mismatch", expected: "a named port", found: v + " (a country)", docs: [ref(d, f, v)], confidence: conf(d, f) }));
    }
    if (!out.length) out.push(result(rule, { subject: "Ports are named ports", status: "match", found: "all ports resolve to a port", docs: [], confidence: 1 }));
    return out;
  },
  port_consistent(rule, ctx) {
    const f = J(rule.params_json, {}).field;
    const refs = [], codes = new Map();
    for (const d of ctx.docs) {
      if (!["commercial_invoice", "packing_list", "bill_of_lading", "certificate_of_origin"].includes(d.doc_type)) continue;
      const v = d.fields[f]; if (!v) continue;
      const p = resolvePlace(v);
      refs.push(ref(d, f, v));
      if (p.kind === "port") codes.set(p.code, (codes.get(p.code) || []).concat(docLabel(d)));
    }
    const subject = label(f) + " across documents";
    if (refs.length < 2) return [result(rule, { subject, status: "skipped", found: "fewer than two documents state it", docs: refs })];
    const status = codes.size > 1 ? "mismatch" : codes.size === 1 ? "match" : "uncertain";
    const g = guard(rule, status, refs);
    const nameOf = new Map(); for (const r of refs) { const p = resolvePlace(r.value); if (p.kind === "port" && !nameOf.has(p.code)) nameOf.set(p.code, up(r.value).split(",")[0]); }
    return [result(rule, { subject, expected: "the same port on every document", found: [...codes.entries()].map(([c, ds]) => (nameOf.get(c) || c) + " (" + c + ") on " + ds.join(", ")).join(" · ") || "no document names a resolvable port", docs: refs, ...g })];
  },
  consignee_consistent(rule, ctx) {
    const refs = [];
    for (const d of ctx.docs) {
      const nameF = d.doc_type === "commercial_invoice" || d.doc_type === "packing_list" ? "ship_to_name" : d.doc_type === "bill_of_lading" || d.doc_type === "certificate_of_origin" ? "consignee_name" : null;
      if (!nameF || !d.fields[nameF]) continue;
      const addrF = nameF === "ship_to_name" ? "ship_to_address" : "consignee_address";
      refs.push({ d, name: d.fields[nameF], addr: d.fields[addrF], r: ref(d, nameF, d.fields[nameF] + (d.fields[addrF] ? " — " + d.fields[addrF] : "")) });
    }
    if (refs.length < 2) return [result(rule, { subject: "Consignee across documents", status: "skipped", found: "fewer than two documents name a consignee", docs: refs.map((x) => x.r) })];
    const names = new Set(refs.map((x) => normParty(x.name)));
    const out = [];
    const nr = refs.map((x) => x.r);
    if (names.size > 1) out.push(result(rule, { subject: "Consignee name across documents", expected: "one party on every document", found: refs.map((x) => x.name + " (" + docLabel(x.d) + ")").join(" · "), docs: nr, ...guard(rule, "mismatch", nr) }));
    else out.push(result(rule, { subject: "Consignee name across documents", expected: "one party on every document", found: refs[0].name, docs: nr, ...guard(rule, "match", nr) }));
    // addresses: same party, different address → a person decides unless a customer rule says which address is right
    const withAddr = refs.filter((x) => x.addr);
    let worst = 1, pair = null;
    for (let i = 0; i < withAddr.length; i++) for (let k = i + 1; k < withAddr.length; k++) { const s = jaccard(withAddr[i].addr, withAddr[k].addr); if (s < worst) { worst = s; pair = [withAddr[i], withAddr[k]]; } }
    if (pair && worst < 0.5) {
      const custRule = db.prepare("SELECT object FROM facts WHERE subject=? AND predicate='consignee_address' AND status='confirmed'").get(normParty(pair[0].name));
      const found = docLabel(pair[0].d) + ": " + pair[0].addr + "  vs  " + docLabel(pair[1].d) + ": " + pair[1].addr;
      if (custRule) {
        const okA = jaccard(pair[0].addr, custRule.object) >= 0.5, okB = jaccard(pair[1].addr, custRule.object) >= 0.5;
        out.push(result(rule, { subject: "Consignee address", status: okA && okB ? "match" : "mismatch", expected: custRule.object + " (customer rule)", found, docs: [pair[0].r, pair[1].r], confidence: 0.95,
          path: ["customer rule: consignee address for " + pair[0].name, "knowledge store fact, confirmed"] }));
      } else {
        out.push(result(rule, { subject: "Consignee address", status: "uncertain", expected: "the same address, or a customer rule saying which one is right", found, docs: [pair[0].r, pair[1].r], confidence: 0.6,
          explanation: "Same party, different addresses. This can be correct (office vs warehouse) or an error. No customer rule exists yet, so a person decides; the decision becomes a proposed rule.",
          path: ["same consignee name on both documents", "address overlap " + Math.round(worst * 100) + "%", "no confirmed customer rule for this consignee → ask CG"] }));
      }
    }
    return out;
  },
  qty_consistent(rule, ctx) {
    const inv = byType(ctx.docs, "commercial_invoice"), pl = byType(ctx.docs, "packing_list"), bl = byType(ctx.docs, "bill_of_lading");
    const refs = [], vals = [];
    const sumOf = (ds, f, lineF) => ds.reduce((a, d) => a + (num(d.fields[f]) ?? (d.fields.lines || []).reduce((s, l) => s + (num(l[lineF]) || 0), 0)), 0);
    if (inv.length) { const v = sumOf(inv, "total_qty", "qty"); vals.push(["invoices", v]); inv.forEach((d) => refs.push(ref(d, "total_qty", d.fields.total_qty))); }
    if (pl.length) { const v = sumOf(pl, "total_qty", "qty"); vals.push(["packing lists", v]); pl.forEach((d) => refs.push(ref(d, "total_qty", d.fields.total_qty))); }
    for (const d of bl) { const v = num(d.fields.total_packages); if (v != null) { vals.push([docLabel(d), v]); refs.push(ref(d, "total_packages", v)); } }
    if (vals.length < 2) return [result(rule, { subject: "Total quantity", status: "skipped", found: "needs at least two of invoice, packing list, BL", docs: refs })];
    const distinct = new Set(vals.map((x) => x[1]));
    return [result(rule, { subject: "Total quantity (cases)", expected: "the same total everywhere", found: vals.map(([k, v]) => k + ": " + fmt(v)).join(" · "), docs: refs, ...guard(rule, distinct.size === 1 ? "match" : "mismatch", refs) })];
  },
  sku_qty(rule, ctx) {
    const agg = (ds) => { const m = new Map(); for (const d of ds) for (const l of d.fields.lines || []) { const k = digits(l.sku); if (!k) continue; m.set(k, (m.get(k) || 0) + (num(l.qty) || 0)); } return m; };
    const inv = byType(ctx.docs, "commercial_invoice"), pl = byType(ctx.docs, "packing_list");
    if (!inv.length || !pl.length) return [result(rule, { subject: "Quantity per product", status: "skipped", found: "needs invoice and packing list", docs: [] })];
    const a = agg(inv), b = agg(pl);
    if (!b.size) return [result(rule, { subject: "Quantity per product", status: "skipped", found: "packing list has no product codes", docs: [] })];
    const out = [];
    for (const [sku, q] of a) {
      const q2 = b.get(sku);
      const refs = [...inv, ...pl].filter((d) => (d.fields.lines || []).some((l) => digits(l.sku) === sku)).map((d) => ref(d, "lines.qty", sku));
      out.push(result(rule, { subject: "Qty · SKU " + sku, expected: fmt(q) + " (invoice)", found: q2 == null ? "not on packing list" : fmt(q2) + " (packing list)", docs: refs, ...guard(rule, q2 === q ? "match" : "mismatch", refs) }));
    }
    return out;
  },
  weight_consistent(rule, ctx) {
    const tol = (J(rule.params_json, {}).tolerance_pct || 0.5) / 100;
    const pl = byType(ctx.docs, "packing_list"), bl = byType(ctx.docs, "bill_of_lading");
    if (!pl.length || !bl.length) return [result(rule, { subject: "Gross weight", status: "skipped", found: "needs packing list and BL", docs: [] })];
    const plG = pl.reduce((a, d) => a + (num(d.fields.total_gross_kg) || 0), 0);
    return bl.map((d) => {
      const g = num(d.fields.gross_kg);
      const refs = [...pl.map((p) => ref(p, "total_gross_kg", p.fields.total_gross_kg)), ref(d, "gross_kg", g)];
      if (g == null || !plG) return result(rule, { subject: "Gross weight · " + docLabel(d), status: "skipped", found: "weight not stated", docs: refs });
      const ok = Math.abs(g - plG) <= plG * tol;
      return result(rule, { subject: "Gross weight · " + docLabel(d), expected: fmt(plG) + " kg (packing list)", found: fmt(g) + " kg", docs: refs, ...guard(rule, ok ? "match" : "mismatch", refs) });
    });
  },
  hs_format(rule, ctx) {
    const min = J(rule.params_json, {}).min_digits || 6;
    const out = [];
    for (const d of byType(ctx.docs, "commercial_invoice")) for (const l of d.fields.lines || []) {
      const h = digits(l.hs_code);
      const r = [ref(d, "lines.hs_code", l.hs_code)];
      out.push(result(rule, { subject: "HS format · SKU " + (l.sku || "?"), expected: "≥ " + min + " digits", found: h || "missing", docs: r, ...guard(rule, h.length >= min ? "match" : "mismatch", r) }));
    }
    return out.length ? collapseMatches(out, rule, "HS codes present and well-formed") : [result(rule, { subject: "HS format", status: "skipped", found: "no invoice lines", docs: [] })];
  },
  hs_known(rule, ctx) {
    const out = [];
    const q = db.prepare("SELECT object, status, confidence, source FROM facts WHERE subject=? AND predicate='classified_as' AND status='confirmed' AND (valid_to IS NULL)");
    const fam = db.prepare("SELECT subject, object, status, confidence, source FROM facts WHERE predicate='same_family_as' AND (subject=? OR object=?)");
    for (const d of byType(ctx.docs, "commercial_invoice")) for (const l of d.fields.lines || []) {
      const sku = digits(l.sku), h = digits(l.hs_code);
      if (!sku) continue;
      const r = [ref(d, "lines.hs_code", l.hs_code)];
      const known = q.get(sku);
      const subject = "HS classification · " + sku + " " + (l.description || "");
      if (!known) { out.push(result(rule, { subject, status: "uncertain", expected: "a confirmed classification", found: h + " (no confirmed classification for this SKU)", docs: r, confidence: 0.5, path: ["knowledge store: no confirmed fact for SKU " + sku, "→ proposed for confirmation"] })); continue; }
      const k = digits(known.object);
      const same = h && (h.startsWith(k) || k.startsWith(h));
      if (!same) { out.push(result(rule, { subject, status: "mismatch", expected: known.object + " (confirmed)", found: h || "missing", docs: r, ...pick(guard(rule, "mismatch", r)), path: ["knowledge store: SKU " + sku + " classified_as " + known.object, "status confirmed · source: " + known.source] })); continue; }
      // family conflict: a sibling product is confirmed under a different code
      const f = fam.all(sku, sku).map((x) => (x.subject === sku ? x.object : x.subject)).map((other) => ({ other, k: q.get(other) })).find((x) => x.k && digits(x.k.object).slice(0, 6) !== k.slice(0, 6));
      if (f) { out.push(result(rule, { subject, status: "uncertain", expected: "one code per product family", found: h + " here, but family member " + f.other + " is confirmed as " + f.k.object, docs: r, confidence: 0.7,
        explanation: "The product matches the confirmed code, but the knowledge store links it to a sibling product classified differently. One of the two classifications may be wrong; a person decides.",
        path: ["SKU " + sku + " classified_as " + known.object + " (confirmed)", "SKU " + sku + " same_family_as " + f.other + " (proposed by agent)", f.other + " classified_as " + f.k.object + " (confirmed)", "→ conflict: needs a human"] })); continue; }
      out.push(result(rule, { subject, expected: known.object, found: h, docs: r, ...guard(rule, "match", r), path: ["knowledge store: SKU " + sku + " classified_as " + known.object, "confirmed · " + known.source] }));
    }
    return out.length ? collapseMatches(out, rule, "HS codes match confirmed classifications") : [result(rule, { subject: "HS classification", status: "skipped", found: "no invoice lines", docs: [] })];
  },
  hs_across(rule, ctx) {
    const per = []; // [docLabel, code, doc]
    for (const d of byType(ctx.docs, "commercial_invoice")) for (const l of d.fields.lines || []) if (digits(l.hs_code)) per.push([docLabel(d), digits(l.hs_code), d, "lines.hs_code"]);
    for (const d of byType(ctx.docs, "certificate_of_origin")) for (const l of d.fields.lines || []) if (digits(l.hs_code)) per.push([docLabel(d), digits(l.hs_code), d, "lines.hs_code"]);
    for (const d of byType(ctx.docs, "bill_of_lading")) for (const h of d.fields.hs_codes || []) if (digits(h)) per.push([docLabel(d), digits(h), d, "hs_codes"]);
    const kinds = new Set(per.map((p) => p[2].doc_type));
    if (kinds.size < 2) return [result(rule, { subject: "HS code across documents", status: "skipped", found: "only one document type states an HS code", docs: [] })];
    const refs = per.map(([, c, d, f]) => ref(d, f, c));
    const six = new Set(per.map((p) => p[1].slice(0, 6)));
    const full = new Map(); for (const [lab, c] of per) full.set(c, (full.get(c) || new Set()).add(lab));
    const found = [...full.entries()].map(([c, ls]) => c + " on " + [...ls].join(", ")).join(" · ");
    if (six.size > 1) return [result(rule, { subject: "HS code across documents", expected: "the same 6-digit heading everywhere", found, docs: refs, ...guard(rule, "mismatch", refs) })];
    if (full.size > 1) return [result(rule, { subject: "HS code across documents (national digits)", status: "uncertain", expected: "one code, or a known export/import pair", found, docs: refs, confidence: 0.7,
      path: ["6-digit heading " + [...six][0] + " agrees on every document (international)", "digits 7–8 differ: " + [...full.keys()].join(", "), "national codes can differ legitimately → a person decides"] })];
    return [result(rule, { subject: "HS code across documents", expected: "one code", found, docs: refs, ...guard(rule, "match", refs) })];
  },
  ship_date(rule, ctx) {
    const coo = byType(ctx.docs, "certificate_of_origin"), bl = byType(ctx.docs, "bill_of_lading").filter((d) => d.fields.on_board_date);
    if (!coo.length || !bl.length) return [result(rule, { subject: "Shipment date", status: "skipped", found: "needs COO and BL with an on-board date", docs: [] })];
    const b = bl[0];
    return coo.filter((c) => c.fields.shipment_date).map((c) => { const r = [ref(c, "shipment_date", c.fields.shipment_date), ref(b, "on_board_date", b.fields.on_board_date)];
      return result(rule, { subject: "Shipment date · " + docLabel(c), expected: b.fields.on_board_date + " (" + docLabel(b) + " on board)", found: c.fields.shipment_date, docs: r, ...guard(rule, String(c.fields.shipment_date).slice(0, 10) === String(b.fields.on_board_date).slice(0, 10) ? "match" : "mismatch", r) }); });
  },
  duplicate_lines(rule, ctx) {
    const out = [];
    for (const d of byType(ctx.docs, "commercial_invoice")) {
      const seen = new Map();
      for (const l of d.fields.lines || []) { const k = digits(l.sku); if (!k) continue; seen.set(k, (seen.get(k) || 0) + 1); }
      for (const [k, n] of seen) if (n > 1) out.push(result(rule, { subject: "Duplicate line · SKU " + k + " · " + docLabel(d), status: "uncertain", expected: "each product once", found: n + " lines for the same SKU", docs: [ref(d, "lines", k)], confidence: 0.7,
        explanation: "Two lines for one product can be a split batch (fine) or a copy error (overbilling). A person decides." }));
    }
    return out.length ? out : [result(rule, { subject: "No duplicated invoice lines", status: "match", found: "each product appears once", docs: [], confidence: 1 })];
  },
  origin_consistent(rule, ctx) {
    const coo = byType(ctx.docs, "certificate_of_origin"), inv = byType(ctx.docs, "commercial_invoice");
    if (!coo.length || !inv.length) return [result(rule, { subject: "Origin", status: "skipped", found: "needs invoice and certificate of origin", docs: [] })];
    const A = aliases();
    const invOrigins = new Set(); const refs = [];
    for (const d of inv) for (const l of d.fields.lines || []) if (l.country_of_origin) { invOrigins.add(A.country[up(l.country_of_origin)] || up(l.country_of_origin)); }
    inv.forEach((d) => refs.push(ref(d, "lines.country_of_origin", [...invOrigins].join(", "))));
    return coo.map((c) => {
      const o = A.country[up(c.fields.country_of_origin)] || up(c.fields.country_of_origin);
      const r = [...refs, ref(c, "country_of_origin", c.fields.country_of_origin)];
      if (!o) return result(rule, { subject: "Origin · " + docLabel(c), status: "uncertain", expected: [...invOrigins].join(", "), found: "not readable on the certificate", docs: r, confidence: 0.5 });
      return result(rule, { subject: "Origin · " + docLabel(c), expected: [...invOrigins].join(", ") + " (invoice)", found: o, docs: r, ...guard(rule, invOrigins.has(o) && invOrigins.size === 1 ? "match" : "mismatch", r) });
    });
  },
  coa_batches(rule, ctx) {
    const lp = ctx.connected.loading_plan;
    const coa = byType(ctx.docs, "certificate_of_analysis");
    if (!lp) return [result(rule, { subject: "Quality certificates vs loaded batches", status: "skipped", found: "loading plan not connected", docs: [] })];
    if (!coa.length) return [result(rule, { subject: "Quality certificates vs loaded batches", status: "mismatch", expected: "a certificate per loaded batch", found: "no certificates of analysis attached", docs: [], confidence: 0.95 })];
    const loaded = new Set((lp.lines || []).map((l) => digits(l.batch)).filter(Boolean));
    return coa.map((d) => { const b = digits(d.fields.batch); const r = [ref(d, "batch", d.fields.batch)];
      return result(rule, { subject: "COA batch " + (d.fields.batch || "?") + " · " + (d.fields.sku || ""), expected: "a batch on the loading plan (" + [...loaded].join(", ") + ")", found: d.fields.batch || "missing", docs: r, ...guard(rule, loaded.has(b) ? "match" : "mismatch", r),
        path: ["connected data: factory loading plan " + (lp._source || ""), "batches loaded: " + [...loaded].join(", ")] }); });
  },
  containers_match(rule, ctx) {
    const lp = ctx.connected.loading_plan, bl = byType(ctx.docs, "bill_of_lading");
    if (!lp || !bl.length) return [result(rule, { subject: "Containers vs loading plan", status: "skipped", found: !lp ? "loading plan not connected" : "no BL", docs: [] })];
    const planned = new Set((lp.lines || []).map((l) => up(l.container)).filter(Boolean));
    return bl.map((d) => { const onBl = new Set((d.fields.containers || []).map((c) => up(c.container || c)).filter(Boolean)); const r = [ref(d, "containers", [...onBl].join(", "))];
      const ok = onBl.size && [...onBl].every((c) => planned.has(c)) && [...planned].every((c) => onBl.has(c));
      return result(rule, { subject: "Containers · " + docLabel(d), expected: [...planned].join(", ") + " (loading plan)", found: [...onBl].join(", ") || "none listed", docs: r, ...guard(rule, ok ? "match" : "mismatch", r) }); });
  },
  vessel_match(rule, ctx) {
    const src = ctx.connected.booking || ctx.connected.loading_plan, bl = byType(ctx.docs, "bill_of_lading");
    if (!src || !bl.length) return [result(rule, { subject: "Vessel vs booking", status: "skipped", found: "booking not connected", docs: [] })];
    return bl.map((d) => { const r = [ref(d, "vessel", d.fields.vessel)]; const ok = normParty(d.fields.vessel) && normParty(d.fields.vessel) === normParty(src.vessel);
      return result(rule, { subject: "Vessel · " + docLabel(d), expected: src.vessel + " (booking)", found: d.fields.vessel || "missing", docs: r, ...guard(rule, ok ? "match" : "mismatch", r) }); });
  },
};

// ---------- small utilities ----------
function pick(g) { return { status: g.status, confidence: g.confidence, lowConf: g.lowConf }; }
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 }));
const label = (f) => ({ port_of_loading: "Port of loading", port_of_discharge: "Port of discharge" }[f] || f);
function docLabel(d) {
  const t = { commercial_invoice: "invoice", packing_list: "packing list", bill_of_lading: d.fields && d.fields.is_draft ? "draft BL" : "BL", certificate_of_origin: d.fields && d.fields.is_draft ? "draft COO" : "COO", certificate_of_analysis: "COA", booking_confirmation: "booking", loading_plan: "loading plan" }[d.doc_type] || d.doc_type;
  const id = d.fields && (d.fields.invoice_no || d.fields.bl_no || d.fields.reference_no || d.fields.doc_no);
  return id ? t + " " + id : t;
}
// many identical "match" rows (e.g. HS per line) collapse into one row; problems stay individual
function collapseMatches(rows, rule, subject) {
  const ok = rows.filter((r) => r.status === "match"), rest = rows.filter((r) => r.status !== "match");
  if (ok.length > 1) rest.unshift(result(rule, { subject: subject + " (" + ok.length + " lines)", status: "match", found: ok.map((r) => r.found).join(", "), docs: ok.flatMap((r) => r.docs), confidence: Math.min(...ok.map((r) => r.confidence || 1)) }));
  else rest.unshift(...ok);
  return rest;
}

// voyage = the best evidence for POL/POD (BL beats packing list beats invoice; a country is weaker than a port)
function voyage(docs) {
  const order = ["bill_of_lading", "packing_list", "certificate_of_origin", "commercial_invoice"];
  const get = (f) => { for (const t of order) for (const d of byType(docs, t)) { const p = resolvePlace(d.fields[f]); if (p.kind === "port") return { ...p, source: docLabel(d) }; } return null; };
  return { pol: get("port_of_loading"), pod: get("port_of_discharge") };
}

function requiredDocs(docs) {
  const req = db.prepare("SELECT id, name FROM doc_types WHERE required_in_packet=1").all();
  const have = new Set(docs.map((d) => d.doc_type));
  return req.map((t) => ({ rule_id: "DOCS-REQ", rule_name: "Required documents are attached", severity: "critical", level: 0, scope: "customer · document set",
    subject: t.name, status: have.has(t.id) ? "match" : "mismatch", expected: "attached", found: have.has(t.id) ? "attached" : "missing", docs: [], confidence: 1,
    explanation: "CG cannot clear a shipment with a document missing from the set.", path: ["document set for this customer", t.name + " required"] }));
}

// ---------- public: verify a packet at a data level ----------
// level 0: documents only · 1: + booking & loading plan · 2: + ETA · 3: + cost of delay · 4: + history & autonomy
function verify(docs, connected = {}, level = 0) {
  const rules = db.prepare("SELECT * FROM rules WHERE status='confirmed' ORDER BY rowid").all();
  const ctx = { docs: docs.filter((d) => d.status !== "error"), connected: level >= 1 ? connected : {}, voyage: voyage(docs) };
  const checks = [...requiredDocs(ctx.docs)];
  for (const r of rules) {
    if (r.level > level) continue;
    const fn = CHECKS[r.check_type];
    if (!fn) continue;
    try { checks.push(...fn(r, ctx)); } catch (e) { checks.push(result(r, { subject: r.name, status: "uncertain", found: "check failed: " + e.message, docs: [], confidence: 0 })); }
  }
  for (const d of docs.filter((x) => x.status === "error")) checks.push({ rule_id: "READ", rule_name: "Document could be read", severity: "critical", level: 0, scope: "intake", subject: d.filename, status: "uncertain", expected: "readable", found: "could not read: " + (d.error || "unknown"), docs: [], confidence: 0, explanation: "The agent never approves a document it could not read." });
  return checks;
}

module.exports = { verify, resolvePlace, normParty, voyage, docLabel, INCOTERMS };
