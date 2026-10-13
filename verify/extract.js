// Document understanding: any attachment in → {doc_type, fields, confidence, unreadable} out.
// Text-first (cheap, exact), vision only when a PDF has no text layer or for images.
// Document types and their fields come from the doc_types table, so a new type is data, not code.
const crypto = require("crypto");
const pdf = require("pdf-parse");
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");
const { db, J } = require("./store");

const VERSION = "x3";
const TEXT_MIN_WORDS = 40;

// expand zip attachments into their files (COA bundles arrive zipped)
function expand(files) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.filename)) {
      try {
        const z = new AdmZip(f.bytes);
        for (const e of z.getEntries()) if (!e.isDirectory && !/__MACOSX|\/\./.test(e.entryName)) out.push(...expand([{ filename: e.entryName.split("/").pop(), bytes: e.getData(), from_zip: f.filename }]));
      } catch (e) { out.push({ ...f, error: "could not open zip: " + e.message }); }
    } else out.push(f);
  }
  // identical files sent twice (common in real mail) are read once
  const seen = new Set();
  return out.filter((f) => { const h = sha(f.bytes); if (seen.has(h)) return false; seen.add(h); return true; });
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const mimeOf = (name) => (/\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.xlsx?$/i.test(name) ? "application/xlsx" : /\.csv$/i.test(name) ? "text/csv" : "application/octet-stream");

async function textOf(f) {
  const mime = mimeOf(f.filename);
  if (mime === "application/pdf") {
    const d = await pdf(f.bytes, { max: 4 }); // transport docs carry pages of legal terms; the data is on the first pages
    const words = (d.text.match(/[A-Za-z0-9]{2,}/g) || []).length;
    return { mode: words >= TEXT_MIN_WORDS ? "text" : "vision", text: d.text, pages: d.numpages, mime };
  }
  if (mime === "application/xlsx") {
    const wb = XLSX.read(f.bytes, { type: "buffer" });
    const text = wb.SheetNames.map((n) => "# sheet " + n + "\n" + XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })).join("\n");
    return { mode: "text", text, pages: wb.SheetNames.length, mime };
  }
  if (mime === "text/csv") return { mode: "text", text: f.bytes.toString("utf8"), pages: 1, mime };
  if (mime.startsWith("image/")) return { mode: "vision", text: "", pages: 1, mime };
  return { mode: "unsupported", text: "", pages: 0, mime };
}

function prompt() {
  const types = db.prepare("SELECT id, name, description, fields_json FROM doc_types").all();
  return "You read trade documents for a freight document checker. Identify the document type and extract its fields.\n" +
    "Document types and their fields:\n" + types.map((t) => "- " + t.id + " (" + t.name + ": " + t.description + "): " + t.fields_json).join("\n") +
    "\n- other: anything else (return fields: {title})\n\n" +
    "Return ONLY a JSON object, no markdown:\n" +
    '{ "doc_type": one of the ids above, "fields": {...the fields for that type...}, "confidence": { field_name: 0-1 for every top-level field you return }, "unreadable": [field names that are present but obscured or illegible] }\n' +
    "Rules:\n- Copy values exactly as printed (names, addresses, codes). Numbers as plain numbers without thousands separators.\n" +
    "- If a field is not on the document, use null. If it is there but you cannot read it, use null AND list it in unreadable. Never guess a value.\n" +
    "- Draft documents (marked draft / for review / DCOO) get is_draft true.\n- For lines, include every product line. hs_code digits only.\n" +
    "- confidence reflects how sure you are you read the value correctly, not whether it is right.";
}

async function extract(f, callLLM) {
  const h = sha(f.bytes);
  const cached = db.prepare("SELECT json FROM extraction_cache WHERE sha=? AND version=?").get(h, VERSION);
  if (cached) return { ...J(cached.json), sha: h, cached: true };
  const t = await textOf(f);
  if (t.mode === "unsupported") return { sha: h, doc_type: "other", fields: {}, confidence: {}, unreadable: [], extractor: "none", error: "unsupported file type", mime: t.mime };
  let content;
  if (t.mode === "text") content = [{ type: "text", text: "File: " + f.filename + "\n\n" + t.text.slice(0, 16000) }];
  else if (t.mime === "application/pdf") content = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.bytes.toString("base64") } }, { type: "text", text: "File: " + f.filename }];
  else content = [{ type: "image", source: { type: "base64", media_type: t.mime, data: f.bytes.toString("base64") } }, { type: "text", text: "File: " + f.filename }];
  // the instructions are identical on every call: marked cacheable so repeated calls pay the cache-read price
  const raw = await callLLM({ max_tokens: 4000, system: [{ type: "text", text: prompt(), cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content }] });
  const out = parseJSON(raw);
  const res = { doc_type: out.doc_type || "other", fields: out.fields || {}, confidence: flatConf(out.confidence || {}), unreadable: out.unreadable || [], extractor: t.mode === "text" ? "text + model" : "vision", pages: t.pages, mime: t.mime };
  for (const k of res.unreadable) res.confidence[k] = Math.min(res.confidence[k] ?? 0.3, 0.3); // unreadable can never look confident
  db.prepare("INSERT OR REPLACE INTO extraction_cache(sha, version, json) VALUES (?,?,?)").run(h, VERSION, JSON.stringify(res));
  return { ...res, sha: h, cached: false };
}
function flatConf(c) { const o = {}; for (const [k, v] of Object.entries(c)) o[k] = typeof v === "number" ? v : typeof v === "object" && v ? Math.min(...Object.values(v).filter((x) => typeof x === "number"), 1) : 0.9; return o; }
function parseJSON(text) {
  let t = (text || "").replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error("model returned no JSON");
  t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (_) { return JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); }
}

module.exports = { extract, expand, mimeOf, sha, VERSION };
