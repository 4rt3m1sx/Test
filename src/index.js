const ALLOWED_SENDER = "lydialament@gmail.com";
const TODOIST_API = "https://api.todoist.com/api/v1";

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

  // AMP for Email CORS v2 takes precedence when present.
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

  // AMP for Email CORS v1 fallback.
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
    return json(
      { ok: false, message: "POST required" },
      405,
      cors.headers,
    );
  }

  if (!env.TODOIST_TOKEN || !env.EMAIL_ACTION_SECRET) {
    return json(
      { ok: false, message: "Worker secrets are not configured" },
      500,
      cors.headers,
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json(
      { ok: false, message: "Invalid form payload" },
      400,
      cors.headers,
    );
  }

  const taskId = String(form.get("task") || "").trim();
  const expectedDue = String(form.get("due") || "none").trim();
  const actionSecret = String(form.get("key") || "");

  if (actionSecret !== env.EMAIL_ACTION_SECRET) {
    return json(
      { ok: false, message: "Invalid action key" },
      403,
      cors.headers,
    );
  }

  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    return json(
      { ok: false, message: "Invalid Todoist task ID" },
      400,
      cors.headers,
    );
  }

  const authHeaders = {
    Authorization: `Bearer ${env.TODOIST_TOKEN}`,
  };

  // Verify that the email still refers to the same current occurrence.
  const taskResponse = await fetch(
    `${TODOIST_API}/tasks/${encodeURIComponent(taskId)}`,
    { headers: authHeaders },
  );

  if (taskResponse.status === 404) {
    return json(
      { ok: true, state: "already-completed", message: "Already completed" },
      200,
      cors.headers,
    );
  }

  if (!taskResponse.ok) {
    return json(
      { ok: false, message: "Could not verify Todoist task" },
      502,
      cors.headers,
    );
  }

  const task = await taskResponse.json();
  const currentDue = task?.due?.date ? String(task.due.date) : "none";

  // Prevent an old email from completing a later occurrence of a recurring task.
  if (currentDue !== expectedDue) {
    return json(
      {
        ok: false,
        state: "stale",
        message: "This email contains an old occurrence of this task",
      },
      409,
      cors.headers,
    );
  }

  const closeResponse = await fetch(
    `${TODOIST_API}/tasks/${encodeURIComponent(taskId)}/close`,
    {
      method: "POST",
      headers: authHeaders,
    },
  );

  if (!closeResponse.ok) {
    return json(
      { ok: false, message: "Todoist completion failed" },
      502,
      cors.headers,
    );
  }

  return json(
    { ok: true, state: "completed", message: "Completed" },
    200,
    cors.headers,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Simple deployment check that does not expose secrets.
    if (url.pathname === "/health") {
      return json({ ok: true, service: "todoist-email-complete" });
    }

    if (url.pathname === "/complete") {
      return completeTodoistTask(request, env);
    }

    return json(
      {
        ok: true,
        service: "todoist-email-complete",
        endpoints: ["/health", "/complete"],
      },
      200,
    );
  },
};
