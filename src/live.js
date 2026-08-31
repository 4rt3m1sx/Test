import worker from "./sync.js";

const OLD_WORKER_URL = "https://test.lmludick.workers.dev";
const PRODUCTION_WORKER_URL = "https://daily-assistant.lmludick.workers.dev";

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
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function htmlAttrUrl(url) {
  return String(url).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function injectScripts(text) {
  if (!text.includes("<html amp4email>")) return text;
  return text.replace(
    '<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>',
    '<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"></script>\n  <script async custom-element="amp-list" src="https://cdn.ampproject.org/v0/amp-list-0.1.js"></script>\n  <script async custom-template="amp-mustache" src="https://cdn.ampproject.org/v0/amp-mustache-0.2.js"></script>',
  );
}

function injectCss(text) {
  if (!text.includes("<html amp4email>")) return text;
  const marker = "    .footer{padding:8px 26px 22px;color:#9aa0a6;font-size:11px}\n";
  if (!text.includes(marker)) return text;
  const css = `${marker}    .task-status-list{flex:0 0 30px;width:30px;height:30px;margin:0 5px 0 -5px}\n    .task-status-list .check{margin:0;padding:5px}\n    .checked-sync{display:inline-block;background:#5f6368;border-color:#5f6368}\n    .sync-loading{display:inline-block;width:30px;text-align:center;padding-top:4px;color:#9aa0a6;font-size:14px}\n    .sync-submit-form{height:0;overflow:hidden;margin:0;padding:0}\n    .sync-submit-form .task-error{margin:0}\n`;
  return text.replace(marker, css);
}

function upgradeTaskForms(text) {
  if (!text.includes("<html amp4email>")) return text;

  const pattern = /<form class="task-form indent-(\d)" method="post" action-xhr="([^"]+\/complete)">\s*<input type="hidden" name="task" value="([^"]+)">\s*<input type="hidden" name="due" value="([^"]+)">\s*<input type="hidden" name="sig" value="([^"]+)">\s*<div class="task-row">\s*<button class="check" type="submit" aria-label="([^"]*)">[\s\S]*?<\/button>\s*(<div class="task-copy">[\s\S]*?<\/div>)\s*<\/div>\s*<div submit-success class="success-marker"><\/div>\s*<div submit-error class="task-error">Could not complete this task in Todoist\.<\/div>\s*<\/form>/g;

  return text.replace(pattern, (_m, indent, actionRaw, taskId, due, sig, ariaLabel, taskCopy) => {
    const action = actionRaw.replaceAll(OLD_WORKER_URL, PRODUCTION_WORKER_URL);
    const formId = `complete-${taskId}`;
    const listId = `task-status-${taskId}`;
    const statusUrl = `${PRODUCTION_WORKER_URL}/task-status?task=${encodeURIComponent(taskId)}&due=${encodeURIComponent(due)}&sig=${encodeURIComponent(sig)}`;

    return `<div class="task-form indent-${indent}">\n      <form id="${formId}" class="sync-submit-form" method="post" action-xhr="${action}" on="submit-success:${listId}.refresh">\n        <input type="hidden" name="task" value="${taskId}">\n        <input type="hidden" name="due" value="${due}">\n        <input type="hidden" name="sig" value="${sig}">\n        <div submit-success class="success-marker"></div>\n        <div submit-error class="task-error">Could not complete this task in Todoist.</div>\n      </form>\n      <div class="task-row">\n        <amp-list id="${listId}" class="task-status-list" width="30" height="30" layout="fixed" src="${htmlAttrUrl(statusUrl)}" binding="no">\n          <template type="amp-mustache">\n            {{#open}}<button class="check" type="button" on="tap:${formId}.submit" aria-label="${ariaLabel}"><span class="box unchecked"></span></button>{{/open}}\n            {{#completed}}<span class="check" aria-label="Completed"><span class="box checked-sync">&#10003;</span></span>{{/completed}}\n          </template>\n          <div placeholder class="sync-loading">…</div>\n          <div fallback class="sync-loading">!</div>\n        </amp-list>\n        ${taskCopy}\n      </div>\n    </div>`;
  });
}

function transformOutbound(value) {
  let text = String(value).replaceAll(OLD_WORKER_URL, PRODUCTION_WORKER_URL);
  if (!text.includes("<html amp4email>")) return text;
  text = injectScripts(text);
  text = injectCss(text);
  text = upgradeTaskForms(text);
  return text;
}

TextEncoder.prototype.encode = function liveTodoistAmpEncode(value = "") {
  return utf8Encode(transformOutbound(value));
};

export default worker;
