// Deterministic SYNTHETIC workbooks for the ingestion suites (office:ingestion:test). Every product, SKU, model,
// URL (example.invalid), price, note and manufacturer name is fabricated, except the "TP-Link" / "TP-Link Omada" pair,
// which exercises the manufacturer alias already built into src/lead-agents/ingestion-evidence.js. No supplier data.
// The workbooks reproduce the structure the suites assert (sheets, headers, row counts, roles, attribute and image
// totals), not any real catalogue.
//   node scripts/fixtures/build-ingestion-fixtures.js           write scripts/fixtures/ingestion/*.xlsx
//   node scripts/fixtures/build-ingestion-fixtures.js --check   fail if the committed files differ from the generator
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { zipSync, strToU8 } = require("fflate");

const DIR = path.join(__dirname, "ingestion");
const FILES = { products: "synthetic-50-products.xlsx", master: "synthetic-research-master.xlsx" };
const MTIME = new Date("2026-01-01T00:00:00Z");

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const column = (n) => { let s = ""; for (n += 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
function sheetXml(rows) {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    if (v === null || v === undefined || v === "") return "";
    const ref = `${column(c)}${r + 1}`;
    return typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}
function workbook(sheets) {
  const files = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows); });
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [strToU8(v), { mtime: MTIME }]]))));
}

// ---- shared synthetic catalogue: 50 products ----
// 20 reviewed manufacturer labels -> 19 canonical names (TP-Link Omada aliases TP-Link); 12 products with no confirmed OEM.
const FABRICATED = ["Vantorel", "Quillmark Systems", "Brasswick", "Orinel Labs", "Tessaline", "Kordova Electric", "Halvenridge",
  "Mirrovale", "Pelterra", "Sundrake", "Corvalin", "Ostrevia", "Lumbrecht", "Varnholt", "Elsinora", "Gristmere", "Pyrandel", "Tavrick"];
const LABELS = ["TP-Link", "TP-Link Omada", ...FABRICATED];
const OEM_INDEXES = new Set([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44]);
const CATEGORY_PATHS = [
  "Residential Smart Home > Smart Switches & Lighting", "Residential Smart Home > Smart Plugs & Relays", "Residential Smart Home > Hubs & IR",
  "Residential Smart Home > Curtain Motors", "Residential Security > Smart Locks", "Residential Security > Video Doorbells",
  "Residential Security > Indoor Cameras", "Commercial Security > Access Control Readers", "Commercial Security > Intercom Panels",
  "Building Infrastructure > Automation & Controls", "Building Infrastructure > Network Switches", "Building Infrastructure > Wireless Access Points",
  "Building Infrastructure > Routers", "Building Safety & Environmental > Smoke Detectors", "Building Safety & Environmental > Water Leak Sensors",
  "Building Safety & Environmental > Air Quality Monitors", "Power & Utility Metering > Energy Meters", "Power & Utility Metering > Water Meters",
  "Industrial IoT & Gateways > Edge Gateways", "Industrial IoT & Gateways > Protocol Converters", "Electrical & Power Control > Contactors",
  "Electrical & Power Control > DIN Rail Relays", "Installation Accessories > Mounting Brackets", "Installation Accessories > Low Voltage Cables",
  "Installation Accessories > Power Supplies"];
const IMPORT_CATEGORIES = ["Smart Switches", "Smart Plugs", "Smart Lighting", "Curtain Motors", "Home Automation", "Smart Locks", "Door Locks", "CCTV",
  "Security Cameras", "Video Doorbells", "Intercom", "Access Control", "Routers", "Network Switches", "Wireless Access Points", "Industrial Networking",
  "Motion Sensors", "Smoke Detectors", "Water Leak Sensors", "Environmental Sensors", "Power and Utility Metering", "Smart Hubs", "Gateways",
  "Controllers", "Control Panels", "Cables", "Power Supplies"];
