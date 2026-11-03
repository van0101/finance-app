// Finance: web app. Keep APP_VERSION in sync with sw.js, index.html (#ver) and CHANGELOG.md (CI checks it).
const APP_VERSION = "0.1.0";

import { db } from "./db.js";
import { PROVIDERS, TXN_TYPES, listModels, extractTransactions } from "./llm.js";

// ---------- Defaults ----------

const DEFAULT_LABELS = [
  "Groceries & dairy", "Swiggy groceries", "Dining & cafes", "Shopping", "Fuel", "Uber cab",
  "Fuel & transport", "Health & fitness", "Wellness & grooming", "Subscriptions & gaming",
  "Bills & home services", "CC Bills", "Insurance", "Personal transfers", "Gifts",
  "Local vendors & misc small", "Miscellaneous", "SIP", "Investment (one-time)",
  "Savings transfer (FD/Liquid)", "Salary", "Transfer In", "Refund", "Unknown / unidentified"
];

// ---------- State ----------

const state = {
  ai: null,          // { provider, key, model }
  labels: [],        // string[]
  memory: {},        // merchant -> label (set only by the user's own choices)
  txns: [],          // ledger
  pending: [],       // extracted rows waiting for review
  docs: [],          // per-file summaries for the review screen
  queue: [],         // files waiting to be read: { id, file, status, msg }
  ledgerMode: "list",
  reviewMode: "list",
  filter: { q: "", month: "", label: "" },
  wizard: { provider: null, models: null }
};

// ---------- Tiny DOM helper (no innerHTML with user data) ----------

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// ---------- Formatting ----------

const fmtCache = {};
function money(n, currency = "INR") {
  const key = currency || "INR";
  if (!fmtCache[key]) {
    try { fmtCache[key] = new Intl.NumberFormat("en-IN", { style: "currency", currency: key, maximumFractionDigits: 2 }); }
    catch { fmtCache[key] = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }); }
  }
  return fmtCache[key].format(n);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthKey = (iso) => (iso || "").slice(0, 7);
function monthLabel(key) {
  const [y, m] = key.split("-");
  return m ? `${MONTHS[+m - 1]}-${y.slice(2)}` : key;
}
function shortDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return iso || "?";
  const [y, m, d] = iso.split("-");
  return `${d} ${MONTHS[+m - 1]} ${y.slice(2)}`;
}
function hue(label) {
  let x = 0;
  for (const c of label || "") x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return String(x % 360);
}
const norm = (s) => (s || "").trim().toLowerCase();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

// ---------- Persistence ----------

async function load() {
  const [ai, labels, memory, pending, docs, txns] = await Promise.all([
    db.get("ai"), db.get("labels"), db.get("memory"), db.get("pending"), db.get("docs"), db.allTxns()
  ]);
  state.ai = ai || null;
  state.labels = Array.isArray(labels) ? labels : DEFAULT_LABELS.slice();
  if (!labels) await db.set("labels", state.labels);
  state.memory = memory || {};
  state.pending = pending || [];
  state.docs = docs || [];
  state.txns = txns || [];
}
const saveLabels = () => db.set("labels", state.labels);
const saveMemory = () => db.set("memory", state.memory);
const savePending = () => Promise.all([db.set("pending", state.pending), db.set("docs", state.docs)]);

function ensureLabel(label) {
  if (!label) return;
  if (!state.labels.some((l) => norm(l) === norm(label))) {
    state.labels.push(label);
    saveLabels();
  }
}
function canonicalLabel(label) {
  return state.labels.find((l) => norm(l) === norm(label)) || label;
}

function labelCounts() {
  const c = {};
  for (const t of state.txns) if (t.label) c[t.label] = (c[t.label] || 0) + 1;
  return c;
}

// ---------- Toast and confirm ----------

let toastTimer;
function toast(text, action) {
  $("toastText").textContent = text;
  const btn = $("toastAction");
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { $("toast").hidden = true; action.fn(); };
  }
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, action ? 7000 : 2600);
}

