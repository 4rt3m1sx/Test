import { connect } from "cloudflare:sockets";

const AMP_SENDER = "lydialament@gmail.com";
const STAGE_SENDER = "lmludick@gmail.com";
const RECIPIENT = "lmludick@gmail.com";
const TODOIST_API = "https://api.todoist.com/api/v1";
const WORKER_BASE_URL = "https://test.lmludick.workers.dev";
const STAGE_SUBJECT_PREFIX = "DA-STAGE:";
const STAGE_MARKER = "DA_PAYLOAD_V1";

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      ...extraHeaders,
    },
  });
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function base64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function taskSignature(secret, taskId, due) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = new TextEncoder().encode(`${taskId}\n${due}\n${RECIPIENT}`);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

function constantTimeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function ampCorsHeaders(request, url) {
  const ampSender = request.headers.get("AMP-Email-Sender");
  if (ampSender) {
    if (ampSender.toLowerCase() !== AMP_SENDER) {
      return { error: "Unauthorised AMP sender" };
    }
    return { headers: { "AMP-Email-Allow-Sender": ampSender } };
  }

  const origin = request.headers.get("Origin");
  const sourceOrigin = url.searchParams.get("__amp_source_origin");
  if (!origin || !sourceOrigin) return { error: "Missing AMP email CORS headers" };
  if (sourceOrigin.toLowerCase() !== AMP_SENDER) return { error: "Unauthorised AMP sender" };

  return {
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": "AMP-Access-Control-Allow-Source-Origin",
      "AMP-Access-Control-Allow-Source-Origin": sourceOrigin,
    },
  };
}

async function completeTodoistTask(request, env) {
  const url = new URL(request.url);
  const cors = ampCorsHeaders(request, url);
  if (cors.error) return json({ ok: false, message: cors.error }, 403);
  if (request.method !== "POST") return json({ ok: false, message: "POST required" }, 405, cors.headers);
  if (!env.TODOIST_TOKEN || !env.EMAIL_ACTION_SECRET) {
    return json({ ok: false, message: "Worker secrets are not configured" }, 500, cors.headers);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, message: "Invalid form payload" }, 400, cors.headers);
  }

  const taskId = String(form.get("task") || "").trim();
  const expectedDue = String(form.get("due") || "none").trim();
  const suppliedSig = String(form.get("sig") || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return json({ ok: false, message: "Invalid Todoist task ID" }, 400, cors.headers);
  if (!suppliedSig) return json({ ok: false, message: "Missing action signature" }, 403, cors.headers);

  const expectedSig = await taskSignature(env.EMAIL_ACTION_SECRET, taskId, expectedDue);
  if (!constantTimeEqual(suppliedSig, expectedSig)) {
    return json({ ok: false, message: "Invalid action signature" }, 403, cors.headers);
  }

  const authHeaders = { Authorization: `Bearer ${env.TODOIST_TOKEN}` };
  const taskResponse = await fetch(`${TODOIST_API}/tasks/${encodeURIComponent(taskId)}`, { headers: authHeaders });

  if (taskResponse.status === 404) {
    return json({ ok: true, state: "already-completed", message: "Already completed" }, 200, cors.headers);
  }
  if (!taskResponse.ok) {
    return json({ ok: false, message: "Could not verify Todoist task" }, 502, cors.headers);
  }

  const task = await taskResponse.json();
  const currentDue = task?.due?.date ? String(task.due.date) : "none";
  if (currentDue !== expectedDue) {
    return json(
      { ok: false, state: "stale", message: "This email contains an old occurrence of this task" },
      409,
      cors.headers,
    );
  }

  const closeResponse = await fetch(`${TODOIST_API}/tasks/${encodeURIComponent(taskId)}/close`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!closeResponse.ok) return json({ ok: false, message: "Todoist completion failed" }, 502, cors.headers);
  return json({ ok: true, state: "completed", message: "Completed" }, 200, cors.headers);
}