const KEYS = [["Wi-Fi band", "GHz"], ["Supply voltage", "V"], ["Power draw", "W"], ["Width", "mm"], ["Operating temperature max", "°C"],
  ["Humidity tolerance", "%"], ["Sensitivity", "dB"], ["Height", "mm"], ["Depth", "mm"], ["Standby power", "W"], ["Relay rating", "V"],
  ["Radio band", "GHz"], ["Input voltage", "V"], ["Output voltage", "V"], ["Peak power", "W"], ["Cable length", "mm"], ["Signal margin", "dB"],
  ["Minimum temperature", "°C"], ["Duty cycle", "%"], ["Backup band", "GHz"], ["Bracket depth", "mm"], ["Coil voltage", "V"], ["Load power", "W"],
  ["Gain", "dB"], ["Lens width", "mm"], ["Rated humidity", "%"], ["Ambient max", "°C"], ["Mesh band", "GHz"], ["Battery voltage", "V"],
  ["Sleep power", "W"], ["Panel width", "mm"], ["Noise floor", "dB"], ["Detection range", "mm"]];
// 149 attributes in total: three per product with one product at seven and four at one or four.
const SPEC_COUNTS = Array.from({ length: 50 }, (_, i) => ({ 1: 7, 2: 1, 3: 1, 4: 1, 5: 4 })[i] ?? 3);

function products() {
  let labelUse = 0;
  return Array.from({ length: 50 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    const oem = OEM_INDEXES.has(i);
    const label = oem ? "Unconfirmed OEM" : LABELS[labelUse++ % LABELS.length];
    const specs = Array.from({ length: SPEC_COUNTS[i] }, (_, k) => {
      const [key, unit] = i === 0 && k === 1 ? ["Wi-Fi band", "GHz"] : KEYS[(i * 3 + k + (i === 0 ? 1 : 0)) % KEYS.length];
      return { key, value: String(((i + 1) * (k + 3)) % 97 + 1), unit };
    }).filter((s, k, all) => all.findIndex((x) => x.key === s.key) === k);
    return {
      i, n, oem, label, specs,
      name: `Synthetic Fixture Device ${n}`,
      sku: `SYN-ING-${n}`,
      model: oem ? "Model pending" : `SFX-${n}${String.fromCharCode(65 + (i % 26))}`,
      path: CATEGORY_PATHS[i % 25],
      category: IMPORT_CATEGORIES[i % 27],
      collection: ["Residential", "Commercial", "Infrastructure"][(i % 25) % 3], // one collection per category path (taxonomy group context)
      url: `https://catalogue.example.invalid/listing/${(i % 39) + 1}`,
      price: i % 2 === 0 || i === 49 ? 10000 + i * 731 : null,
      note: `Synthetic review note ${(i % 28) + 1}`,
    };
  });
}

function productsWorkbook() {
  const header = ["Product name", "SKU", "Category", "Description", "Brand", "Manufacturer model", "Short description", "Specifications", "Collection",
    "Source product URL", "Secondary source URL", "Retail benchmark NGN - unapproved", "Dealer price NGN - unverified", "Approved selling price NGN",
    "Stock quantity - unverified", "Availability", "Warranty", "Compatibility", "Image 1 - Cover", "Image 2 - Alternate", "Image 3 - Rear detail",
    "Image 4 - Installation", "Image 5 - Dimensions", "Images obtained", "Supplier verification", "Data confidence", "Review notes", "Import status"];
  const rows = products().map((p) => [p.name, p.sku, p.category, `Fabricated description for fixture device ${p.n}.`, p.label, p.model,
    `Fixture device ${p.n}`, p.specs.map((s) => `${s.key}: ${s.value} ${s.unit}`).join("; "), p.collection, p.url,
    p.i < 12 ? `https://datasheet.example.invalid/${(p.i % 11) + 1}` : "", p.price, "", "", "", "Source availability unconfirmed", "",
    "Compatibility not confirmed", "", "", "", "", "", 0, "Supplier not verified", ["Low", "Medium", "High"][p.i % 3], p.note, "Draft review only"]);
  return workbook([{ name: "Products", rows: [header, ...rows] }]);
}

