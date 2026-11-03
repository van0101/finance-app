// LLM providers. The phone talks to the provider directly with the user's own API key:
// there is no server in between. Each provider gets the same prompt and returns the same JSON shape.

export const TXN_TYPES = ["Expense", "Income", "Investment", "Transfer", "Refund", "Savings"];
const DOC_KINDS = ["bank_statement", "credit_card_statement", "upi_or_wallet_screenshot", "receipt", "invoice", "other_financial", "not_financial"];

export const PROVIDERS = {
  anthropic: {
    name: "Claude",
    vendor: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    billingUrl: "https://console.anthropic.com/settings/billing",
    keyHint: "starts with sk-ant-",
    keyPattern: /^sk-ant-/,
    note: "A Claude Pro/Max subscription doesn't include API access. The API is billed separately: add a few dollars of credit in the Anthropic Console first.",
    preferModel: [/sonnet/, /haiku/, /opus/]
  },
  openai: {
    name: "ChatGPT",
    vendor: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
    keyHint: "starts with sk-",
    keyPattern: /^sk-/,
    note: "A ChatGPT Plus/Pro subscription doesn't include API access. The API is billed separately: add credit on platform.openai.com first.",
    preferModel: [/^gpt-\d+(\.\d+)?-mini$/, /^gpt-\d+(\.\d+)?$/, /^gpt-/, /^o\d/]
  },
  gemini: {
    name: "Gemini",
    vendor: "Google",
    keyUrl: "https://aistudio.google.com/apikey",
    billingUrl: "https://aistudio.google.com/usage",
    keyHint: "starts with AIza",
    keyPattern: /^AIza/,
    note: "Google AI Studio keys have a free tier. On the free tier Google may use what you send to improve its products, and that includes your statements. Turn on billing for the key's project to switch to the paid tier, where it doesn't.",
    preferModel: [/flash(?!.*lite)/, /flash/, /pro/]
  }
};

// ---------- Prompt and output shape ----------

export function buildPrompt(labels, memory) {
  const hints = Object.entries(memory || {}).slice(0, 150)
    .map(([m, l]) => `${m} => ${l}`).join("\n");
  return [
    "You read financial documents (bank statements, credit card statements, UPI or wallet app screenshots, receipts, invoices) and list every transaction in them.",
    "",
    "Rules:",
    "- One entry per transaction line. Never invent, merge or split transactions. If a row is cut off or unreadable, skip it and say so in warnings.",
    "- Skip opening/closing balance rows, running balances, totals, summaries, reward points and ads.",
    "- date: ISO YYYY-MM-DD. Indian statements print DD/MM/YYYY or DD-MM-YY. If the year is missing, infer it from the statement period.",
    "- amount: positive number, no currency symbols or commas. direction: \"debit\" (money out) or \"credit\" (money in).",
    "- name: short, readable counterparty plus what it is, e.g. \"Swiggy (food delivery)\", \"Uber (cab)\", \"HDFC credit card bill\", \"Salary - Acme Corp\". Drop UPI reference numbers and IDs.",
    "- merchant: a stable lowercase key for grouping the same counterparty across statements, e.g. \"swiggy\", \"uber\", \"hdfc credit card\", \"indian oil\". Same counterparty, same key.",
    "- description: the raw line as printed (shortened to about 120 characters).",
    "- type: one of " + TXN_TYPES.join(", ") + ". SIPs and mutual funds are Investment. Credit card bill payments and moves between own accounts are Transfer.",
    "- suggested_label: pick the best fit from the user's labels below. If none fits, propose a short new label in the same style (2-3 words).",
    "- If a known merchant mapping below matches, use that label.",
    "- document.is_financial: false if this is not a financial document; return no transactions in that case.",
    "- Never output full card or account numbers. Last 4 digits at most.",
    "",
    "User's labels:",
    labels.join(", ") || "(none yet)",
    "",
    "Known merchant => label mappings (chosen by the user):",
    hints || "(none yet)"
  ].join("\n");
}

// Standard JSON Schema (OpenAI strict mode needs every property required and no extras).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["document", "transactions", "warnings"],
  properties: {
    document: {
      type: "object",
      additionalProperties: false,
      required: ["is_financial", "kind", "currency", "period"],
      properties: {
        is_financial: { type: "boolean" },
        kind: { type: "string", enum: DOC_KINDS },
        currency: { type: "string", description: "ISO code, e.g. INR" },
        period: { type: "string", description: "Statement period or date of the document, empty if unknown" }
      }
    },
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "name", "merchant", "description", "amount", "direction", "type", "suggested_label"],
        properties: {
          date: { type: "string" },
          name: { type: "string" },
          merchant: { type: "string" },
          description: { type: "string" },
          amount: { type: "number" },
          direction: { type: "string", enum: ["debit", "credit"] },
          type: { type: "string", enum: TXN_TYPES },
          suggested_label: { type: "string" }
        }
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  }
};

// Gemini's responseSchema uses an OpenAPI subset: uppercase types, no additionalProperties.
function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.enum) out.enum = s.enum;
  if (s.description) out.description = s.description;
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toGeminiSchema(v);
    out.required = s.required;
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

const USER_TEXT = "List every transaction in this document using the rules. Return the JSON only.";

// ---------- HTTP ----------

