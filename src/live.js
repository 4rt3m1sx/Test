import worker from "./sync.js";

const OLD_WORKER_URL = "https://test.lmludick.workers.dev";
const PRODUCTION_WORKER_URL = "https://daily-assistant.lmludick.workers.dev";
const LIVE_VERSION = "persistent-status-v4-completed";

function utf8Encode(value) {
  const text = String(value);
  const bytes = [];
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp <= 0x7f) bytes.push(cp);
    else if (cp <= 0x7ff) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function htmlAttrUrl(url) {
  return String(url).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function injectScripts(text) {
  if (!text.includes("<html amp4email>")) return text;
  if (text.includes('custom-element="amp-list"')) return text;
  return text.replace(
    '<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>',
    '<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>\n  <script async custom-element="amp-list" src="https://cdn.ampproject.org/v0/amp-list-0.1.js"></script>\n  <script async custom-template="amp-mustache" src="https://cdn.ampproject.org/v0/amp-mustache-0.2.js"></script>',
  );
}

function injectCss(text) {
  if (!text.includes("<html amp4email>")) return text;
  if (text.includes(".live-task{")) return text;
  const marker = "    .footer{padding:8px 26px 22px;color:#9aa0a6;font-size:11px}\n";
  if (!text.includes(marker)) return text;
  const css = `${marker}    .live-task{position:relative}\n    .task-status-overlay{position:absolute;top:0;left:-5px;z-index:2;width:30px;height:30px}\n    .completed-overlay{display:block;width:30px;height:30px;padding:5px;box-sizing:border-box}\n    .checked-sync{display:inline-block;background:#5f6368;border-color:#5f6368}\n`;
  return text.replace(marker, css);
}

function upgradeTaskForms(text) {
  if (!text.includes("<html amp4email>")) return text;
  if (text.includes('<amp-list class="task-status-overlay"')) return text;

  const pattern = /<form class="task-form indent-(\d)" method="post" action-xhr="([^"]+\/complete)">([\s\S]*?)<\/form>/g;

  return text.replace(pattern, (fullForm, _indent, actionRaw, formBody) => {
    const taskMatch = formBody.match(/<input type="hidden" name="task" value="([^"]+)">/);
    const dueMatch = formBody.match(/<input type="hidden" name="due" value="([^"]+)">/);
    const sigMatch = formBody.match(/<input type="hidden" name="sig" value="([^"]+)">/);
    if (!taskMatch || !dueMatch || !sigMatch) return fullForm;

    const taskId = taskMatch[1];
    const due = dueMatch[1];
    const sig = sigMatch[1];
    const action = actionRaw.replaceAll(OLD_WORKER_URL, PRODUCTION_WORKER_URL);
    const originalForm = fullForm.replace(`action-xhr="${actionRaw}"`, `action-xhr="${action}"`);
    const statusUrl = `${PRODUCTION_WORKER_URL}/task-status?task=${encodeURIComponent(taskId)}&due=${encodeURIComponent(due)}&sig=${encodeURIComponent(sig)}`;

    return `<div class="live-task">\n      ${originalForm}\n      <amp-list class="task-status-overlay" width="30" height="30" layout="fixed" src="${htmlAttrUrl(statusUrl)}" binding="no">\n        <template type="amp-mustache">{{#completed}}<span class="completed-overlay" aria-label="Completed"><span class="box checked-sync">&#10003;</span></span>{{/completed}}</template>\n      </amp-list>\n    </div>`;
  });
}

function transformOutbound(value) {
  let text = String(value).replaceAll(OLD_WORKER_URL, PRODUCTION_WORKER_URL);
  if (!text.includes("<html amp4email>")) return text;

  text = upgradeTaskForms(text);

  if (text.includes('<amp-list class="task-status-overlay"')) {
    text = injectScripts(text);
    text = injectCss(text);
  }
  return text;
}

TextEncoder.prototype.encode = function liveTodoistAmpEncode(value = "") {
  return utf8Encode(transformOutbound(value));
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/live-version") {
      return new Response(LIVE_VERSION, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return worker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, env, ctx);
  },
};
