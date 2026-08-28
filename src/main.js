import worker from "./index.js";

const OLD_WORKER_URL = "https://test.lmludick.workers.dev";
const PRODUCTION_WORKER_URL = "https://daily-assistant.lmludick.workers.dev";

const nativeJsonParse = JSON.parse.bind(JSON);
const nativeTextEncode = TextEncoder.prototype.encode;

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

TextEncoder.prototype.encode = function productionUrlTextEncode(value = "") {
  const text = String(value).replaceAll(OLD_WORKER_URL, PRODUCTION_WORKER_URL);
  return nativeTextEncode.call(this, text);
};

export default worker;
