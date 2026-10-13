// Trade Knowledge Store + verification tables.
// Architecture is fixed; everything a tenant can change (document types, rules, aliases,
// classifications) is DATA in these tables, seeded below and editable at runtime.
const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "..", "freight.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS doc_types(
  id TEXT PRIMARY KEY, name TEXT, description TEXT, fields_json TEXT, required_in_packet INT DEFAULT 0, connected_data INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS rules(
  id TEXT PRIMARY KEY, name TEXT, check_type TEXT, params_json TEXT, severity TEXT,
  scope_level TEXT, scope_key TEXT, level INT DEFAULT 0, explain TEXT,
  status TEXT DEFAULT 'confirmed', version INT DEFAULT 1, source TEXT, owner TEXT, visibility TEXT, valid_from TEXT);
CREATE TABLE IF NOT EXISTS facts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT, predicate TEXT, object TEXT, scope TEXT,
  status TEXT, confidence REAL, source TEXT, owner TEXT, visibility TEXT,
  valid_from TEXT, valid_to TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS aliases(kind TEXT, alias TEXT, canonical TEXT, PRIMARY KEY(kind, alias));
CREATE TABLE IF NOT EXISTS packets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, message_id TEXT, from_addr TEXT, to_addr TEXT,
  subject TEXT, body TEXT, received_at TEXT, status TEXT, shipment_ref TEXT, customer TEXT,
  progress_json TEXT, summary_json TEXT, draft_json TEXT, replied_at TEXT, outcome TEXT, error TEXT, synthetic INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id INT, filename TEXT, sha TEXT, mime TEXT, doc_type TEXT,
  extractor TEXT, fields_json TEXT, confidence_json TEXT, unreadable_json TEXT, status TEXT, error TEXT, bytes BLOB);
CREATE TABLE IF NOT EXISTS checks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id INT, rule_id TEXT, rule_name TEXT, subject TEXT,
  status TEXT, severity TEXT, level INT, docs_json TEXT, expected TEXT, found TEXT, confidence REAL,
  explanation TEXT, path_json TEXT, customer TEXT, shipment_ref TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS decisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id INT, check_id INT, rule_id TEXT, agent_status TEXT,
  cg_status TEXT, note TEXT, by TEXT, at TEXT DEFAULT (datetime('now')), synthetic INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS extraction_cache(sha TEXT, version TEXT, json TEXT, at TEXT DEFAULT (datetime('now')), PRIMARY KEY(sha, version));
