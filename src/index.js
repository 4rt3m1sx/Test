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
  <style amp4email-boilerplate>body{visibility:hidden}</style>
  <style amp-custom>
    body {
      margin: 0;
      padding: 0;
      background: #f4f5f7;
      color: #202124;
      font-family: Arial, Helvetica, sans-serif;
    }
    .wrap {
      max-width: 640px;
      margin: 0 auto;
      padding: 28px 16px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e6e8eb;
      border-radius: 14px;
      overflow: hidden;
    }
    .header {
      padding: 24px 26px 18px;
      border-bottom: 1px solid #eceef1;
    }
    .eyebrow {
      margin: 0 0 6px;
      color: #6b7280;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      color: #202124;
      font-size: 24px;
      line-height: 1.25;
    }
    .intro {
      margin: 8px 0 0;
      color: #6b7280;
      font-size: 14px;
      line-height: 1.45;
    }
    .section {
      padding: 22px 26px 26px;
    }
    .section-title {
      margin: 0 0 12px;
      color: #6b7280;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    form {
      margin: 0;
    }
    .task-action,
    .task-done {
      box-sizing: border-box;
      width: 100%;
      min-height: 54px;
      padding: 14px 16px;
      border: 1px solid #e2e5e9;
      border-radius: 10px;
      background: #ffffff;
      color: #202124;
      font-size: 15px;
      line-height: 1.35;
      text-align: left;
    }
    .task-action {
      cursor: pointer;
    }
    .task-action:hover {
      background: #f8f9fa;
    }
    .box {
      display: inline-block;
      box-sizing: border-box;
      width: 20px;
      height: 20px;
      margin-right: 11px;
      border: 2px solid #8a9099;
      border-radius: 5px;
      vertical-align: -4px;
      text-align: center;
      font-size: 14px;
      font-weight: 700;
      line-height: 16px;
    }
    .task-done {
      display: none;
      background: #f7f8f9;
      color: #60656d;
    }
    .task-done .box {
      border-color: #60656d;
      background: #60656d;
      color: #ffffff;
    }
    form.amp-form-submitting .task-action {
      opacity: .55;
    }
    form.amp-form-submit-success .task-action {
      display: none;
    }
    form.amp-form-submit-success .task-done {
      display: block;
    }
    .error {
      margin: 9px 2px 0;
      color: #a33a3a;
      font-size: 12px;
      line-height: 1.4;
    }
    .footer {
      padding: 0 26px 22px;
      color: #8a9099;
      font-size: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="header">
        <p class="eyebrow">Daily Assistant</p>
        <h1>Interactive task test</h1>
        <p class="intro">Complete the task here and it will be completed in Todoist.</p>
      </div>

      <div class="section">
        <p class="section-title">Do today</p>
        <form method="post" action-xhr="${WORKER_BASE_URL}/complete">
          <input type="hidden" name="task" value="${safeTask}">
          <input type="hidden" name="due" value="${safeDue}">
          <input type="hidden" name="key" value="${safeKey}">

          <button type="submit" class="task-action">
            <span class="box"></span>AMP email visual checkbox test
          </button>

          <div submit-success class="task-done">
            <span class="box">&#10003;</span>AMP email visual checkbox test
          </div>

          <div submit-error class="error">Could not complete this task in Todoist. Please try again.</div>
        </form>
      </div>

      <div class="footer">Interactive Todoist completion · no new tab or window</div>
    </div>
  </div>
</body>
</html>`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#202124">
  <div style="max-width:640px;margin:0 auto;padding:28px 16px">
    <div style="background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:26px">
      <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">Daily Assistant</div>
      <h1 style="font-size:24px;margin:6px 0 10px">Interactive task test</h1>
      <p style="color:#6b7280;font-size:14px">The interactive version was not available in this email client.</p>
    </div>
  </div>
</body>
</html>`;

  const plain = "Daily Assistant\r\n\r\nInteractive task test\r\nThe interactive version was not available in this email client.\r\n";

  const parts = [
    `From: Daily Assistant <${ALLOWED_SENDER}>`,
    `To: ${TEST_RECIPIENT}`,
    "Subject: Daily Assistant - interactive task test",
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
