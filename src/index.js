import { connect } from "cloudflare:sockets";

const ALLOWED_SENDER = "lydialament@gmail.com";
const TEST_RECIPIENT = "lmludick@gmail.com";
const TODOIST_API = "https://api.todoist.com/api/v1";
const WORKER_BASE_URL = "https://test.lmludick.workers.dev";

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

function ampCorsHeaders(request, url) {
  const ampSender = request.headers.get("AMP-Email-Sender");

  if (ampSender) {
    if (ampSender.toLowerCase() !== ALLOWED_SENDER) {
      return { error: "Unauthorised AMP sender" };
    }

    return {
      headers: {
        "AMP-Email-Allow-Sender": ampSender,
      },
    };
  }

  const origin = request.headers.get("Origin");
  const sourceOrigin = url.searchParams.get("__amp_source_origin");

  if (!origin || !sourceOrigin) {
    return { error: "Missing AMP email CORS headers" };
  }

  if (sourceOrigin.toLowerCase() !== ALLOWED_SENDER) {
    return { error: "Unauthorised AMP sender" };
  }

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

  if (cors.error) {
    return json({ ok: false, message: cors.error }, 403);
  }

  if (request.method !== "POST") {
    return json({ ok: false, message: "POST required" }, 405, cors.headers);
  }

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
  const actionSecret = String(form.get("key") || "");

  if (actionSecret !== env.EMAIL_ACTION_SECRET) {
    return json({ ok: false, message: "Invalid action key" }, 403, cors.headers);
  }

  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    return json({ ok: false, message: "Invalid Todoist task ID" }, 400, cors.headers);
  }

  const authHeaders = { Authorization: `Bearer ${env.TODOIST_TOKEN}` };
  const taskResponse = await fetch(`${TODOIST_API}/tasks/${encodeURIComponent(taskId)}`, {
    headers: authHeaders,
  });

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

  if (!closeResponse.ok) {
    return json({ ok: false, message: "Todoist completion failed" }, 502, cors.headers);
  }

  return json({ ok: true, state: "completed", message: "Completed" }, 200, cors.headers);
}

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.buffer = "";
  }

  async line() {
    while (!this.buffer.includes("\r\n")) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SMTP connection closed unexpectedly");
      this.buffer += this.decoder.decode(value, { stream: true });
    }

    const end = this.buffer.indexOf("\r\n");
    const line = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 2);
    return line;
  }

  async expect(code) {
    const expected = String(code);
    let line = await this.line();

    if (!line.startsWith(expected)) {
      throw new Error(`SMTP expected ${expected}, got: ${line}`);
    }

    while (line.startsWith(`${expected}-`)) {
      line = await this.line();
      if (!line.startsWith(expected)) throw new Error(`Malformed SMTP reply: ${line}`);
    }

    return line;
  }

  async sendLine(value) {
    await this.writer.write(this.encoder.encode(`${value}\r\n`));
  }

  async sendRaw(value) {
    await this.writer.write(this.encoder.encode(value));
  }

  async close() {
    try { await this.writer.close(); } catch {}
    try { await this.reader.cancel(); } catch {}
    try { await this.socket.close(); } catch {}
  }
}