class ByteSocket {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = new Uint8Array(0);
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  async fill() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error("Connection closed unexpectedly");
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer, 0);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
  }

  async readLine() {
    while (true) {
      for (let i = 0; i + 1 < this.buffer.length; i += 1) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 2);
          return this.decoder.decode(line);
        }
      }
      await this.fill();
    }
  }

  async readExact(n) {
    while (this.buffer.length < n) await this.fill();
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }

  async writeLine(value) {
    await this.writer.write(this.encoder.encode(`${value}\r\n`));
  }

  async writeRaw(value) {
    await this.writer.write(typeof value === "string" ? this.encoder.encode(value) : value);
  }

  async close() {
    try { await this.writer.close(); } catch {}
    try { await this.reader.cancel(); } catch {}
    try { await this.socket.close(); } catch {}
  }
}

class ImapClient {
  constructor(io) {
    this.io = io;
    this.counter = 1;
  }

  async command(command) {
    const tag = `A${String(this.counter++).padStart(4, "0")}`;
    await this.io.writeLine(`${tag} ${command}`);
    const lines = [];
    const literals = [];

    while (true) {
      const line = await this.io.readLine();
      lines.push(line);
      const literalMatch = line.match(/\{(\d+)\}$/);
      if (literalMatch) {
        const bytes = await this.io.readExact(Number(literalMatch[1]));
        literals.push(this.io.decoder.decode(bytes));
      }
      if (line.startsWith(`${tag} `)) {
        if (!/\sOK\b/i.test(line)) throw new Error(`IMAP command failed: ${line}`);
        return { lines, literals };
      }
    }
  }
}

function imapQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function decodeQuotedPrintable(input) {
  const compact = input.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < compact.length; i += 1) {
    if (compact[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(compact.slice(i + 1, i + 3))) {
      bytes.push(parseInt(compact.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(compact.charCodeAt(i) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeTransfer(body, encoding) {
  const enc = String(encoding || "").toLowerCase();
  if (enc.includes("base64")) {
    const binary = atob(body.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  if (enc.includes("quoted-printable")) return decodeQuotedPrintable(body);
  return body;
}

function parseHeaders(text) {
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (headers[key]) headers[key] += `\n${value}`;
    else headers[key] = value;
  }
  return headers;
}

function splitRawMessage(raw) {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match) return { headerText: raw, body: "" };
  const idx = match.index;
  return { headerText: raw.slice(0, idx), body: raw.slice(idx + match[0].length) };
}

function extractPlainText(raw) {
  const { headerText, body } = splitRawMessage(raw);
  const headers = parseHeaders(headerText);
  const contentType = headers["content-type"] || "text/plain";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);

  if (/multipart\//i.test(contentType) && boundaryMatch) {
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    for (const chunk of body.split(`--${boundary}`)) {
      if (!chunk || chunk.startsWith("--")) continue;
      const part = splitRawMessage(chunk.replace(/^\r?\n/, ""));
      const partHeaders = parseHeaders(part.headerText);
      if ((partHeaders["content-type"] || "").toLowerCase().startsWith("text/plain")) {
        return decodeTransfer(part.body.replace(/\r?\n$/, ""), partHeaders["content-transfer-encoding"]);
      }
    }
    throw new Error("No text/plain staging part found");
  }

  return decodeTransfer(body, headers["content-transfer-encoding"]);
}

function validateStagedMessage(raw) {
  const { headerText } = splitRawMessage(raw);
  const headers = parseHeaders(headerText);
  const from = String(headers.from || "").toLowerCase();
  const subject = String(headers.subject || "");
  const auth = String(headers["authentication-results"] || "").toLowerCase();

  if (!from.includes(STAGE_SENDER)) throw new Error("Unexpected staging sender");
  if (!subject.startsWith(STAGE_SUBJECT_PREFIX)) throw new Error("Unexpected staging subject");
  if (!auth.includes("dmarc=pass") && !auth.includes("dkim=pass")) {
    throw new Error("Staging message authentication did not pass");
  }
}

function parsePayload(raw) {
  validateStagedMessage(raw);
  const plain = extractPlainText(raw).trim();
  const marker = plain.indexOf(STAGE_MARKER);
  if (marker < 0) throw new Error("Missing staging payload marker");
  const jsonText = plain.slice(marker + STAGE_MARKER.length).trim();
  const payload = JSON.parse(jsonText);
  if (payload?.version !== 1) throw new Error("Unsupported staging payload version");
  if (!payload.subject || !Array.isArray(payload.sections)) throw new Error("Invalid staging payload");
  return payload;
}

function validatePayload(payload) {
  if (String(payload.subject).length > 180) throw new Error("Subject too long");
  if (payload.sections.length > 20) throw new Error("Too many sections");
  let items = 0;
  for (const section of payload.sections) {
    if (!section?.title || !Array.isArray(section.items)) throw new Error("Invalid section");
    items += section.items.length;
    if (items > 120) throw new Error("Too many payload items");
    for (const item of section.items) {
      if (item.kind === "task") {
        if (!/^[A-Za-z0-9_-]+$/.test(String(item.id || ""))) throw new Error("Invalid task ID in payload");
        if (item.url && !safeHttpsUrl(item.url)) throw new Error("Invalid task URL in payload");
      } else if (item.kind === "link" || item.kind === "image") {
        if (!safeHttpsUrl(item.url || item.src)) throw new Error("Invalid URL in payload");
      } else if (!["text", "alert"].includes(item.kind)) {
        throw new Error(`Unsupported item kind: ${item.kind}`);
      }
    }
  }
}

function renderControls(controls = []) {
  return controls
    .filter((c) => c?.label && safeHttpsUrl(c.url))
    .slice(0, 6)
    .map((c) => `<a class="control" href="${esc(safeHttpsUrl(c.url))}">${esc(c.label)}</a>`)
    .join("");
}

async function renderAmpTask(item, env) {
  const id = String(item.id);
  const due = String(item.due || "none");
  const sig = await taskSignature(env.EMAIL_ACTION_SECRET, id, due);
  const title = esc(item.title || "Todoist task");
  const url = safeHttpsUrl(item.url);
  const meta = item.meta ? `<div class="task-meta">${esc(item.meta)}</div>` : "";
  const indent = Math.min(Math.max(Number(item.indent || 0), 0), 3);
  const titleHtml = url ? `<a class="task-link" href="${esc(url)}">${title}</a>` : `<span class="task-link">${title}</span>`;

  return `<form class="task-form indent-${indent}" method="post" action-xhr="${WORKER_BASE_URL}/complete">
    <input type="hidden" name="task" value="${esc(id)}">
    <input type="hidden" name="due" value="${esc(due)}">
    <input type="hidden" name="sig" value="${esc(sig)}">
    <div class="task-row">
      <button class="check" type="submit" aria-label="Complete ${title}">
        <span class="box unchecked"></span><span class="box checked">&#10003;</span>
      </button>
      <div class="task-copy">${titleHtml}${meta}</div>
    </div>
    <div submit-success class="success-marker"></div>
    <div submit-error class="task-error">Could not complete this task in Todoist.</div>
  </form>`;
}

function renderAmpNonTask(item) {
  if (item.kind === "text") return `<div class="line">${esc(item.text)}</div>`;
  if (item.kind === "alert") return `<div class="alert">${esc(item.text)}</div>`;
  if (item.kind === "link") return `<div class="line"><a class="inline-link" href="${esc(safeHttpsUrl(item.url))}">${esc(item.text)}</a></div>`;
  if (item.kind === "image") {
    const src = safeHttpsUrl(item.src);
    const href = safeHttpsUrl(item.url || item.src);
    const width = Math.min(Math.max(Number(item.width || 620), 100), 1200);
    const height = Math.min(Math.max(Number(item.height || 260), 80), 900);
    const image = `<amp-img class="brief-image" src="${esc(src)}" width="${width}" height="${height}" layout="responsive" alt="${esc(item.alt || "")}"></amp-img>`;
    return href ? `<a href="${esc(href)}">${image}</a>` : image;
  }
  return "";
}

async function buildAmp(payload, env) {
  const sections = [];
  for (const section of payload.sections) {
    const rendered = [];
    for (const item of section.items) {
      rendered.push(item.kind === "task" ? await renderAmpTask(item, env) : renderAmpNonTask(item));
    }
    sections.push(`<section class="section"><h2>${esc(section.title)}</h2>${rendered.join("")}</section>`);
  }

  const subtitle = payload.subtitle ? `<div class="subtitle">${esc(payload.subtitle)}</div>` : "";
  const controls = renderControls(payload.controls);
  const controlsBlock = controls ? `<div class="controls">${controls}</div>` : "";

  return `<!doctype html>
<html amp4email>
<head>
  <meta charset="utf-8">
  <script async src="https://cdn.ampproject.org/v0.js"></script>
  <script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>
  <style amp4email-boilerplate>body{visibility:hidden}</style>
  <style amp-custom>
    body{margin:0;padding:0;background:#f3f4f6;color:#202124;font-family:Arial,Helvetica,sans-serif}
    .wrap{max-width:680px;margin:0 auto;padding:24px 12px 36px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden}
    .header{padding:24px 26px 18px;border-bottom:1px solid #eceef1}
    .eyebrow{font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#6b7280;margin:0 0 5px}
    h1{font-size:25px;line-height:1.25;margin:0;color:#202124}
    .subtitle{font-size:14px;color:#6b7280;margin-top:7px}
    .controls{padding:14px 26px 5px}
    .control{display:inline-block;margin:0 7px 7px 0;padding:8px 11px;border:1px solid #d9dde3;border-radius:8px;color:#3c4043;text-decoration:none;font-size:13px;font-weight:600;background:#fafbfc}
    .section{padding:18px 26px;border-top:1px solid #f0f1f3}
    .section:first-of-type{border-top:0}
    h2{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:0 0 10px}
    .task-form{margin:0 0 7px}
    .task-row{display:flex;align-items:flex-start;min-height:35px}
    .check{flex:0 0 30px;width:30px;height:30px;margin:0 5px 0 -5px;padding:5px;border:0;background:transparent;cursor:pointer}
    .box{box-sizing:border-box;display:inline-block;width:19px;height:19px;border:2px solid #8a9099;border-radius:5px;line-height:15px;text-align:center;font-size:13px;font-weight:700;color:#fff}
    .checked{display:none;background:#5f6368;border-color:#5f6368}
    .task-copy{padding-top:4px;min-width:0;line-height:1.35}
    .task-link{color:#202124;text-decoration:none;font-size:15px;font-weight:500}
    .task-meta{margin-top:2px;color:#7b8088;font-size:12px;line-height:1.35}
    .indent-1{margin-left:24px}.indent-2{margin-left:48px}.indent-3{margin-left:72px}
    .task-form.amp-form-submitting .check{opacity:.45;pointer-events:none}
    .task-form.amp-form-submit-success .unchecked{display:none}
    .task-form.amp-form-submit-success .checked{display:inline-block}
    .task-form.amp-form-submit-success .check{pointer-events:none}
    .success-marker{display:none}
    .task-error{margin:2px 0 5px 35px;color:#a33a3a;font-size:12px}
    .line{font-size:14px;line-height:1.5;margin:5px 0;color:#363a40}
    .inline-link{color:#2457a6;text-decoration:none}
    .alert{padding:10px 12px;border:1px solid #ead8b5;border-radius:9px;background:#fffaf0;font-size:14px;line-height:1.45;margin:7px 0}
    .brief-image{border-radius:10px;margin:7px 0}
    .footer{padding:8px 26px 22px;color:#9aa0a6;font-size:11px}
  </style>
</head>
<body><div class="wrap"><div class="card">
  <div class="header"><div class="eyebrow">Daily Assistant</div><h1>${esc(payload.title || payload.subject)}</h1>${subtitle}</div>
  ${controlsBlock}
  ${sections.join("")}
  <div class="footer">Interactive Todoist tasks complete in place in Gmail.</div>
</div></div></body></html>`;
}

function renderFallbackItem(item) {
  if (item.kind === "task") {
    const indent = Math.min(Math.max(Number(item.indent || 0), 0), 3) * 22;
    const url = safeHttpsUrl(item.url);
    const title = esc(item.title || "Todoist task");
    const titleHtml = url ? `<a href="${esc(url)}" style="color:#202124;text-decoration:none">${title}</a>` : title;
    const meta = item.meta ? `<div style="font-size:12px;color:#7b8088;margin-top:2px">${esc(item.meta)}</div>` : "";
    return `<div style="margin:5px 0 7px ${indent}px;font-size:15px;line-height:1.4"><span style="display:inline-block;width:22px;color:#7b8088">&#9744;</span>${titleHtml}${meta}</div>`;
  }
  if (item.kind === "link") return `<div style="font-size:14px;line-height:1.5;margin:5px 0"><a href="${esc(safeHttpsUrl(item.url))}" style="color:#2457a6;text-decoration:none">${esc(item.text)}</a></div>`;
  if (item.kind === "alert") return `<div style="padding:10px 12px;border:1px solid #ead8b5;border-radius:9px;background:#fffaf0;font-size:14px;line-height:1.45;margin:7px 0">${esc(item.text)}</div>`;
  if (item.kind === "image") return `<div style="margin:8px 0"><a href="${esc(safeHttpsUrl(item.url || item.src))}"><img src="${esc(safeHttpsUrl(item.src))}" alt="${esc(item.alt || "")}" style="display:block;max-width:100%;height:auto;border:0;border-radius:10px"></a></div>`;
  return `<div style="font-size:14px;line-height:1.5;margin:5px 0;color:#363a40">${esc(item.text)}</div>`;
}

function buildFallback(payload) {
  const controls = (payload.controls || [])
    .filter((c) => c?.label && safeHttpsUrl(c.url))
    .slice(0, 6)
    .map((c) => `<a href="${esc(safeHttpsUrl(c.url))}" style="display:inline-block;margin:0 7px 7px 0;padding:8px 11px;border:1px solid #d9dde3;border-radius:8px;color:#3c4043;text-decoration:none;font-size:13px;font-weight:600;background:#fafbfc">${esc(c.label)}</a>`)
    .join("");

  const sections = payload.sections.map((section) => `<div style="padding:18px 26px;border-top:1px solid #f0f1f3"><div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:10px">${esc(section.title)}</div>${section.items.map(renderFallbackItem).join("")}</div>`).join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;color:#202124;font-family:Arial,Helvetica,sans-serif"><div style="max-width:680px;margin:0 auto;padding:24px 12px 36px"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden"><div style="padding:24px 26px 18px;border-bottom:1px solid #eceef1"><div style="font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#6b7280;margin-bottom:5px">Daily Assistant</div><h1 style="font-size:25px;line-height:1.25;margin:0">${esc(payload.title || payload.subject)}</h1>${payload.subtitle ? `<div style="font-size:14px;color:#6b7280;margin-top:7px">${esc(payload.subtitle)}</div>` : ""}</div>${controls ? `<div style="padding:14px 26px 5px">${controls}</div>` : ""}${sections}<div style="padding:8px 26px 22px;color:#9aa0a6;font-size:11px">Open in Gmail for interactive Todoist checkboxes.</div></div></div></body></html>`;
}

function buildPlain(payload) {
  const out = [payload.title || payload.subject, payload.subtitle || "", ""];
  for (const section of payload.sections) {
    out.push(section.title.toUpperCase());
    for (const item of section.items) {
      if (item.kind === "task") out.push(`${"  ".repeat(Math.min(Number(item.indent || 0), 3))}[ ] ${item.title}${item.meta ? ` — ${item.meta}` : ""}`);
      else if (item.kind === "image") out.push(item.alt || item.url || item.src);
      else out.push(item.text || "");
    }
    out.push("");
  }
  return out.join("\r\n");
}

async function buildDailyMime(payload, env) {
  validatePayload(payload);
  if (!env.EMAIL_ACTION_SECRET) throw new Error("EMAIL_ACTION_SECRET is not configured");
  const boundary = `amp_${crypto.randomUUID().replaceAll("-", "")}`;
  const amp = await buildAmp(payload, env);
  const html = buildFallback(payload);
  const plain = buildPlain(payload);
  const parts = [
    `From: Daily Assistant <${AMP_SENDER}>`,
    `To: ${RECIPIENT}`,
    `Subject: ${String(payload.subject).replace(/[\r\n]/g, " ")}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@gmail.com>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plain,
    `--${boundary}`,
    "Content-Type: text/x-amp-html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    amp,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
    "",
  ];
  return parts.join("\r\n").replace(/(^|\r\n)\./g, "$1..");
}

async function sendMime(mime, env) {
  if (!env.GMAIL_APP_PASSWORD) throw new Error("GMAIL_APP_PASSWORD is not configured");
  const socket = connect({ hostname: "smtp.gmail.com", port: 465 }, { secureTransport: "on" });
  const io = new ByteSocket(socket);
  try {
    await socket.opened;
    const greeting = await io.readLine();
    if (!greeting.startsWith("220")) throw new Error(`SMTP greeting failed: ${greeting}`);
    await io.writeLine(`EHLO ${new URL(WORKER_BASE_URL).hostname}`);
    let line = await io.readLine();
    if (!line.startsWith("250")) throw new Error(`SMTP EHLO failed: ${line}`);
    while (line.startsWith("250-")) line = await io.readLine();

    await io.writeLine("AUTH LOGIN");
    if (!(await io.readLine()).startsWith("334")) throw new Error("SMTP AUTH LOGIN rejected");
    await io.writeLine(btoa(AMP_SENDER));
    if (!(await io.readLine()).startsWith("334")) throw new Error("SMTP username rejected");
    await io.writeLine(btoa(String(env.GMAIL_APP_PASSWORD).replaceAll(" ", "")));
    if (!(await io.readLine()).startsWith("235")) throw new Error("SMTP app password rejected");

    await io.writeLine(`MAIL FROM:<${AMP_SENDER}>`);
    if (!(await io.readLine()).startsWith("250")) throw new Error("SMTP MAIL FROM rejected");
    await io.writeLine(`RCPT TO:<${RECIPIENT}>`);
    if (!(await io.readLine()).startsWith("250")) throw new Error("SMTP RCPT TO rejected");
    await io.writeLine("DATA");
    if (!(await io.readLine()).startsWith("354")) throw new Error("SMTP DATA rejected");
    await io.writeRaw(`${mime}\r\n.\r\n`);
    if (!(await io.readLine()).startsWith("250")) throw new Error("SMTP message not accepted");
    await io.writeLine("QUIT");
    await io.readLine();
  } finally {
    await io.close();
  }
}

async function processStagedEmails(env) {
  if (!env.GMAIL_APP_PASSWORD) throw new Error("GMAIL_APP_PASSWORD is not configured");
  const socket = connect({ hostname: "imap.gmail.com", port: 993 }, { secureTransport: "on" });
  const io = new ByteSocket(socket);
  const imap = new ImapClient(io);
  const results = [];

  try {
    await socket.opened;
    const greeting = await io.readLine();
    if (!greeting.startsWith("* OK")) throw new Error(`IMAP greeting failed: ${greeting}`);
    await imap.command(`LOGIN ${imapQuote(AMP_SENDER)} ${imapQuote(String(env.GMAIL_APP_PASSWORD).replaceAll(" ", ""))}`);
    await imap.command("SELECT INBOX");
    const search = await imap.command(`SEARCH UNSEEN FROM ${imapQuote(STAGE_SENDER)} SUBJECT ${imapQuote(STAGE_SUBJECT_PREFIX)}`);
    const searchLine = search.lines.find((line) => line.startsWith("* SEARCH")) || "* SEARCH";
    const ids = searchLine.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean).slice(-5);

    for (const id of ids) {
      try {
        const fetched = await imap.command(`FETCH ${id} BODY.PEEK[]`);
        const raw = fetched.literals[0];
        if (!raw) throw new Error("IMAP message body was empty");
        const payload = parsePayload(raw);
        const mime = await buildDailyMime(payload, env);
        await sendMime(mime, env);
        await imap.command(`STORE ${id} +FLAGS (\\Seen)`);
        results.push({ id, ok: true, subject: payload.subject });
      } catch (error) {
        results.push({ id, ok: false, error: String(error?.message || error) });
      }
    }

    await imap.command("LOGOUT");
    return { ok: results.every((r) => r.ok), found: ids.length, results };
  } finally {
    await io.close();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "todoist-email-complete", bridge: "imap-stage-to-amp" });
    }
    if (url.pathname === "/complete") return completeTodoistTask(request, env);
    if (url.pathname === "/process-staged") {
      try {
        return json(await processStagedEmails(env));
      } catch (error) {
        return json({ ok: false, message: String(error?.message || error) }, 500);
      }
    }
    return json({ ok: true, service: "todoist-email-complete", endpoints: ["/health", "/complete", "/process-staged"] });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(processStagedEmails(env).catch((error) => console.error("stage processing failed", error)));
  },
};
