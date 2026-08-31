import worker from "./index.js";

const OLD_WORKER_URL = "https://test.lmludick.workers.dev";
const PRODUCTION_WORKER_URL = "https://daily-assistant.lmludick.workers.dev";
const AMP_SENDER = "lydialament@gmail.com";
const RECIPIENT = "lmludick@gmail.com";
const TODOIST_API = "https://api.todoist.com/api/v1";

const nativeJsonParse = JSON.parse.bind(JSON);
const nativeTextEncode = TextEncoder.prototype.encode;

function rawEncode(value) {
  return nativeTextEncode.call(new TextEncoder(), String(value));
}

function escapeRawControlCharactersInJsonStrings(text) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const code = ch.charCodeAt(0);

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    if (code < 0x20) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }

    out += ch;
  }

  return out;
}

JSON.parse = function resilientJsonParse(value, reviver) {
  try {
    return nativeJsonParse(value, reviver);
  } catch (error) {
    if (typeof value !== "string") throw error;

    const repaired = escapeRawControlCharactersInJsonStrings(value);
    if (repaired === value) throw error;
    return nativeJsonParse(repaired, reviver);
  }
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      Pragma: "no-cache",
      ...extraHeaders,
    },
  });
}

function base64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function taskSignature(secret, taskId, due) {
  const key = await crypto.subtle.importKey(
    "raw",
    rawEncode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = rawEncode(`${taskId}\n${due}\n${RECIPIENT}`);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

function constantTimeEqual(a, b) {
  const aa = rawEncode(a);
  const bb = rawEncode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function ampCorsHeaders(request, url) {
  const ampSender = request.headers.get("AMP-Email-Sender");
  if (ampSender) {
    if (ampSender.toLowerCase() !== AMP_SENDER) return { error: "Unauthorised AMP sender" };
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

async function taskStatus(request, env) {
  const url = new URL(request.url);
  const cors = ampCorsHeaders(request, url);
  if (cors.error) return json({ ok: false, message: cors.error }, 403);
  if (request.method !== "GET") return json({ ok: false, message: "GET required" }, 405, cors.headers);
  if (!env.TODOIST_TOKEN || !env.EMAIL_ACTION_SECRET) {
    return json({ ok: false, message: "Worker secrets are not configured" }, 500, cors.headers);
  }

  const taskId = String(url.searchParams.get("task") || "").trim();
  const expectedDue = String(url.searchParams.get("due") || "none").trim();
  const suppliedSig = String(url.searchParams.get("sig") || "").trim();

  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return json({ ok: false, message: "Invalid Todoist task ID" }, 400, cors.headers);
  if (!suppliedSig) return json({ ok: false, message: "Missing action signature" }, 403, cors.headers);

  const expectedSig = await taskSignature(env.EMAIL_ACTION_SECRET, taskId, expectedDue);
  if (!constantTimeEqual(suppliedSig, expectedSig)) {
    return json({ ok: false, message: "Invalid action signature" }, 403, cors.headers);
  }

  const response = await fetch(`${TODOIST_API}/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${env.TODOIST_TOKEN}` },
  });

  if (response.status === 404) {
    return json({ items: [{ open: false, completed: true, state: "completed" }] }, 200, cors.headers);
  }
  if (!response.ok) {
    return json({ ok: false, message: "Could not verify Todoist task" }, 502, cors.headers);
  }

  const task = await response.json();
  const currentDue = task?.due?.date ? String(task.due.date) : "none";
  const isExactOccurrenceOpen = currentDue === expectedDue;

  return json(
    {
      items: [{
        open: isExactOccurrenceOpen,
        completed: !isExactOccurrenceOpen,
        state: isExactOccurrenceOpen ? "open" : "completed-or-superseded",
      }],
    },
    200,
    cors.headers,
  );
}

function htmlAttrUrl(url) {
  return String(url).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function injectSyncScripts(text) {
  if (!text.includes("<html amp4email>")) return text;
  if (text.includes('custom-element="amp-list"')) return text;

  return text.replace(
    '<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>',
    '<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>\n  <script async custom-element="amp-list" src="https://cdn.ampproject.org/v0/amp-list-0.1.js"></script>\n  <script async custom-template="amp-mustache" src="https://cdn.ampproject.org/v0/amp-mustache-0.2.js"></script>',
  );
}

function injectSyncCss(text) {
  if (!text.includes("<html amp4email>")) return text;
  if (text.includes(".task-status-list{")) return text;

  const marker = "    .footer{padding:8px 26px 22px;color:#9aa0a6;font-size:11px}\n";
  if (!text.includes(marker)) return text;

  const css = `${marker}    .task-status-list{flex:0 0 30px;width:30px;height:30px;margin:0 5px 0 -5px}\n    .task-status-list .check{margin:0;padding:5px}\n    .task-status-list form{margin:0}\n    .task-status-list .checked-sync{display:inline-block;background:#5f6368;border-color:#5f6368}\n    .task-status-list .loading-sync{border-color:#c8ccd2}\n    .sync-form.amp-form-submitting .check{opacity:.45;pointer-events:none}\n    .sync-form.amp-form-submit-success .unchecked{display:none}\n    .sync-form.amp-form-submit-success .checked{display:inline-block}\n    .sync-form.amp-form-submit-success .check{pointer-events:none}\n`;
  return text.replace(marker, css);
}

function upgradeTaskForms(text) {
  if (!text.includes("<html amp4email>")) return text;
  if (text.includes("/task-status?task=")) return text;

  const taskFormPattern = /<form class="task-form indent-(\d)" method="post" action-xhr="([^"]+\/complete)">\s*<input type="hidden" name="task" value="([^"]+)">\s*<input type="hidden" name="due" value="([^"]+)">\s*<input type="hidden" name="sig" value="([^"]+)">\s*<div class="task-row">\s*<button class="check" type="submit" aria-label="([^"]*)">[\s\S]*?<\/button>\s*(<div class="task-copy">[\s\S]*?<\/div>)\s*<\/div>\s*<div submit-success class="success-marker"><\/div>\s*<div submit-error class="task-error">Could not complete this task in Todoist\.<\/div>\s*<\/form>/g;

  return text.replace(taskFormPattern, (_match, indent, actionUrlRaw, taskId, due, sig, ariaLabel, taskCopy) => {
    const actionUrl = actionUrlRaw.replaceAll(OLD_WORKER_URL, PRODUCTION_WORKER_URL);
    const listId = `task-status-${taskId}`;
    const statusUrl = `${PRODUCTION_WORKER_URL}/task-status?task=${encodeURIComponent(taskId)}&due=${encodeURIComponent(due)}&sig=${encodeURIComponent(sig)}`;

    return `<div class="task-form indent-${indent}">\n    <div class="task-row">\n      <amp-list id="${listId}" class="task-status-list" width="30" height="30" layout="fixed" src="${htmlAttrUrl(statusUrl)}" binding="no">\n        <template type="amp-mustache">\n          {{#open}}\n          <form class="sync-form" method="post" action-xhr="${actionUrl}" on="submit-success:${listId}.refresh">\n            <input type="hidden" name="task" value="${taskId}">\n            <input type="hidden" name="due" value="${due}">\n            <input type="hidden" name="sig" value="${sig}">\n            <button class="check" type="submit" aria-label="${ariaLabel}">\n              <span class="box unchecked"></span><span class="box checked">&#10003;</span>\n            </button>\n            <div submit-success class="success-marker"></div>\n            <div submit-error class="success-marker"></div>\n          </form>\n          {{/open}}\n          {{#completed}}\n          <span class="check" aria-label="Completed"><span class="box checked-sync">&#10003;</span></span>\n          {{/completed}}\n        </template>\n        <div placeholder class="check"><span class="box loading-sync"></span></div>\n      </amp-list>\n      ${taskCopy}\n    </div>\n  </div>`;
  });
}

function transformOutboundMime(value) {
  let text = String(value).replaceAll(OLD_WORKER_URL, PRODUCTION_WORKER_URL);
  if (!text.includes("<html amp4email>")) return text;
  text = injectSyncScripts(text);
  text = injectSyncCss(text);
  text = upgradeTaskForms(text);
  return text;
}

TextEncoder.prototype.encode = function productionAmpTextEncode(value = "") {
  return nativeTextEncode.call(this, transformOutboundMime(value));
};

const syncedWorker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/task-status") return taskStatus(request, env);
    return worker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};

export default syncedWorker;
