import worker from "./index.js";

const nativeJsonParse = JSON.parse.bind(JSON);

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

export default worker;
