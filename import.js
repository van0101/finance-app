// Reads transactions from a spreadsheet the user made with any AI chat (or exported from a bank):
// .xlsx, .csv/.tsv, or a table pasted as text (CSV, TSV or a markdown table).
// Everything runs on the device. No libraries: an .xlsx is a zip of XML files, unpacked here with
// the browser's DecompressionStream and read with DOMParser.

export const TXN_TYPES = ["Expense", "Income", "Investment", "Transfer", "Refund", "Savings"];
export const COLUMNS = ["Date", "Name", "Merchant", "Description", "Amount", "Credit/Debit", "Type", "Label"];

// ---------- Prompt for the AI chat ----------

export function buildPrompt(labels, memory) {
  const hints = Object.entries(memory || {}).slice(0, 150).map(([m, l]) => `${m} -> ${l}`).join("\n");
  return [
    "I'm attaching bank or credit card statements and/or payment screenshots. Put every transaction in them into an Excel file (.xlsx) called transactions.xlsx: one sheet named \"Transactions\", header in row 1, exactly these columns in this order:",
    "",
    COLUMNS.join(" | "),
    "",
    "Rules:",
    "- One row per transaction. Don't invent, merge or split transactions. Skip opening/closing balance, running balance, totals and summary lines.",
    "- Date: YYYY-MM-DD. Indian statements print DD/MM/YYYY. If the year is missing, take it from the statement period.",
    "- Amount: a positive number only, no ₹ symbol or commas.",
    "- Credit/Debit: \"Debit\" for money out, \"Credit\" for money in.",
    "- Name: short, readable counterparty plus what it is, e.g. \"Swiggy (food delivery)\", \"Uber (cab)\", \"HDFC credit card bill\". No UPI reference numbers.",
    "- Merchant: a lowercase key that is the same every time for the same counterparty, e.g. swiggy, uber, hdfc credit card.",
    "- Description: the line as printed on the statement, up to about 120 characters.",
    "- Type: one of " + TXN_TYPES.join(", ") + ". SIPs and mutual funds are Investment. Credit card bill payments and moves between my own accounts are Transfer.",
    "- Label: the best fit from my labels below. If none fits, suggest a short new one in the same style.",
    "- If a merchant appears in my merchant -> label list below, use that label.",
    "- Never write full card or account numbers (last 4 digits at most).",
    "- If anything is unreadable or cut off, leave it out of the file and tell me in your reply.",
    "- If you can't create files, reply with the same table as CSV in a single code block instead.",
    "",
    "My labels:",
    labels.join(", ") || "(none yet)",
    "",
    "My merchant -> label choices:",
    hints || "(none yet)"
  ].join("\n");
}

// ---------- Entry points ----------

// Returns { sheet, rows: [{date,name,merchant,description,amount,direction,type,label,currency,line}], skipped, mapping, warnings }
export async function parseFile(file) {
  const name = (file.name || "").toLowerCase();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  if (isZip || /\.xlsx$/.test(name)) {
    if (!isZip) throw new Error("This .xlsx file looks damaged. Download it again.");
    const sheets = await readXlsx(new Uint8Array(await file.arrayBuffer()));
    return pickTable(sheets);
  }
  if (/\.xls$/.test(name)) throw new Error("Old Excel (.xls) files aren't supported. Save it as .xlsx or CSV.");
  if (/\.(pdf|png|jpe?g|webp|heic)$/.test(name)) {
    throw new Error("That's a statement or screenshot. Give it to your AI chat with the copied prompt, then import the Excel file it makes.");
  }
  const text = await file.text();
  return parseText(text);
}

export function parseText(text) {
  const grid = textToGrid(text);
  if (!grid.length) throw new Error("No table found in the text.");
  return pickTable([{ name: "Pasted table", grid }]);
}

// ---------- Text tables ----------