function confirmBox(text, okLabel = "OK") {
  const dlg = $("confirm");
  $("confirmText").textContent = text;
  $("confirmYes").textContent = okLabel;
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    $("confirmYes").onclick = () => done(true);
    $("confirmNo").onclick = () => done(false);
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

// ---------- Label picker ----------

const picker = { onPick: null, current: "", items: [], active: 0 };

function openPicker(anchor, current, onPick) {
  picker.onPick = onPick;
  picker.current = current || "";
  const p = $("picker");
  p.hidden = false;
  $("scrim").hidden = false;
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6 + 360 > innerHeight ? Math.max(8, r.top - 366) : r.bottom + 6;
  p.style.top = `${top}px`;
  p.style.left = `${Math.min(Math.max(8, r.left), innerWidth - 288)}px`;
  $("pickerInput").value = "";
  renderPicker();
  setTimeout(() => $("pickerInput").focus(), 0);
}
function closePicker() {
  $("picker").hidden = true;
  $("scrim").hidden = true;
  picker.onPick = null;
}
function renderPicker() {
  const q = $("pickerInput").value.trim();
  const counts = labelCounts();
  const list = state.labels
    .filter((l) => !q || norm(l).includes(norm(q)))
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
  picker.items = list.map((l) => ({ label: l, add: false }));
  if (q && !state.labels.some((l) => norm(l) === norm(q))) picker.items.push({ label: q, add: true });
  picker.active = 0;
  const ul = $("pickerList");
  ul.replaceChildren(...picker.items.map((it, i) => h("li", {
    role: "option",
    class: [it.add ? "add" : "", norm(it.label) === norm(picker.current) ? "cur" : "", i === picker.active ? "active" : ""].join(" "),
    onclick: () => pick(it)
  },
  it.add ? `+ Add “${it.label}”` : [
    h("span", { class: "sw", style: { "--h": hue(it.label) } }),
    h("span", { class: "grow" }, it.label),
    counts[it.label] ? h("span", { class: "cnt" }, counts[it.label]) : null
  ])));
}
function pick(it) {
  const label = it.label.trim().slice(0, 40);
  if (!label) return;
  if (it.add) { ensureLabel(label); renderSettings(); renderFilters(); }
  const fn = picker.onPick;
  closePicker();
  if (fn) fn(canonicalLabel(label));
}
function setupPicker() {
  $("pickerInput").addEventListener("input", renderPicker);
  $("pickerInput").addEventListener("keydown", (e) => {
    const n = picker.items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      picker.active = (picker.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      [...$("pickerList").children].forEach((li, i) => li.classList.toggle("active", i === picker.active));
      $("pickerList").children[picker.active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = $("pickerInput").value.trim();
      const exact = picker.items.find((it) => norm(it.label) === norm(q));
      const it = exact || picker.items[picker.active];
      if (it) pick(it);
    } else if (e.key === "Escape") closePicker();
  });
  $("scrim").addEventListener("click", closePicker);
}

function chip(t, onChange) {
  const label = t.label || "";
  return h("button", {
    type: "button",
    class: `chip ${label ? "" : "empty"} ${t.labelSource === "ai" ? "ai" : t.labelSource === "learned" ? "learned" : ""}`,
    style: { "--h": hue(label) },
    title: t.labelSource === "ai" ? "AI suggestion. Tap to change." : t.labelSource === "learned" ? "From your earlier choice for this merchant. Tap to change." : "Tap to change",
    onclick: (e) => openPicker(e.currentTarget, label, onChange)
  }, h("span", null, label || "Add label"));
}

// ---------- Row rendering (shared by ledger and review) ----------

function rowEl(t, opts) {
  const credit = t.direction === "credit";
  const flags = [];
  if (t.dup) flags.push(h("span", { class: "flag", title: "Same date, amount and merchant already in your ledger" }, "Possible duplicate"));
  if (t.invalid) flags.push(h("span", { class: "flag", title: t.invalid }, "Check"));
  if (t.newLabel) flags.push(h("span", { class: "flag", title: "The AI suggested a label you don't have yet. It's added to your list when you save." }, "New label"));
  return h("div", { class: `row ${opts.selectable && !t.include ? "excluded" : ""}`, "data-id": t.id },
    opts.selectable ? h("span", { class: "sel" }, h("input", {
      type: "checkbox", "aria-label": "Include", checked: !!t.include,
      onchange: (e) => opts.onToggle(t, e.target.checked)
    })) : null,
    h("span", { class: "date" }, shortDate(t.date)),
    h("span", { class: "name" },
      h("span", { class: "t", title: t.name }, t.name || "(no name)", flags),
      h("span", { class: "d", title: t.description || "" }, t.description || t.merchant || "")),
    h("span", { class: `amt ${credit ? "credit" : ""}` }, (credit ? "+" : "−") + money(t.amount, t.currency)),
    h("span", { class: "type" }, t.type || ""),
    h("span", { class: "lab" }, chip(t, (label) => opts.onLabel(t, label))),
    opts.onDelete ? h("span", { class: "act" }, h("button", {
      type: "button", class: "icon-btn", title: "Delete", "aria-label": "Delete transaction",
      onclick: () => opts.onDelete(t)
    }, "×")) : h("span", { class: "act" })
  );
}

function headEl(opts) {
  return h("div", { class: "row head", "aria-hidden": "true" },
    opts.selectable ? h("span", { class: "sel" }) : null,
    h("span", { class: "date" }, "Date"), h("span", { class: "name" }, "Transaction"),
    h("span", { class: "amt" }, "Amount"), h("span", { class: "type" }, "Type"),
    h("span", { class: "lab" }, "Label"), h("span", { class: "act" }));
}

function groupKey(t) {
  return norm(t.merchant) || norm(t.name).replace(/\s*\(.*\)$/, "") || "unknown";
}

function renderRows(container, rows, opts) {
  container.classList.toggle("selectable", !!opts.selectable);
  if (!rows.length) { container.replaceChildren(); return; }
  if (opts.mode !== "group") {
    container.replaceChildren(headEl(opts), ...rows.map((t) => rowEl(t, opts)));
    return;
  }
  const groups = new Map();
  for (const t of rows) {
    const k = groupKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const list = [...groups.entries()].map(([k, items]) => {
    const net = items.reduce((s, t) => s + (t.direction === "credit" ? t.amount : -t.amount), 0);
    return { k, items, net };
  }).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  container.replaceChildren(...list.map(({ k, items, net }) => {
    const labels = [...new Set(items.map((t) => t.label).filter(Boolean))];
    const title = mostCommon(items.map((t) => t.name)) || k;
    const det = h("details", { class: "group", open: opts.openGroups || opts.expanded?.has(k) },
      h("summary", null,
        h("span", { class: "g-name", title }, title),
        h("span", { class: "g-meta" }, `${items.length} transaction${items.length > 1 ? "s" : ""} · ${labels.length ? labels.join(", ") : "no label"}`),
        h("span", { class: `g-amt ${net > 0 ? "credit" : ""}` }, (net > 0 ? "+" : "−") + money(Math.abs(net), items[0].currency)),
        h("span", { class: "g-act" }, h("button", {
          type: "button", class: "btn small ghost",
          onclick: (e) => {
            e.preventDefault(); e.stopPropagation();
            openPicker(e.currentTarget, labels.length === 1 ? labels[0] : "", (label) => opts.onGroupLabel(items, label));
          }
        }, "Label all"))
      ),
      ...items.map((t) => rowEl(t, opts)));
    det.addEventListener("toggle", () => {
      if (!opts.expanded) return;
      if (det.open) opts.expanded.add(k); else opts.expanded.delete(k);
    });
    return det;
  }));
}

function mostCommon(arr) {
  const c = {};
  let best = null;
  for (const x of arr) { c[x] = (c[x] || 0) + 1; if (!best || c[x] > c[best]) best = x; }
  return best;
}

// ---------- Ledger ----------

const ledgerExpanded = new Set();

function filteredTxns() {
  const { q, month, label } = state.filter;
  const nq = norm(q);
  return state.txns
    .filter((t) => (!month || monthKey(t.date) === month)
      && (!label || (label === "__none" ? !t.label : t.label === label))
      && (!nq || [t.name, t.merchant, t.label, t.description].some((s) => norm(s).includes(nq))))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
}

function renderFilters() {
  const months = [...new Set(state.txns.map((t) => monthKey(t.date)).filter(Boolean))].sort().reverse();
  const mSel = $("fMonth");
  mSel.replaceChildren(h("option", { value: "" }, "All months"), ...months.map((m) => h("option", { value: m }, monthLabel(m))));
  if (!months.includes(state.filter.month)) state.filter.month = "";
  mSel.value = state.filter.month;

  const used = labelCounts();
  const lSel = $("fLabel");
  const labels = state.labels.filter((l) => used[l]);
  lSel.replaceChildren(h("option", { value: "" }, "All labels"), h("option", { value: "__none" }, "No label"),
    ...labels.map((l) => h("option", { value: l }, `${l} (${used[l]})`)));
  if (state.filter.label && state.filter.label !== "__none" && !used[state.filter.label]) state.filter.label = "";
  lSel.value = state.filter.label;
}

function renderLedger() {
  const rows = filteredTxns();
  $("ledgerEmpty").hidden = state.txns.length > 0;
  $("stats").hidden = $("bars").hidden = state.txns.length === 0;

  let out = 0, inn = 0;
  const byLabel = {};
  for (const t of rows) {
    if (t.direction === "credit") inn += t.amount;
    else {
      out += t.amount;
      const l = t.label || "No label";
      byLabel[l] = (byLabel[l] || 0) + t.amount;
    }
  }
  $("stats").replaceChildren(
    h("div", { class: "stat" }, h("div", { class: "k" }, "Money out"), h("div", { class: "v" }, money(out))),
    h("div", { class: "stat" }, h("div", { class: "k" }, "Money in"), h("div", { class: "v" }, money(inn))),
    h("div", { class: "stat" }, h("div", { class: "k" }, "Transactions"), h("div", { class: "v" }, rows.length)));

  const top = Object.entries(byLabel).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = top[0]?.[1] || 1;
  $("bars").replaceChildren(...top.map(([l, v]) => h("button", {
    type: "button", class: `bar ${state.filter.label === l ? "on" : ""}`, title: `Show only ${l}`,
    onclick: () => {
      state.filter.label = state.filter.label === l || l === "No label" && state.filter.label === "__none" ? "" : (l === "No label" ? "__none" : l);
      renderFilters(); renderLedger();
    }
  },
  h("span", { class: "name" }, l),
  h("span", { class: "track" }, h("span", { class: "fill", style: { "--h": hue(l), "--w": `${(v / max) * 100}%` } })),
  h("span", { class: "amt" }, money(v)))));

  renderRows($("ledgerRows"), rows, {
    mode: state.ledgerMode,
    expanded: ledgerExpanded,
    onLabel: setLedgerLabel,
    onGroupLabel: (items, label) => applyLabelTo(items, label, true),
    onDelete: deleteTxn
  });
}

async function setLedgerLabel(t, label) {
  t.label = label;
  t.labelSource = "user";
  t.updatedAt = Date.now();
  await db.putTxn(t);
  rememberMerchant(t, label);
  renderFilters(); renderLedger(); renderSettings();
  // Offer, never apply on our own: other records from the same merchant with a different label.
  const others = state.txns.filter((x) => x !== t && groupKey(x) === groupKey(t) && x.label !== label);
  if (others.length) {
    toast(`Saved. ${others.length} other ${t.name} transaction${others.length > 1 ? "s have" : " has"} a different label.`,
      { label: `Label ${others.length > 1 ? "all" : "it"} “${label}”`, fn: () => applyLabelTo(others, label, true) });
  } else toast("Label saved");
}

async function applyLabelTo(items, label, persist) {
  const now = Date.now();
  for (const t of items) { t.label = label; t.labelSource = "user"; t.updatedAt = now; }
  if (items[0]) rememberMerchant(items[0], label);
  if (persist) await db.putTxns(items);
  else await savePending();
  if (persist) { renderFilters(); renderLedger(); } else renderReview();
  renderSettings();
  toast(`${items.length} transaction${items.length > 1 ? "s" : ""} labelled “${label}”`);
}

function rememberMerchant(t, label) {
  const k = groupKey(t);
  if (!k || k === "unknown") return;
  state.memory[k] = label;
  saveMemory();
}

async function deleteTxn(t) {
  await db.deleteTxn(t.id);
  state.txns = state.txns.filter((x) => x !== t);
  renderFilters(); renderLedger(); renderSettings();
  toast(`Deleted ${t.name}`, { label: "Undo", fn: async () => {
    await db.putTxn(t); state.txns.push(t); renderFilters(); renderLedger(); renderSettings();
  } });
}

// ---------- Import ----------

const ACCEPT_IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_FILE_MB = 30;

function addFiles(files) {
  for (const file of files) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isImg = file.type.startsWith("image/");
    const item = { id: uid(), file, status: "queued", msg: "" };
    if (!isPdf && !isImg) { item.status = "error"; item.msg = "Not a PDF or image. Skipped."; }
    else if (file.size > MAX_FILE_MB * 1024 * 1024) { item.status = "error"; item.msg = `Larger than ${MAX_FILE_MB} MB. Split it first.`; }
    state.queue.push(item);
  }
  renderQueue();
}

function renderQueue() {
  const ul = $("queue");
  ul.replaceChildren(...state.queue.map((q) => {
    const isPdf = /pdf/i.test(q.file.type) || /\.pdf$/i.test(q.file.name);
    const st = q.status === "working" ? [h("span", { class: "spin" }), q.msg || "Reading…"]
      : q.status === "done" ? q.msg : q.status === "error" ? q.msg : `${(q.file.size / 1024 / 1024).toFixed(1)} MB · waiting`;
    return h("li", null,
      h("span", { class: "kind" }, isPdf ? "PDF" : "IMG"),
      h("span", { class: "grow" },
        h("div", { class: "fname", title: q.file.name }, q.file.name || "pasted image"),
        h("div", { class: `fstat ${q.status === "error" ? "err" : q.status === "done" ? "ok" : ""}` }, st)),
      q.status === "working" ? h("span") : h("button", {
        type: "button", class: "icon-btn", "aria-label": "Remove", title: "Remove",
        onclick: () => { state.queue = state.queue.filter((x) => x !== q); renderQueue(); }
      }, "×"));
  }));
  const waiting = state.queue.some((q) => q.status === "queued");
  const busy = state.queue.some((q) => q.status === "working");
  $("queueActions").hidden = state.queue.length === 0;
  $("runBtn").disabled = !waiting || busy || !state.ai;
  $("runBtn").textContent = busy ? "Reading…" : "Read transactions";
  $("clearQueue").disabled = busy;
}

async function fileToPayload(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (isEncryptedPdf(buf)) {
      throw new Error("This PDF is password-protected. Open it, use Print > Save as PDF to save an unlocked copy, and add that instead. Or add screenshots of the pages.");
    }
    return { mime: "application/pdf", base64: bytesToBase64(buf), name: file.name };
  }
  // Images: send as-is when small and in a supported format, otherwise re-encode as JPEG.
  if (ACCEPT_IMG.includes(file.type) && file.size <= 3.5 * 1024 * 1024) {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp || Math.max(bmp.width, bmp.height) <= 7000) {
      return { mime: file.type, base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())), name: file.name };
    }
  }
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error("This image format can't be read here. Save it as JPG or PNG and try again.");
  const scale = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  return { mime: "image/jpeg", base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), name: file.name };
}