async function call(url, opts, providerName) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error(`Couldn't reach ${providerName}. Check your internet connection.`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error?.type || text.slice(0, 200) || res.statusText;
    const hint = res.status === 401 || res.status === 403 ? " Check the API key."
      : res.status === 429 ? " Rate limit or credit exhausted: check billing on the provider's site."
      : res.status === 400 && /credit|balance|billing/i.test(msg) ? " Add credit on the provider's site." : "";
    const err = new Error(`${providerName} said: ${msg}.${hint}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function pickModel(ids, prefer) {
  for (const re of prefer) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0];
}

// ---------- Providers ----------

const impl = {
  anthropic: {
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json"
    }),
    async models(key) {
      const body = await call("https://api.anthropic.com/v1/models?limit=100", { headers: this.headers(key) }, "Anthropic");
      // Newest first already.
      return (body.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
    },
    async extract({ key, model, system, file }) {
      const part = file.mime === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } }
        : { type: "image", source: { type: "base64", media_type: file.mime, data: file.base64 } };
      const body = await call("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          system,
          tools: [{ name: "record_transactions", description: "Record the transactions found in the document.", input_schema: SCHEMA }],
          tool_choice: { type: "tool", name: "record_transactions" },
          messages: [{ role: "user", content: [part, { type: "text", text: USER_TEXT }] }]
        })
      }, "Anthropic");
      const use = (body.content || []).find((c) => c.type === "tool_use");
      if (!use) throw new Error("Claude didn't return any transactions.");
      return { data: use.input, truncated: body.stop_reason === "max_tokens", usage: body.usage };
    }
  },

  openai: {
    headers: (key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" }),
    async models(key) {
      const body = await call("https://api.openai.com/v1/models", { headers: this.headers(key) }, "OpenAI");
      const skip = /audio|realtime|tts|transcribe|whisper|embedding|image|dall-e|moderation|search|instruct|codex|davinci|babbage|computer/;
      return (body.data || [])
        .filter((m) => /^(gpt-|o\d)/.test(m.id) && !skip.test(m.id) && !/-\d{4}-\d{2}-\d{2}$/.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((m) => ({ id: m.id, label: m.id }));
    },
    async extract({ key, model, system, file }) {
      const dataUrl = `data:${file.mime};base64,${file.base64}`;
      const part = file.mime === "application/pdf"
        ? { type: "file", file: { filename: file.name || "statement.pdf", file_data: dataUrl } }
        : { type: "image_url", image_url: { url: dataUrl, detail: "high" } };
      const body = await call("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify({
          model,
          max_completion_tokens: 16000,
          response_format: { type: "json_schema", json_schema: { name: "transactions", strict: true, schema: SCHEMA } },
          messages: [
            { role: "system", content: system },
            { role: "user", content: [part, { type: "text", text: USER_TEXT }] }
          ]
        })
      }, "OpenAI");
      const choice = body.choices?.[0];
      if (choice?.message?.refusal) throw new Error(`ChatGPT refused: ${choice.message.refusal}`);
      return { data: parseJson(choice?.message?.content), truncated: choice?.finish_reason === "length", usage: body.usage };
    }
  },

  gemini: {
    headers: (key) => ({ "x-goog-api-key": key, "content-type": "application/json" }),
    async models(key) {
      const body = await call("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: this.headers(key) }, "Google");
      const skip = /embedding|tts|image|aqa|live|audio|robotics|computer|gemma|learnlm/;
      return (body.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }))
        .filter((m) => /gemini/.test(m.id) && !skip.test(m.id))
        .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    },
    async extract({ key, model, system, file }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = await call(url, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: file.mime, data: file.base64 } }, { text: USER_TEXT }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(SCHEMA), maxOutputTokens: 16000 }
        })
      }, "Google");
      const cand = body.candidates?.[0];
      if (!cand) throw new Error(`Gemini returned nothing${body.promptFeedback?.blockReason ? ` (blocked: ${body.promptFeedback.blockReason})` : ""}.`);
      const text = (cand.content?.parts || []).map((p) => p.text || "").join("");
      return { data: parseJson(text), truncated: cand.finishReason === "MAX_TOKENS", usage: body.usageMetadata };
    }
  }
};

function parseJson(text) {
  if (!text) throw new Error("The model returned an empty answer.");
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try { return JSON.parse(clean); } catch {
    throw new Error("The model's answer wasn't valid JSON. Try again, or try a different model.");
  }
}

export async function listModels(provider, key) {
  const list = await impl[provider].models(key);
  if (!list.length) throw new Error("The key works, but no suitable models were listed for it.");
  const recommended = pickModel(list.map((m) => m.id), PROVIDERS[provider].preferModel);
  return { list, recommended };
}

// Returns { document, transactions[], warnings[], truncated }
export async function extractTransactions({ provider, key, model, labels, memory, file }) {
  const system = buildPrompt(labels, memory);
  const { data, truncated } = await impl[provider].extract({ key, model, system, file });
  const doc = data?.document || {};
  const txns = Array.isArray(data?.transactions) ? data.transactions : [];
  const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];
  if (truncated) warnings.push("The answer was cut off (too many rows for one go). Some transactions may be missing: split the file and import the rest.");
  return { document: doc, transactions: doc.is_financial === false ? [] : txns, warnings };
}