function textToGrid(raw) {
  let text = (raw || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  // Code block from a chat reply: keep what's inside the fences.
  const fence = text.match(/```[a-z]*\n([\s\S]*?)```/i);
  if (fence) text = fence[1];
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return [];

  const pipes = lines.filter((l) => l.trim().startsWith("|")).length;
  if (pipes >= Math.min(2, lines.length)) {
    return lines
      .filter((l) => l.trim().startsWith("|") && !/^\s*\|?\s*:?-{2,}/.test(l.replace(/\|/g, "")))
      .filter((l) => !/^\|?[\s:|-]+\|?$/.test(l.trim()))
      .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
  }
  const tabs = lines.filter((l) => l.includes("\t")).length;
  const delim = tabs >= lines.length / 2 ? "\t" : guessDelimiter(lines);
  return parseDelimited(lines.join("\n"), delim);
}

function guessDelimiter(lines) {
  const sample = lines.slice(0, 5).join("\n");
  const count = (ch) => (sample.match(new RegExp(`\\${ch}`, "g")) || []).length;
  return count(";") > count(",") ? ";" : ",";
}

// RFC 4180-style: quoted fields may contain the delimiter, quotes ("") and newlines.
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === "\"" && field === "") quoted = true;
    else if (ch === delim) { row.push(field.trim()); field = ""; }
    else if (ch === "\n") { row.push(field.trim()); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

// ---------- XLSX ----------

const MAX_UNZIPPED = 60 * 1024 * 1024;

async function readXlsx(bytes) {
  const files = await unzip(bytes, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/i.test(n));
  const xml = (path) => (files[path] ? new DOMParser().parseFromString(files[path], "application/xml") : null);
  const tags = (doc, tag) => (doc ? [...doc.getElementsByTagNameNS("*", tag)] : []);

  const shared = tags(xml("xl/sharedStrings.xml"), "si").map((si) =>
    tags(si, "t").filter((t) => t.parentNode.localName !== "rPh").map((t) => t.textContent).join(""));

  const rels = {};
  for (const r of tags(xml("xl/_rels/workbook.xml.rels"), "Relationship")) {
    const target = r.getAttribute("Target") || "";
    rels[r.getAttribute("Id")] = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheets = [];
  for (const s of tags(xml("xl/workbook.xml"), "sheet")) {
    const rid = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || s.getAttribute("r:id");
    const path = rels[rid];
    const doc = path && xml(path);
    if (!doc) continue;
    sheets.push({ name: s.getAttribute("name") || "Sheet", grid: sheetGrid(doc, shared, tags) });
  }
  if (!sheets.length) throw new Error("No sheets found in this Excel file.");
  return sheets;
}

function sheetGrid(doc, shared, tags) {
  const grid = [];
  for (const row of tags(doc, "row")) {
    const r = (+row.getAttribute("r") || grid.length + 1) - 1;
    const cells = [];
    let next = 0;
    for (const c of tags(row, "c")) {
      const ref = c.getAttribute("r");
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const t = c.getAttribute("t");
      const v = tags(c, "v")[0]?.textContent;
      let val;
      if (t === "s") val = shared[+v] ?? "";
      else if (t === "inlineStr") val = tags(c, "t").map((x) => x.textContent).join("");
      else if (t === "str" || t === "e") val = v ?? "";
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else val = v == null || v === "" ? "" : Number(v);
      cells[col] = val;
    }
    grid[r] = Array.from(cells, (x) => (x === undefined ? "" : x));
  }
  return Array.from(grid, (x) => x || []);
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Minimal zip reader: central directory -> each wanted entry -> stored or deflate-raw.
async function unzip(bytes, want) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This Excel file looks damaged. Download it again.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = {};
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!want(name)) continue;
    total += usize;
    if (total > MAX_UNZIPPED) throw new Error("This file is too large to read here.");
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    let raw;
    if (method === 0) raw = data;
    else if (method === 8) raw = await inflate(data);
    else throw new Error("This Excel file uses a compression method that isn't supported.");
    out[name] = dec.decode(raw);
  }
  return out;
}