function makeMimeMessage(taskId, expectedDue, actionSecret) {
  const boundary = `amp_${crypto.randomUUID().replaceAll("-", "")}`;
  const date = new Date().toUTCString();
  const messageId = `<${crypto.randomUUID()}@gmail.com>`;
  const safeTask = taskId.replaceAll('"', "");
  const safeDue = expectedDue.replaceAll('"', "");
  const safeKey = actionSecret.replaceAll('"', "");

  const amp = `<!doctype html>
<html amp4email>
<head>
  <meta charset="utf-8">
  <script async src="https://cdn.ampproject.org/v0.js"></script>
  <script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>
  <script async custom-element="amp-bind" src="https://cdn.ampproject.org/v0/amp-bind-0.1.js"></script>
  <style amp4email-boilerplate>body{visibility:hidden}</style>
  <style amp-custom>
    body{font-family:Arial,sans-serif;background:#f5f5f5;color:#222;padding:24px}
    .card{max-width:620px;margin:auto;background:#fff;border-radius:12px;padding:24px}
    .task{border:0;background:transparent;font:16px Arial,sans-serif;padding:8px 0;cursor:pointer;color:#222;text-align:left}
    .box{display:inline-block;width:24px;font-size:20px;vertical-align:-1px}
    .done{font:16px Arial,sans-serif;padding:8px 0}
    .muted{font-size:13px;color:#777;margin-top:16px}
    .error{font-size:13px;color:#9b1c1c;margin-top:8px}
  </style>
</head>
<body>
  <amp-state id="taskState"><script type="application/json">{"done":false}</script></amp-state>
  <div class="card">
    <h2>Todoist checkbox test</h2>
    <p>Click the checkbox. It should complete the Todoist task without opening another page.</p>

    <form method="post"
          action-xhr="${WORKER_BASE_URL}/complete"
          target="_top"
          on="submit-success:AMP.setState({taskState:{done:true}})"
          [hidden]="taskState.done">
      <input type="hidden" name="task" value="${safeTask}">
      <input type="hidden" name="due" value="${safeDue}">
      <input type="hidden" name="key" value="${safeKey}">
      <button type="submit" class="task"><span class="box">&#9744;</span>AMP email completion test</button>
      <div submitting class="muted">Completing in Todoist...</div>
      <div submit-error class="error">Could not complete the task. Nothing was changed.</div>
    </form>

    <div class="done" hidden [hidden]="!taskState.done"><span class="box">&#9745;</span>AMP email completion test</div>
    <div class="muted">Expected result: the checkbox changes here in this email. No new tab or window.</div>
  </div>
</body>
</html>`;

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif"><h2>Todoist checkbox test</h2><p>Your email client did not render the interactive AMP version.</p><p>Do not use this fallback to complete the task.</p></body></html>`;
  const plain = "Todoist checkbox test\r\n\r\nYour email client did not render the interactive AMP version.\r\n";

  const parts = [
    `From: Daily Assistant <${ALLOWED_SENDER}>`,
    `To: ${TEST_RECIPIENT}`,
    "Subject: AMP Todoist checkbox test",
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
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

async function sendTestEmail(request, env) {
  const url = new URL(request.url);
  const isGet = request.method === "GET";
  const isPost = request.method === "POST";

  if (!isGet && !isPost) {
    return json({ ok: false, message: "GET or POST required" }, 405);
  }

  const suppliedKey = isGet
    ? String(url.searchParams.get("key") || "")
    : String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

  if (!env.EMAIL_ACTION_SECRET || suppliedKey !== env.EMAIL_ACTION_SECRET) {
    return json({ ok: false, message: "Unauthorised" }, 403);
  }

  if (!env.GMAIL_APP_PASSWORD) {
    return json({ ok: false, message: "GMAIL_APP_PASSWORD is not configured" }, 500);
  }

  let taskId;
  let expectedDue;

  if (isGet) {
    taskId = String(url.searchParams.get("task") || "").trim();
    expectedDue = String(url.searchParams.get("due") || "none").trim();
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, message: "JSON body required" }, 400);
    }
    taskId = String(body.task || "").trim();
    expectedDue = String(body.due || "none").trim();
  }

  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    return json({ ok: false, message: "Invalid Todoist task ID" }, 400);
  }

  const socket = connect(
    { hostname: "smtp.gmail.com", port: 465 },
    { secureTransport: "on" },
  );
  const smtp = new SmtpClient(socket);

  try {
    await socket.opened;
    await smtp.expect(220);

    await smtp.sendLine("EHLO test.lmludick.workers.dev");
    await smtp.expect(250);

    await smtp.sendLine("AUTH LOGIN");
    await smtp.expect(334);
    await smtp.sendLine(btoa(ALLOWED_SENDER));
    await smtp.expect(334);
    await smtp.sendLine(btoa(String(env.GMAIL_APP_PASSWORD).replaceAll(" ", "")));
    await smtp.expect(235);

    await smtp.sendLine(`MAIL FROM:<${ALLOWED_SENDER}>`);
    await smtp.expect(250);
    await smtp.sendLine(`RCPT TO:<${TEST_RECIPIENT}>`);
    await smtp.expect(250);
    await smtp.sendLine("DATA");
    await smtp.expect(354);

    const mime = makeMimeMessage(taskId, expectedDue, env.EMAIL_ACTION_SECRET);
    await smtp.sendRaw(`${mime}\r\n.\r\n`);
    await smtp.expect(250);

    await smtp.sendLine("QUIT");
    await smtp.expect(221);

    return json({ ok: true, message: "AMP test email sent", to: TEST_RECIPIENT });
  } catch (error) {
    return json({ ok: false, message: "SMTP send failed", detail: String(error?.message || error) }, 502);
  } finally {
    await smtp.close();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "todoist-email-complete" });
    }

    if (url.pathname === "/complete") {
      return completeTodoistTask(request, env);
    }

    if (url.pathname === "/send-test") {
      return sendTestEmail(request, env);
    }

    return json(
      {
        ok: true,
        service: "todoist-email-complete",
        endpoints: ["/health", "/complete", "/send-test"],
      },
      200,
    );
  },
};