function isEncryptedPdf(bytes) {
  // The /Encrypt entry lives in the trailer, near the end. Check the tail and head to be safe.
  const dec = new TextDecoder("latin1");
  const tail = dec.decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
  const head = dec.decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  return /\/Encrypt\s/.test(tail) || /\/Encrypt\s/.test(head);
}

function bytesToBase64(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

async function runQueue() {
  if (!state.ai) { location.hash = "#setup"; return; }
  const todo = state.queue.filter((q) => q.status === "queued");
  for (const q of todo) {
    q.status = "working"; q.msg = "Preparing file…"; renderQueue();
    try {
      const payload = await fileToPayload(q.file);
      q.msg = `Asking ${PROVIDERS[state.ai.provider].name}… (can take a minute for long statements)`; renderQueue();
      const res = await extractTransactions({
        provider: state.ai.provider, key: state.ai.key, model: state.ai.model,
        labels: state.labels, memory: state.memory, file: payload
      });
      const rows = res.transactions.map((r) => toPendingRow(r, q.file.name, res.document));
      markDuplicates(rows);
      state.pending.push(...rows);
      state.docs.push({
        file: q.file.name || "pasted image",
        kind: res.document.kind || "",
        period: res.document.period || "",
        isFinancial: res.document.is_financial !== false,
        count: rows.length,
        out: rows.filter((r) => r.direction !== "credit").reduce((s, r) => s + (r.amount || 0), 0),
        in: rows.filter((r) => r.direction === "credit").reduce((s, r) => s + (r.amount || 0), 0),
        currency: res.document.currency || "INR",
        warnings: res.warnings
      });
      await savePending();
      q.status = res.document.is_financial === false ? "error" : "done";
      q.msg = res.document.is_financial === false ? "Doesn't look like a financial document. Nothing taken from it."
        : `${rows.length} transaction${rows.length === 1 ? "" : "s"} found${res.warnings.length ? ` · ${res.warnings.length} note${res.warnings.length > 1 ? "s" : ""}` : ""}`;
    } catch (e) {
      q.status = "error";
      q.msg = e.message || String(e);
    }
    renderQueue();
    renderReview();
  }
}

function toPendingRow(r, fileName, doc) {
  const merchant = norm(r.merchant) || norm(r.name);
  const learned = state.memory[merchant];
  const suggested = (r.suggested_label || "").trim().slice(0, 40);
  const label = learned || (suggested ? canonicalLabel(suggested) : "");
  const amount = Math.abs(Number(r.amount));
  const row = {
    id: uid(),
    date: String(r.date || "").slice(0, 10),
    name: String(r.name || "").slice(0, 120),
    merchant,
    description: String(r.description || "").slice(0, 200),
    amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0,
    direction: r.direction === "credit" ? "credit" : "debit",
    type: TXN_TYPES.includes(r.type) ? r.type : "Expense",
    currency: (doc.currency || "INR").toUpperCase().slice(0, 3),
    label,
    labelSource: learned ? "learned" : "ai",
    aiLabel: suggested,
    source: fileName || "pasted image",
    include: true
  };
  row.newLabel = !!label && !state.labels.some((l) => norm(l) === norm(label));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || Number.isNaN(Date.parse(row.date))) row.invalid = "Date couldn't be read";
  else if (!(row.amount > 0)) row.invalid = "Amount couldn't be read";
  if (row.invalid) row.include = false;
  return row;
}