async function inflate(data) {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser can't open Excel files. Update it, or import a CSV instead.");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- Finding the table and mapping columns ----------

const key = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Header names seen in AI output, the FY spreadsheet and common Indian bank exports.
const HEADERS = {
  date: ["date", "txndate", "transactiondate", "trandate", "postingdate", "valuedate", "valuedt", "txndt"],
  name: ["name", "transactionname", "payee", "merchantname", "particulars", "narration", "transactiondetails", "details", "remarks"],
  merchant: ["merchant", "merchantkey", "counterparty", "vendor"],
  description: ["description", "narration", "particulars", "details", "remarks", "note", "notes"],
  amount: ["amount", "amountinr", "amountrs", "txnamount", "transactionamount", "amt", "value"],
  debit: ["debit", "debitamount", "withdrawal", "withdrawalamt", "withdrawalamount", "withdrawals", "dr", "amountdebited", "debitamt"],
  credit: ["credit", "creditamount", "deposit", "depositamt", "depositamount", "deposits", "cr", "amountcredited", "creditamt"],
  direction: ["creditdebit", "debitcredit", "crdr", "drcr", "direction", "dc", "cd"],
  type: ["type", "category type"],
  label: ["label", "category", "tag", "labels"]
};

function mapHeader(row) {
  const keys = row.map(key);
  const used = new Set();
  const map = {};
  const order = ["date", "direction", "debit", "credit", "amount", "merchant", "label", "type", "name", "description"];
  for (const field of order) {
    for (const want of HEADERS[field]) {
      const i = keys.findIndex((k, idx) => k && !used.has(idx) && k === key(want));
      if (i >= 0) { map[field] = i; used.add(i); break; }
    }
  }
  return map;
}

function scoreMap(m) {
  const hasAmount = m.amount != null || m.debit != null || m.credit != null;
  if (m.date == null || !hasAmount) return 0;
  return Object.keys(m).length;
}

function pickTable(sheets) {
  let best = null;
  for (const s of sheets) {
    for (let r = 0; r < Math.min(20, s.grid.length); r++) {
      const map = mapHeader(s.grid[r] || []);
      const score = scoreMap(map);
      if (!score) continue;
      const dataRows = s.grid.length - r - 1;
      const better = !best || score > best.score || (score === best.score && dataRows > best.dataRows);
      if (better) best = { sheet: s, headerRow: r, map, score, dataRows };
    }
  }
  if (!best) {
    throw new Error(`Couldn't find a header row with at least Date and Amount columns. Expected columns: ${COLUMNS.join(", ")}.`);
  }
  const { sheet, headerRow, map } = best;
  const header = sheet.grid[headerRow];
  const rows = [];
  let skipped = 0;
  const warnings = [];
  for (let r = headerRow + 1; r < sheet.grid.length; r++) {
    const cells = sheet.grid[r] || [];
    const get = (f) => (map[f] == null ? "" : cells[map[f]] ?? "");
    const rawDate = get("date");
    const nameish = String(get("name") || get("description") || get("merchant")).trim();
    const amountCells = [get("amount"), get("debit"), get("credit")];
    if (rawDate === "" && amountCells.every((a) => a === "" || a === 0) && !nameish) continue; // blank row
    if (/^(total|opening|closing|balance)/i.test(nameish) && rawDate === "") { skipped++; continue; }

    const t = toTxn(get, map);
    t.line = r + 1;
    if (!t.date && !t.amount) { skipped++; continue; }
    rows.push(t);
  }
  if (!rows.length) warnings.push("The header was found but no transaction rows under it.");
  const mapping = Object.entries(map)
    .filter(([f]) => f !== "description" || map.name !== map.description)
    .map(([f, i]) => `${f} ← ${String(header[i]).trim()}`);
  return { sheet: sheet.name, rows, skipped, mapping, warnings };
}

function toTxn(get, map) {
  const date = parseDate(get("date"));
  let amount = 0;
  let direction = "";
  if (map.debit != null || map.credit != null) {
    const d = parseAmount(get("debit"));
    const c = parseAmount(get("credit"));
    if (Math.abs(c.value) > 0 && !(Math.abs(d.value) > 0)) { amount = Math.abs(c.value); direction = "credit"; }
    else if (Math.abs(d.value) > 0) { amount = Math.abs(d.value); direction = "debit"; }
  }
  if (!amount && map.amount != null) {
    const a = parseAmount(get("amount"));
    amount = Math.abs(a.value);
    direction = a.hint || (a.value < 0 ? "debit" : "");
  }
  const dirText = String(get("direction")).trim();
  if (dirText) direction = parseDirection(dirText) || direction;
  let type = String(get("type")).trim();
  if (!direction && parseDirection(type)) direction = parseDirection(type); // a "Type" column holding Dr/Cr
  direction = direction || "debit";
  const typeOk = TXN_TYPES.find((x) => x.toLowerCase() === type.toLowerCase());
  type = typeOk || (direction === "credit" ? "Income" : "Expense");

  const name = String(get("name") || get("description") || get("merchant")).trim();
  const description = String(map.description != null && map.description !== map.name ? get("description") : "").trim();
  const merchant = String(get("merchant")).trim().toLowerCase() || merchantFrom(name);
  return {
    date,
    name: name.slice(0, 120),
    merchant: merchant.slice(0, 60),
    description: description.slice(0, 200),
    amount: Math.round(amount * 100) / 100,
    direction,
    type,
    label: String(get("label")).trim().slice(0, 40),
    currency: "INR"
  };
}

function parseDirection(s) {
  const k = key(s);
  if (/^(cr|credit|credited|c|deposit|in|received|income)$/.test(k)) return "credit";
  if (/^(dr|debit|debited|d|withdrawal|out|paid|sent)$/.test(k)) return "debit";
  return "";
}

// Best-effort grouping key when the file has no Merchant column, e.g. from a raw bank narration
// like "UPI-ZOMATO-ZOMATO@HDFC-123" or "NEFT CR-ACME CORP SALARY".
const NOISE = new Set(["upi", "neft", "imps", "rtgs", "pos", "ach", "nach", "ecs", "cr", "dr", "d", "c", "to", "from", "by", "ref", "txn", "payment", "transfer", "mandate", "bil", "billpay", "inb", "mb", "ib"]);
function merchantFrom(name) {
  const words = name.toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/@[^\s-]*/g, " ")         // UPI handles (zomato@hdfc)
    .replace(/[^a-z0-9& ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w) && !NOISE.has(w)); // drop reference numbers and masked card numbers
  return [...new Set(words)].slice(0, 3).join(" ");
}