CREATE TABLE IF NOT EXISTS system_records(kind TEXT, ref TEXT, json TEXT, source TEXT, PRIMARY KEY(kind, ref));
`);

// columns added after first release (safe on existing databases)
for (const sql of ["ALTER TABLE packets ADD COLUMN draft_mail_id TEXT", "ALTER TABLE packets ADD COLUMN draft_placed_at TEXT", "ALTER TABLE packets ADD COLUMN via TEXT",
  "ALTER TABLE rules ADD COLUMN party TEXT", "ALTER TABLE packets ADD COLUMN counterparty TEXT", "ALTER TABLE packets ADD COLUMN scope_json TEXT"]) { try { db.exec(sql); } catch (_) {} }

// ---------------- seed configuration (only if empty) ----------------
function seed() {
  const has = db.prepare("SELECT COUNT(*) n FROM doc_types").get().n;
  if (has) return;
  const insDT = db.prepare("INSERT INTO doc_types VALUES (?,?,?,?,?,?)");
  const T = (id, name, desc, fields, req = 0, connected = 0) => insDT.run(id, name, desc, JSON.stringify(fields), req, connected);
  T("commercial_invoice", "Commercial invoice", "Seller's invoice to the buyer", {
    invoice_no: "string", invoice_date: "string", seller: "string", sold_to_name: "string", sold_to_address: "string",
    ship_to_name: "string", ship_to_address: "string", incoterm: "string (3-letter code only, e.g. FOB)", incoterm_place: "string (named place after the code, null if none)",
    port_of_loading: "string", port_of_discharge: "string", currency: "string", customer_po: "string", shipment_ref: "string",
    lines: "array of {sku, description, country_of_origin (2-letter), hs_code (digits only), qty (number), uom, amount (number)}",
    total_qty: "number", total_amount: "number" }, 1);
  T("packing_list", "Packing list", "Quantities, weights and volumes per line", {
    doc_no: "string", ship_to_name: "string", ship_to_address: "string", port_of_loading: "string", port_of_discharge: "string", incoterm: "string",
    lines: "array of {sku, description, qty (number), net_kg (number), gross_kg (number), container}",
    total_qty: "number", total_net_kg: "number", total_gross_kg: "number", containers: "array of container numbers" }, 1);
  T("bill_of_lading", "Bill of lading / sea waybill", "Carrier's transport document (draft or final)", {
    bl_no: "string", is_draft: "boolean", shipper: "string", consignee_name: "string", consignee_address: "string", notify_name: "string",
    vessel: "string", voyage: "string", port_of_loading: "string", port_of_discharge: "string", place_of_delivery: "string",
    on_board_date: "string (YYYY-MM-DD, shipped on board / laden on board date)", hs_codes: "array of HS / HSN codes printed (digits only)",
    total_packages: "number", gross_kg: "number", net_kg: "number",
    containers: "array of {container, seal, packages (number), gross_kg (number)}",
    goods_lines: "array of {description, qty (number)}", po_refs: "array of strings" }, 1);
  T("certificate_of_origin", "Certificate of origin", "Origin certificate, e.g. ASEAN Form D or Form B", {
    reference_no: "string", form_type: "string", is_draft: "boolean", exporter: "string", consignee_name: "string", consignee_address: "string",
    port_of_loading: "string", port_of_discharge: "string", vessel: "string", shipment_date: "string (YYYY-MM-DD)", country_of_origin: "string", invoice_refs: "array of strings", po_refs: "array of strings",
    lines: "array of {description, hs_code (digits only), qty (number)}" });
  T("certificate_of_analysis", "Certificate of analysis", "Quality certificate per product batch", {
    sku: "string", description: "string", batch: "string", manufacturing_date: "string", best_before: "string", all_results_pass: "boolean" });
  T("booking_confirmation", "Booking confirmation", "Carrier booking (connected data)", {
    booking_no: "string", shipper: "string", vessel: "string", voyage: "string", port_of_loading: "string", port_of_discharge: "string",
    etd: "string (YYYY-MM-DD)", eta: "string (YYYY-MM-DD)", containers: "string" }, 0, 1);
  T("loading_plan", "Loading plan / code list", "Factory loading breakdown per container with batches (connected data)", {
    invoice_ref: "string", bl_no: "string", vessel: "string", etd: "string", eta: "string", consignee: "string",
    lines: "array of {sku, description, qty (number), batch, container, seal}" }, 0, 1);

  // Ports and countries as aliases (entity resolution is data)
  const insA = db.prepare("INSERT OR IGNORE INTO aliases VALUES (?,?,?)");
  const ports = { SGSIN: ["SINGAPORE", "SINGAPORE, SINGAPORE", "SGSIN"], IDJKT: ["JAKARTA", "TANJUNG PRIOK", "IDJKT", "JAKARTA, INDONESIA"],
    IDBLW: ["BELAWAN", "IDBLW", "BELAWAN, INDONESIA"], GQSSG: ["MALABO", "GQSSG", "MALABO, EQUATORIAL GUINEA"],
    INNSA: ["NHAVA SHEVA", "JNPT", "INNSA"], CLSAI: ["SAN ANTONIO", "SAN ANTONIO, CHILE", "CLSAI"], INBOM: ["MUMBAI", "BOMBAY", "INBOM"], ESVLC: ["VALENCIA", "ESVLC"], ZADUR: ["DURBAN", "ZADUR"] };
  for (const [code, list] of Object.entries(ports)) for (const a of list) insA.run("port", a, code);
  for (const c of ["INDONESIA", "SINGAPORE", "SPAIN", "INDIA", "EQUATORIAL GUINEA", "SOUTH AFRICA", "MALAYSIA", "THAILAND", "CHINA", "VIETNAM", "CHILE"]) insA.run("country", c, c);
  for (const [a, c] of [["ID", "INDONESIA"], ["SG", "SINGAPORE"], ["ZA", "SOUTH AFRICA"], ["ES", "SPAIN"], ["IN", "INDIA"], ["GQ", "EQUATORIAL GUINEA"]]) insA.run("country", a, c);

  // Rules: data, scoped regulation -> agreement -> customer -> shipment. level = which data layer they need.
  const insR = db.prepare(`INSERT INTO rules(id,name,check_type,params_json,severity,scope_level,scope_key,level,explain,source,owner,visibility,valid_from)
                           VALUES (@id,@name,@check_type,@params,@severity,@scope_level,@scope_key,@level,@explain,@source,@owner,@visibility,'2026-01-01')`);
  const R = (r) => insR.run({ level: 0, source: "curated", owner: "GoComet", visibility: "public", scope_key: "*", ...r, params: JSON.stringify(r.params || {}) });
  R({ id: "INC-VALID", name: "Incoterm is a valid Incoterms 2020 code", check_type: "incoterm_valid", severity: "critical", scope_level: "regulation", scope_key: "Incoterms 2020",
      explain: "Incoterms 2020 defines 11 terms. Anything else is not a valid trade term." });
  R({ id: "INC-PLACE", name: "Incoterm names the right place", check_type: "incoterm_place", severity: "critical", scope_level: "regulation", scope_key: "Incoterms 2020",
      explain: "F-terms (FCA, FAS, FOB) name the place of shipment; C- and D-terms name the destination." });
  R({ id: "PORT-IS-PORT", name: "Ports are ports, not countries", check_type: "port_is_port", severity: "normal", scope_level: "regulation", scope_key: "Customs data quality",
      explain: "Customs and carriers need a named port. A country alone cannot be matched to a port call." });
  R({ id: "POL-MATCH", name: "Port of loading agrees across documents", check_type: "port_consistent", params: { field: "port_of_loading" }, severity: "critical", scope_level: "regulation", scope_key: "Document consistency",
      explain: "Invoice, packing list, bill of lading and certificate of origin must describe the same voyage." });
  R({ id: "POD-MATCH", name: "Port of discharge agrees across documents", check_type: "port_consistent", params: { field: "port_of_discharge" }, severity: "critical", scope_level: "regulation", scope_key: "Document consistency",
      explain: "A different discharge port on any document stops clearance at destination." });
  R({ id: "CNEE-MATCH", name: "Consignee agrees across documents", check_type: "consignee_consistent", severity: "critical", scope_level: "regulation", scope_key: "Document consistency",
      explain: "Customs releases goods to the consignee on the bill of lading. Invoice and certificate of origin must name the same party." });
  R({ id: "QTY-MATCH", name: "Total quantity agrees (invoice, packing list, BL)", check_type: "qty_consistent", severity: "critical", scope_level: "regulation", scope_key: "Document consistency",
      explain: "Declared packages must equal invoiced and packed quantity, or customs will hold the cargo for inspection." });
  R({ id: "SKU-QTY", name: "Quantity per product agrees (invoice vs packing list)", check_type: "sku_qty", severity: "normal", scope_level: "regulation", scope_key: "Document consistency",
      explain: "Each product line on the invoice must match the packing list." });
  R({ id: "WGT-MATCH", name: "Weights agree (packing list vs BL)", check_type: "weight_consistent", params: { tolerance_pct: 0.5 }, severity: "normal", scope_level: "regulation", scope_key: "Document consistency",
      explain: "Gross weight on the bill of lading must match the packing list within 0.5%." });
  R({ id: "HS-FORMAT", name: "Every line has an HS code of at least 6 digits", check_type: "hs_format", params: { min_digits: 6 }, severity: "critical", scope_level: "regulation", scope_key: "WCO Harmonized System",
      explain: "The first 6 digits are international. Missing or short codes cannot be declared." });
  R({ id: "HS-KNOWN", name: "HS code matches the confirmed classification", check_type: "hs_known", severity: "critical", scope_level: "customer", scope_key: "Unilever classification register",
      explain: "Each product has one confirmed classification. A different code, or two codes for the same product family, needs a human.", owner: "Unilever trade compliance", visibility: "private", source: "classification register" });
  R({ id: "HS-ACROSS", name: "HS code agrees across invoice, COO and BL", check_type: "hs_across", severity: "critical", scope_level: "regulation", scope_key: "WCO Harmonized System",
      explain: "The first 6 digits are the same in every country and must match on every document. Digits 7–8 are national; a difference there can be legitimate (export vs import tariff), so a person decides." });
  R({ id: "SHIP-DATE", name: "Shipment date agrees (COO vs BL)", check_type: "ship_date", severity: "normal", scope_level: "agreement", scope_key: "Origin rules",
      explain: "The certificate of origin's shipment date should match the date the goods went on board." });
  R({ id: "DUP-LINE", name: "No duplicated invoice lines", check_type: "duplicate_lines", severity: "normal", scope_level: "regulation", scope_key: "Document consistency",
      explain: "The same product twice on one invoice is often a copy error, sometimes a split batch." });
  R({ id: "ORIGIN-MATCH", name: "Origin agrees (invoice vs certificate of origin)", check_type: "origin_consistent", severity: "critical", scope_level: "agreement", scope_key: "ATIGA / origin rules",
      explain: "Preferential duty depends on the certificate of origin matching the invoiced origin." });
  R({ id: "COA-BATCH", name: "Every quality certificate matches a loaded batch", check_type: "coa_batches", severity: "normal", scope_level: "customer", scope_key: "Unilever QA", level: 1,
      explain: "Each certificate of analysis must belong to a batch that was actually loaded (from the factory loading plan).", owner: "Unilever QA", visibility: "private" });
  R({ id: "CNTR-MATCH", name: "Containers on BL match the loading plan", check_type: "containers_match", severity: "critical", scope_level: "regulation", scope_key: "Document consistency", level: 1,
      explain: "Container and seal numbers on the bill of lading must match what the factory loaded." });
  R({ id: "VSL-MATCH", name: "Vessel agrees with the booking", check_type: "vessel_match", severity: "normal", scope_level: "regulation", scope_key: "Document consistency", level: 1,
      explain: "A different vessel on the BL than in the booking usually means the draft is stale." });

  // Classification register (knowledge store facts). Real SKUs from the shared shipments.
  const insF = db.prepare(`INSERT INTO facts(subject,predicate,object,scope,status,confidence,source,owner,visibility,valid_from) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const F = (s, p, o, status, conf, source) => insF.run(s, p, o, "Unilever", status, conf, source, "Unilever trade compliance", "private", "2026-01-01");
  F("64331808", "classified_as", "340290", "confirmed", 0.98, "classification register");
  F("64331805", "classified_as", "340290", "confirmed", 0.98, "classification register");
  F("67956846", "classified_as", "340220", "confirmed", 0.95, "classification register");
  F("67956846", "same_family_as", "64331808", "proposed", 0.82, "agent: same pack (16x660G), same product type (cream cleaner), different brand name Jif/Cif");
  F("69795579", "classified_as", "34011100", "confirmed", 0.97, "classification register");
  F("69795583", "classified_as", "34011100", "confirmed", 0.97, "classification register");
  F("69795582", "classified_as", "34011100", "confirmed", 0.97, "classification register");
  F("62723264", "classified_as", "34013000", "confirmed", 0.97, "classification register");
  F("62727092", "classified_as", "34013000", "confirmed", 0.97, "classification register");
  F("62723266", "classified_as", "34013000", "confirmed", 0.97, "classification register");
}
seed();

// Desk scoping (safe to re-run): a rule may belong to one party. Whether it runs depends on whose desk the inbox is
// (verify/desk.js): the home party's own rules always, another party's rules only when that party shares them.
function deskRules() {
  db.prepare("UPDATE rules SET party='Unilever' WHERE id IN ('HS-KNOWN','COA-BATCH') AND party IS NULL").run();
  db.prepare(`INSERT OR IGNORE INTO rules(id,name,check_type,params_json,severity,scope_level,scope_key,level,explain,source,owner,visibility,valid_from,party)
    VALUES ('COO-PREF','Certificate of origin attached (needed to claim the duty preference)','doc_present',?,'critical','customer','RP Investments import requirements',0,
    'The importer claims a preferential duty rate, which customs grants only with a certificate of origin. Without it the shipment pays full duty.',
    'demo configuration','RP Investments trade compliance','private','2026-01-01','RP Investments International SL')`).run(JSON.stringify({ doc_type: "certificate_of_origin" }));
}
deskRules();

const J = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
module.exports = { db, J };