const fp = (t) => `${t.date}|${(+t.amount).toFixed(2)}|${t.direction}|${groupKey(t)}`;

// Flags rows that match ledger records. Repeats inside one statement (four identical SIP debits on the
// same day) are real, so only as many rows are flagged as the ledger already has.
function markDuplicates(rows) {
  const have = {};
  for (const t of state.txns) have[fp(t)] = (have[fp(t)] || 0) + 1;
  for (const t of state.pending) if (!rows.includes(t)) have[fp(t)] = (have[fp(t)] || 0) + 1;
  for (const r of rows) {
    const k = fp(r);
    if (have[k] > 0) { r.dup = true; r.include = false; have[k]--; }
  }
}

function renderReview() {
  const has = state.pending.length > 0 || state.docs.length > 0;
  $("review").hidden = !has;
  const n = state.pending.length;
  $("pendingBadge").hidden = n === 0;
  $("pendingBadge").textContent = n;
  if (!has) return;

  $("docCards").replaceChildren(...state.docs.map((d) => h("div", { class: `doc ${d.isFinancial ? "" : "bad"}` },
    h("div", { class: "t", title: d.file }, d.file),
    h("div", { class: "m" }, [kindLabel(d.kind), d.period].filter(Boolean).join(" · ") || "Document"),
    d.isFinancial ? h("div", null, `${d.count} transactions · out ${money(d.out, d.currency)} · in ${money(d.in, d.currency)}`)
      : h("div", null, "Not a financial document. Nothing was taken from it."),
    d.warnings?.length ? h("ul", null, ...d.warnings.map((w) => h("li", null, w))) : null)));

  const rows = state.pending.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  renderRows($("reviewRows"), rows, {
    mode: state.reviewMode,
    selectable: true,
    openGroups: true,
    onToggle: (t, on) => { t.include = on; savePending(); renderReview(); },
    onLabel: (t, label) => {
      t.label = label; t.labelSource = "user"; t.newLabel = false;
      rememberMerchant(t, label);
      savePending(); renderReview(); renderSettings();
      const others = state.pending.filter((x) => x !== t && groupKey(x) === groupKey(t) && x.label !== label);
      if (others.length) toast(`${others.length} more from ${t.name} in this import.`, { label: `Label ${others.length > 1 ? "all" : "it"} “${label}”`, fn: () => applyLabelTo(others, label, false) });
    },
    onGroupLabel: (items, label) => { items.forEach((t) => { t.newLabel = false; }); applyLabelTo(items, label, false); }
  });
  const sel = state.pending.filter((t) => t.include).length;
  $("commitBtn").textContent = `Add ${sel} to ledger`;
  $("commitBtn").disabled = sel === 0;
}