function masterWorkbook() {
  const all = products();
  const productHeader = ["Product name", "SKU", "Category path", "Full description", "Brand / manufacturer", "Manufacturer model", "Short description",
    "Structured specifications JSON", "Collection", "Retail listing / origin URL", "Manufacturer/datasheet URL", "Retail benchmark NGN (unapproved)",
    "Dealer cost NGN (unapproved)", "Selling price NGN (unapproved)", "Physical stock quantity (unverified)", "Stock status", "Warranty status",
    "Manufacturer photo rights", "Image requirement", "Specification evidence", "Integration", "Import state"];
  const productRows = all.map((p) => [p.name, p.sku, p.path, `Fabricated description for fixture device ${p.n}.`, p.label, p.model, `Fixture device ${p.n}`,
    JSON.stringify(p.specs), p.collection, p.url, p.i < 17 ? `https://datasheet.example.invalid/${(p.i % 16) + 1}` : "", p.price, "", "", "",
    "Unconfirmed", "Not confirmed", "Rights not confirmed", "Five photographs required", p.i % 2 ? "Listing only" : "Datasheet reviewed",
    "Not certified", "Draft review only"]);
  const specRows = all.flatMap((p) => p.specs.map((s, k) => [p.sku, k + 1, s.key, s.value, s.unit, k % 2 ? "Listing" : "Datasheet",
    `https://evidence.example.invalid/${(p.i % 41) + 1}`, k % 2 ? "Pending" : "Checked"]));
  const photoTypes = ["Cover", "Alternate", "Rear detail", "Installation", "Dimensions"];
  const photoRows = all.flatMap((p) => photoTypes.map((t, k) => [p.sku, k + 1, t, "Required", "", `https://photos.example.invalid/${(p.i % 39) + 1}`,
    "Rights not confirmed", "No"]));
  const qaHeader = ["SKU", "Product", "Category path suggestion", "Category action", "Brand source", "Brand action", "Model source", "Model action",
    "Specs count", "Spec confidence", "Images complete", "Image action", "Supplier verified", "Stock confirmed", "Sale price approved", "Notes"];
  const qaRows = all.map((p) => [p.sku, p.name, p.path, "Confirm category", p.label, "Confirm brand", p.model, "Confirm model", p.specs.length,
    p.i % 2 ? "Medium" : "High", "No", "Request photographs", "No", "No", "No", p.note]);
  const readme = [["Synthetic research master (fixture)", ""], ...Array.from({ length: 21 }, (_, k) => [`Fixture note ${k + 1}`,
    "Fabricated workbook for automated tests. Not a catalogue, price list or supplier record."])];
  return workbook([
    { name: "PRODUCTS_IMPORT_V2", rows: [productHeader, ...productRows] },
    { name: "SPECIFICATIONS", rows: [["SKU", "Attribute #", "Specification key", "Value", "Unit", "Evidence quality", "Evidence URL", "Validation status"], ...specRows] },
    { name: "PHOTO_REQUIREMENTS", rows: [["SKU", "Photo number", "Photo type", "Status", "Photo filename", "Source to request", "Rights", "Verified exact SKU"], ...photoRows] },
    { name: "VERIFICATION_QUEUE", rows: [qaHeader, ...qaRows] },
    { name: "READ_ME", rows: readme },
  ]);
}

const build = () => ({ [FILES.products]: productsWorkbook(), [FILES.master]: masterWorkbook() });
const fixturePath = (key) => path.join(DIR, FILES[key]);

if (require.main === module) {
  const built = build();
  if (process.argv.includes("--check")) {
    const stale = Object.entries(built).filter(([name, bytes]) => !fs.existsSync(path.join(DIR, name)) || !fs.readFileSync(path.join(DIR, name)).equals(bytes));
    if (stale.length) { console.error(`stale fixtures: ${stale.map(([n]) => n).join(", ")}`); process.exit(1); }
    console.log("ingestion fixtures match the generator");
  } else {
    fs.mkdirSync(DIR, { recursive: true });
    for (const [name, bytes] of Object.entries(built)) fs.writeFileSync(path.join(DIR, name), bytes);
    console.log(`wrote ${Object.keys(built).join(", ")}`);
  }
}

module.exports = { build, fixturePath, FILES };
