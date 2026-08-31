import worker from "./main.js";

const AMP_SENDER = "lydialament@gmail.com";
const RECIPIENT = "lmludick@gmail.com";
const TODOIST_API = "https://api.todoist.com/api/v1";

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
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = encoder.encode(`${taskId}\n${due}\n${RECIPIENT}`);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();
  const aa = encoder.encode(String(a));
  const bb = encoder.encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function gmailStatusCors(request, url) {
  const ampSender = request.headers.get("AMP-Email-Sender");
  const sourceOrigin = url.searchParams.get("__amp_source_origin");
  const suppliedSender = ampSender || sourceOrigin;

  if (suppliedSender && suppliedSender.toLowerCase() !== AMP_SENDER) {
    return { error: "Unauthorised AMP sender" };
  }

  const origin = request.headers.get("Origin");
  return {
    headers: {
      "AMP-Email-Allow-Sender": AMP_SENDER,
      "AMP-Access-Control-Allow-Source-Origin": AMP_SENDER,
      "Access-Control-Allow-Origin": origin || "https://mail.google.com",
      "Access-Control-Expose-Headers": "AMP-Access-Control-Allow-Source-Origin, AMP-Email-Allow-Sender",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "AMP-Email-Sender, Content-Type",
      "Vary": "Origin, AMP-Email-Sender",
    },
  };
}

async function taskStatus(request, env) {
  const url = new URL(request.url);
  const cors = gmailStatusCors(request, url);
  if (cors.error) return json({ ok: false, message: cors.error }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors.headers });
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

  return json({
    items: [{
      open: isExactOccurrenceOpen,
      completed: !isExactOccurrenceOpen,
      state: isExactOccurrenceOpen ? "open" : "completed-or-superseded",
    }],
  }, 200, cors.headers);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/task-status") return taskStatus(request, env);
    return worker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