function kindLabel(k) {
  return {
    bank_statement: "Bank statement", credit_card_statement: "Credit card statement",
    upi_or_wallet_screenshot: "UPI / wallet screenshot", receipt: "Receipt", invoice: "Invoice",
    other_financial: "Financial document", not_financial: "Not financial"
  }[k] || "";
}

async function commitPending() {
  const chosen = state.pending.filter((t) => t.include);
  if (!chosen.length) return;
  const now = Date.now();
  const records = chosen.map((t, i) => {
    if (t.label) ensureLabel(t.label);
    return {
      id: t.id, date: t.date, name: t.name, merchant: t.merchant, description: t.description,
      amount: t.amount, direction: t.direction, type: t.type, currency: t.currency,
      label: canonicalLabel(t.label), labelSource: t.labelSource, aiLabel: t.aiLabel,
      source: t.source, createdAt: now + i, updatedAt: now
    };
  });
  await db.putTxns(records);
  state.txns.push(...records);
  const skipped = state.pending.length - chosen.length;
  state.pending = []; state.docs = [];
  state.queue = state.queue.filter((q) => q.status === "queued" || q.status === "working");
  await savePending();
  renderQueue(); renderReview(); renderFilters(); renderLedger(); renderSettings();
  location.hash = "#ledger";
  toast(`Added ${records.length} transaction${records.length > 1 ? "s" : ""}${skipped ? `, skipped ${skipped}` : ""}`);
}

async function discardPending() {
  if (!(await confirmBox(`Discard ${state.pending.length} extracted transactions? You'd need to read the files again.`, "Discard"))) return;
  state.pending = []; state.docs = [];
  state.queue = state.queue.filter((q) => q.status === "queued" || q.status === "working");
  await savePending();
  renderQueue(); renderReview();
}

// ---------- Settings ----------