export function parseAmount(v) {
  if (typeof v === "number") return { value: v, hint: "" };
  let s = String(v ?? "").trim();
  if (!s) return { value: 0, hint: "" };
  let hint = "";
  if (/\bcr\.?$/i.test(s)) { hint = "credit"; s = s.replace(/\bcr\.?$/i, ""); }
  else if (/\bdr\.?$/i.test(s)) { hint = "debit"; s = s.replace(/\bdr\.?$/i, ""); }
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
  const num = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num)) return { value: 0, hint };
  return { value: neg ? -num : num, hint };
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const yr = (y) => (y < 100 ? 2000 + y : y);

function valid(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100)) return "";
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : "";
}

// Indian statements are day-first, so 03/11/2026 is 3 Nov.
export function parseDate(v) {
  if (typeof v === "number" || /^\d{5}(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (n > 20000 && n < 80000) { // Excel serial date
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return valid(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    return "";
  }
  const s = String(v ?? "").trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return valid(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/))) return valid(yr(+m[3]), +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[\s/-]*([a-z]{3,9})[\s,/-]*(\d{2,4})\b/i)) && MON[m[2].slice(0, 3).toLowerCase()]) {
    return valid(yr(+m[3]), MON[m[2].slice(0, 3).toLowerCase()], +m[1]);
  }
  if ((m = s.match(/^([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/i)) && MON[m[1].slice(0, 3).toLowerCase()]) {
    return valid(+m[3], MON[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  return "";
}