function renderSettings() {
  // AI card
  const card = $("aiCard");
  if (state.ai) {
    const p = PROVIDERS[state.ai.provider];
    const modelSel = h("select", { "aria-label": "Model" }, h("option", { value: state.ai.model }, state.ai.model));
    modelSel.addEventListener("focus", async () => {
      if (modelSel.dataset.loaded) return;
      modelSel.dataset.loaded = "1";
      try {
        const { list } = await listModels(state.ai.provider, state.ai.key);
        modelSel.replaceChildren(...list.map((m) => h("option", { value: m.id }, m.label === m.id ? m.id : `${m.label} (${m.id})`)));
        modelSel.value = state.ai.model;
      } catch (e) { toast(e.message); }
    }, { once: true });
    modelSel.addEventListener("change", async () => {
      state.ai.model = modelSel.value; await db.set("ai", state.ai); renderAiChip(); toast("Model saved");
    });
    card.replaceChildren(
      h("p", null, h("b", null, `${p.name} (${p.vendor})`), ` · key ending ${state.ai.key.slice(-4)}`),
      h("div", { class: "field" }, h("label", null, "Model"), modelSel),
      h("div", { class: "btn-row" },
        h("a", { class: "btn small", href: "#setup" }, "Switch AI"),
        h("a", { class: "btn small ghost", href: p.billingUrl, target: "_blank", rel: "noopener" }, "Usage and billing"),
        h("button", { type: "button", class: "btn small danger", onclick: disconnectAi }, "Disconnect")));
  } else {
    card.replaceChildren(h("p", null, "No AI connected."), h("a", { class: "btn primary small", href: "#setup" }, "Connect AI"));
  }

  // Labels
  const counts = labelCounts();
  $("labelList").replaceChildren(...state.labels.slice().sort((a, b) => a.localeCompare(b)).map((l) => {
    const li = h("li", null,
      h("span", { class: "chip", style: { "--h": hue(l) } }, h("span", null, l)),
      h("span", { class: "grow" }),
      h("span", { class: "cnt" }, counts[l] ? `${counts[l]} used` : "unused"),
      h("button", { type: "button", class: "btn small ghost", onclick: () => startRename(li, l) }, "Rename"),
      h("button", {
        type: "button", class: "icon-btn", title: counts[l] ? "In use: rename it instead" : "Delete label",
        "aria-label": `Delete ${l}`, disabled: !!counts[l], onclick: () => deleteLabel(l)
      }, "×"));
    return li;
  }));

  // Memory
  const entries = Object.entries(state.memory).sort((a, b) => a[0].localeCompare(b[0]));
  $("memoryList").replaceChildren(...entries.map(([m, l]) => h("li", null,
    h("span", { class: "m" }, m), h("span", { class: "arrow" }, "→"),
    h("span", { class: "grow" }, h("span", { class: "chip", style: { "--h": hue(l) } }, h("span", null, l))),
    h("button", {
      type: "button", class: "icon-btn", title: "Forget", "aria-label": `Forget ${m}`,
      onclick: () => { delete state.memory[m]; saveMemory(); renderSettings(); }
    }, "×"))));
}

function startRename(li, oldName) {
  const input = h("input", { type: "text", value: oldName, maxlength: "40", "aria-label": "New name" });
  const save = h("button", { type: "button", class: "btn small" }, "Save");
  const cancel = h("button", { type: "button", class: "btn small ghost", onclick: renderSettings }, "Cancel");
  const go = async () => {
    const name = input.value.trim();
    if (!name || name === oldName) return renderSettings();
    if (state.labels.some((l) => l !== oldName && norm(l) === norm(name))) { toast("That label already exists"); return; }
    const affected = state.txns.filter((t) => t.label === oldName);
    state.labels = state.labels.map((l) => (l === oldName ? name : l));
    for (const t of affected) { t.label = name; t.updatedAt = Date.now(); }
    for (const [m, l] of Object.entries(state.memory)) if (l === oldName) state.memory[m] = name;
    for (const t of state.pending) if (t.label === oldName) t.label = name;
    await Promise.all([saveLabels(), saveMemory(), savePending(), affected.length ? db.putTxns(affected) : null]);
    if (state.filter.label === oldName) state.filter.label = name;
    renderSettings(); renderFilters(); renderLedger(); renderReview();
    toast(`Renamed${affected.length ? ` on ${affected.length} transaction${affected.length > 1 ? "s" : ""}` : ""}`);
  };
  save.onclick = go;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") renderSettings(); });
  li.replaceChildren(input, save, cancel);
  input.focus(); input.select();
}

function deleteLabel(l) {
  state.labels = state.labels.filter((x) => x !== l);
  for (const [m, v] of Object.entries(state.memory)) if (v === l) delete state.memory[m];
  saveLabels(); saveMemory();
  renderSettings(); renderFilters();
  toast(`Deleted “${l}”`, { label: "Undo", fn: () => { ensureLabel(l); renderSettings(); renderFilters(); } });
}

async function disconnectAi() {
  if (!(await confirmBox("Disconnect the AI? The API key is removed from this device. Your transactions stay.", "Disconnect"))) return;
  state.ai = null;
  await db.set("ai", null);
  renderAiChip(); renderSettings(); renderQueue();
  toast("Disconnected");
}

// ---------- Export / backup ----------

function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const rows = state.txns.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const head = ["S.No", "Date", "Month", "Transaction Name", "Label", "Type", "Amount", "Currency", "Credit/Debit", "Merchant", "Source file", "Description"];
  const lines = [head.join(",")].concat(rows.map((t, i) => [
    i + 1, t.date, monthLabel(monthKey(t.date)), t.name, t.label, t.type, t.amount, t.currency || "INR",
    t.direction === "credit" ? "Credit" : "Debit", t.merchant, t.source, t.description
  ].map((v, j) => (j === 6 || j === 0 ? String(v) : csvCell(v))).join(",")));
  download(`finance-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv", "﻿" + lines.join("\r\n"));
}

async function exportJson() {
  const data = { app: "finance", version: APP_VERSION, exportedAt: new Date().toISOString(), labels: state.labels, memory: state.memory, txns: state.txns };
  download(`finance-backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json", JSON.stringify(data, null, 1));
}

async function importJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("That file isn't a Finance backup"); return; }
  if (data?.app !== "finance" || !Array.isArray(data.txns)) { toast("That file isn't a Finance backup"); return; }
  if (!(await confirmBox(`Restore ${data.txns.length} transactions and ${data.labels?.length || 0} labels? Records with the same ID are replaced; others are kept.`, "Restore"))) return;
  const clean = data.txns.filter((t) => t && typeof t.id === "string" && typeof t.amount === "number");
  await db.putTxns(clean);
  for (const l of data.labels || []) if (typeof l === "string") ensureLabel(l.slice(0, 40));
  Object.assign(state.memory, data.memory || {});
  await saveMemory();
  state.txns = await db.allTxns();
  renderFilters(); renderLedger(); renderSettings();
  toast(`Restored ${clean.length} transactions`);
}

function download(name, mime, text) {
  // Android app: hand the file to the system "save as" screen.
  if (window.FinanceAndroid?.saveFile) {
    window.FinanceAndroid.saveFile(name, mime, text);
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function wipe() {
  if (!(await confirmBox("Delete all transactions, labels, learned merchants and the AI key from this device? This can't be undone. Export a backup first if you might need it.", "Delete everything"))) return;
  await db.clearTxns(); await db.clearKv();
  await load();
  renderAll();
  toast("All data deleted");
}

// ---------- Setup wizard ----------

function renderAiChip() {
  const c = $("aiChip");
  if (state.ai) {
    c.textContent = `${PROVIDERS[state.ai.provider].name} · ${state.ai.model}`;
    c.classList.add("on");
  } else {
    c.textContent = "Connect AI";
    c.classList.remove("on");
  }
}

function wizStep(n) {
  document.querySelectorAll(".wiz").forEach((w) => { w.hidden = w.dataset.wiz !== String(n); });
  document.querySelectorAll("#steps li").forEach((li) => {
    const s = +li.dataset.step;
    li.classList.toggle("on", s === n);
    li.classList.toggle("done", s < n);
  });
  if (n === 2) renderWiz2();
  if (n === 3) renderWiz3();
  scrollTo(0, 0);
}

function renderWiz1() {
  const sel = state.wizard.provider;
  $("providerCards").replaceChildren(...Object.entries(PROVIDERS).map(([id, p]) => h("button", {
    type: "button", class: `prov ${sel === id ? "on" : ""}`, "aria-pressed": sel === id ? "true" : "false",
    onclick: () => { state.wizard.provider = id; state.wizard.models = null; renderWiz1(); }
  },
  h("span", { class: "dot" }), h("span", { class: "pn" }, p.name), h("span", { class: "pv" }, `by ${p.vendor}${id === "gemini" ? " · has a free tier" : ""}`))));
  $("wiz1Next").disabled = !sel;
}

function renderWiz2() {
  const p = PROVIDERS[state.wizard.provider];
  $("wiz2Title").textContent = `Get a ${p.name} API key`;
  const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener" }, text);
  const steps = {
    anthropic: [
      ["Open ", link(p.keyUrl, "console.anthropic.com → API keys"), " and sign in (same email as claude.ai is fine)."],
      ["Add credit under ", link(p.billingUrl, "Billing"), ". A few dollars covers many statements."],
      ["Click ", h("b", null, "Create Key"), ", name it “Finance app”, and copy it. It's shown only once."]
    ],
    openai: [
      ["Open ", link(p.keyUrl, "platform.openai.com → API keys"), " and sign in."],
      ["Add credit under ", link(p.billingUrl, "Billing"), "."],
      ["Click ", h("b", null, "Create new secret key"), ", name it “Finance app”, and copy it. It's shown only once."]
    ],
    gemini: [
      ["Open ", link(p.keyUrl, "aistudio.google.com → Get API key"), " and sign in with your Google account."],
      ["Click ", h("b", null, "Create API key"), " and copy it."],
      ["Optional: turn on billing for the key's Google Cloud project (see the note below)."]
    ]
  }[state.wizard.provider];
  $("howto").replaceChildren(...steps.map((s) => h("li", null, ...s)));
  $("providerNote").textContent = p.note;
}

function renderWiz3() {
  const p = PROVIDERS[state.wizard.provider];
  $("wiz3Title").textContent = `Connect ${p.name}`;
  $("keyHint").textContent = `Paste the key here. A ${p.vendor} key ${p.keyHint}.`;
  const same = state.ai && state.ai.provider === state.wizard.provider;
  if (same && !$("apiKey").value) $("apiKey").value = state.ai.key;
  $("testStatus").textContent = ""; $("testStatus").className = "status";
  $("modelField").hidden = !state.wizard.models;
  $("saveAi").disabled = !state.wizard.models;
}

async function testKey() {
  const key = $("apiKey").value.trim();
  const p = PROVIDERS[state.wizard.provider];
  const st = $("testStatus");
  if (!key) { st.textContent = "Paste a key first."; st.className = "status err"; return; }
  if (!p.keyPattern.test(key)) {
    st.textContent = `That doesn't look like a ${p.vendor} key (it ${p.keyHint}). Trying anyway…`; st.className = "status";
  } else { st.textContent = "Checking…"; st.className = "status"; }
  $("testBtn").disabled = true;
  try {
    const { list, recommended } = await listModels(state.wizard.provider, key);
    state.wizard.models = list;
    const sel = $("modelSelect");
    sel.replaceChildren(...list.map((m) => h("option", { value: m.id }, m.label === m.id ? m.id : `${m.label} (${m.id})`)));
    sel.value = state.ai?.provider === state.wizard.provider && list.some((m) => m.id === state.ai.model) ? state.ai.model : recommended;
    st.textContent = `Connected. ${list.length} models available.`; st.className = "status ok";
    $("modelField").hidden = false;
    $("saveAi").disabled = false;
  } catch (e) {
    state.wizard.models = null;
    st.textContent = e.message; st.className = "status err";
    $("modelField").hidden = true;
    $("saveAi").disabled = true;
  } finally { $("testBtn").disabled = false; }
}

async function saveAi() {
  state.ai = { provider: state.wizard.provider, key: $("apiKey").value.trim(), model: $("modelSelect").value };
  await db.set("ai", state.ai);
  $("apiKey").value = "";
  renderAiChip(); renderSettings(); renderQueue();
  toast(`${PROVIDERS[state.ai.provider].name} connected`);
  location.hash = "#import";
}

// ---------- Routing ----------

function route() {
  let v = (location.hash || "").slice(1);
  if (!["ledger", "import", "settings", "setup"].includes(v)) v = state.txns.length || state.ai ? "ledger" : "setup";
  document.querySelectorAll(".view").forEach((s) => { s.hidden = s.id !== `view-${v}`; });
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === v || (v === "setup" && a.dataset.tab === "settings")));
  if (v === "setup") {
    state.wizard.provider = state.wizard.provider || state.ai?.provider || null;
    state.wizard.models = null;
    renderWiz1(); wizStep(1);
  }
  if (v === "import") $("needAi").hidden = !!state.ai;
  closePicker();
}

// ---------- Wiring ----------

function renderAll() {
  renderAiChip(); renderFilters(); renderLedger(); renderQueue(); renderReview(); renderSettings(); route();
}

function wire() {
  addEventListener("hashchange", route);
  $("aiChip").addEventListener("click", () => { location.hash = state.ai ? "#settings" : "#setup"; });

  // Ledger controls
  $("q").addEventListener("input", (e) => { state.filter.q = e.target.value; renderLedger(); });
  $("fMonth").addEventListener("change", (e) => { state.filter.month = e.target.value; renderLedger(); });
  $("fLabel").addEventListener("change", (e) => { state.filter.label = e.target.value; renderLedger(); });
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    state.ledgerMode = b.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
    try { localStorage.setItem("finance.ledgerMode", state.ledgerMode); } catch { /* storage may be off */ }
    renderLedger();
  }));
  document.querySelectorAll("[data-rmode]").forEach((b) => b.addEventListener("click", () => {
    state.reviewMode = b.dataset.rmode;
    document.querySelectorAll("[data-rmode]").forEach((x) => x.classList.toggle("on", x === b));
    renderReview();
  }));
  try {
    const m = localStorage.getItem("finance.ledgerMode");
    if (m === "group" || m === "list") {
      state.ledgerMode = m;
      document.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === m));
    }
  } catch { /* storage may be off */ }

  // Import
  $("fileInput").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles([...(e.dataTransfer?.files || [])]));
  addEventListener("paste", (e) => {
    if (location.hash !== "#import") return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { addFiles(files); e.preventDefault(); }
  });
  $("runBtn").addEventListener("click", runQueue);
  $("clearQueue").addEventListener("click", () => { state.queue = []; renderQueue(); });
  $("selAll").addEventListener("click", () => { state.pending.forEach((t) => { if (!t.invalid) t.include = true; }); savePending(); renderReview(); });
  $("selNone").addEventListener("click", () => { state.pending.forEach((t) => { t.include = false; }); savePending(); renderReview(); });
  $("commitBtn").addEventListener("click", commitPending);
  $("discardBtn").addEventListener("click", discardPending);

  // Settings
  $("addLabelForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("newLabel").value.trim().slice(0, 40);
    if (!v) return;
    if (state.labels.some((l) => norm(l) === norm(v))) { toast("That label already exists"); return; }
    ensureLabel(v); $("newLabel").value = ""; renderSettings(); toast(`Added “${v}”`);
  });
  $("exportCsv").addEventListener("click", exportCsv);
  $("exportJson").addEventListener("click", exportJson);
  $("importJson").addEventListener("change", (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; });
  $("wipe").addEventListener("click", wipe);

  // Wizard
  $("wiz1Next").addEventListener("click", () => wizStep(2));
  $("wiz2Next").addEventListener("click", () => wizStep(3));
  document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => wizStep(+b.dataset.back)));
  $("toggleKey").addEventListener("click", () => {
    const i = $("apiKey");
    i.type = i.type === "password" ? "text" : "password";
    $("toggleKey").textContent = i.type === "password" ? "Show" : "Hide";
  });
  $("apiKey").addEventListener("input", () => { state.wizard.models = null; $("saveAi").disabled = true; $("modelField").hidden = true; });
  $("testBtn").addEventListener("click", testKey);
  $("saveAi").addEventListener("click", saveAi);

  setupPicker();
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("picker").hidden) closePicker(); });
}

async function start() {
  $("ver").textContent = "v" + APP_VERSION;
  wire();
  try {
    await load();
  } catch (e) {
    document.body.prepend(h("div", { class: "notice warn" }, "This browser blocked on-device storage, so nothing can be saved. Open the app in a normal (not private) window."));
  }
  renderAll();
  // The Android app serves files itself, so it has no service worker.
  if ("serviceWorker" in navigator && location.hostname !== "appassets.androidplatform.net") {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* offline support is optional */ });
  }
}

start();
