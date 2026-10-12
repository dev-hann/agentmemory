import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeTextAtomic } from "./util.js";

// jcode's [hooks] section keys are TOML arrays of command strings. Other
// keys in the file (provider config, display prefs, …) must survive any
// edit byte-for-byte where possible, so we splice only the lines we own.

export interface TomlHookPlan {
  key: string;
  command: string;
}

function readConfig(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function sectionBounds(src: string, section: string): { start: number; end: number } | null {
  const headerRe = new RegExp(`^\\[${section}\\]\\s*$`, "m");
  const matches = [...src.matchAll(new RegExp(headerRe.source, "gm"))];
  if (matches.length === 0) return null;
  const start = matches[matches.length - 1].index;
  const rest = src.slice(start + 1);
  const nxt = rest.match(/^\[/m);
  const end = nxt ? start + 1 + (nxt.index ?? rest.length) : src.length;
  return { start, end };
}

const BASIC_UNESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

/** Serialize as a TOML basic string; symmetric with unescapeTomlString. */
export function escapeTomlString(v: string): string {
  let out = "";
  for (const ch of v) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        continue;
      case '"':
        out += '\\"';
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\r":
        out += "\\r";
        continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else if (cp > 0xffff) {
      out += `\\U${cp.toString(16).padStart(8, "0")}`;
    } else {
      out += ch;
    }
  }
  return `"${out}"`;
}

function unescapeTomlString(v: string): string {
  return v.replace(
    /\\(b|t|n|f|r|"|\\|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g,
    (m, g: string) => {
      const c = g[0]!;
      if (c === "u" || c === "U") {
        return String.fromCodePoint(parseInt(g.slice(1), 16));
      }
      return BASIC_UNESCAPES[g] ?? m;
    },
  );
}

/** The exact command string installed for a hook key; uninstall matches it. */
export function tomlHookCommand(bridgePath: string, key: string): string {
  return `node "${bridgePath}" ${key}`;
}

/**
 * Index just past the TOML value that starts at or after pos. Values may
 * span lines (arrays), contain quoted "]" and "," characters, and carry
 * comments; a value that cannot be scanned to its end throws so callers
 * never write a half-parsed file.
 */
function scanValueEnd(src: string, pos: number): number {
  let i = pos;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
    throw new Error("agentmemory: multiline TOML strings are not supported in [hooks]");
  }
  if (src[i] === '"') return scanBasicString(src, i);
  if (src[i] === "'") return scanLiteralString(src, i);
  if (src[i] === "[") return scanArray(src, i);
  const nl = src.indexOf("\n", i);
  const lineEnd = nl === -1 ? src.length : nl;
  const hash = src.indexOf("#", i);
  return hash !== -1 && hash < lineEnd ? src.slice(0, hash).replace(/\s+$/, "").length : lineEnd;
}

function scanBasicString(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === '"') return i + 1;
    if (src[i] === "\n") break;
    i++;
  }
  throw new Error("agentmemory: unterminated TOML string in [hooks]");
}

function scanLiteralString(src: string, start: number): number {
  const end = src.indexOf("'", start + 1);
  const nl = src.indexOf("\n", start);
  if (end === -1 || (nl !== -1 && nl < end)) {
    throw new Error("agentmemory: unterminated TOML literal string in [hooks]");
  }
  return end + 1;
}

function scanArray(src: string, start: number): number {
  let depth = 0;
  let i = start;
  let quote: '"' | "'" | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote === '"') {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') quote = null;
      i++;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      if (src.startsWith(c === '"' ? '"""' : "'''", i)) {
        throw new Error("agentmemory: multiline TOML strings are not supported in [hooks]");
      }
      quote = c as '"' | "'";
      i++;
      continue;
    }
    if (c === "#") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) throw new Error("agentmemory: unterminated comment in TOML array");
      i = nl + 1;
      continue;
    }
    if (c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "]") {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  throw new Error("agentmemory: unterminated TOML array in [hooks]");
}

/** Full value span for `key =` anywhere in text; null when the key is absent. */
function findKeySpan(text: string, key: string): { start: number; end: number; raw: string } | null {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const valueEnd = scanValueEnd(text, m.index + m[0].length);
  return { start: m.index, end: valueEnd, raw: text.slice(m.index + m[0].length, valueEnd) };
}

/** Unquote a TOML scalar: literal strings strip only, basic strings unescape. */
function unquoteTomlScalar(p: string): string {
  if (p.length >= 2 && p.startsWith("'") && p.endsWith("'")) return p.slice(1, -1);
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) return unescapeTomlString(p.slice(1, -1));
  return p;
}

/** Split an array literal's inner text on commas outside quotes, dropping comments. */
function splitTomlArray(raw: string): string[] {
  const inner = raw.slice(1, -1);
  const parts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (quote === '"') {
      cur += c;
      if (c === "\\" && i + 1 < inner.length) {
        cur += inner[i + 1]!;
        i += 2;
        continue;
      }
      if (c === '"') quote = null;
      i++;
      continue;
    }
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      if (inner.startsWith(c === '"' ? '"""' : "'''", i)) {
        throw new Error("agentmemory: multiline TOML strings are not supported in [hooks]");
      }
      quote = c as '"' | "'";
      cur += c;
      i++;
      continue;
    }
    if (c === "#") {
      const nl = inner.indexOf("\n", i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (c === ",") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map(unquoteTomlScalar);
}

/** Parse a complete TOML value: array (any layout) or scalar. */
function parseTomlValue(raw: string): string[] {
  const cur = raw.trim();
  if (cur.startsWith("[")) return splitTomlArray(cur);
  return [unquoteTomlScalar(cur)];
}

/** Read-only check used for backup decisions and post-write verification. */
export function tomlArrayContains(
  configPath: string,
  section: string,
  key: string,
  value: string,
): boolean {
  const src = readConfig(configPath);
  const bounds = sectionBounds(src, section);
  if (!bounds) return false;
  const body = src.slice(bounds.start, bounds.end);
  const span = findKeySpan(body, key);
  if (!span) return false;
  return parseTomlValue(span.raw).includes(value);
}

/**
 * Ensure `[section] key` exists and its array contains command. Returns
 * "written" when the file changed, "skipped" when command is already
 * present under this key. Scalar values are promoted to arrays with the
 * original entry preserved first. Multiline array values are parsed in
 * full (bracket-balanced), and a newly created key lands immediately
 * after the section header — never before it.
 */
export function upsertTomlArrayValue(
  configPath: string,
  section: string,
  key: string,
  command: string,
): "written" | "skipped" {
  const src = readConfig(configPath);
  const bounds = sectionBounds(src, section);

  let head: string;
  let body: string;
  let tail: string;
  if (bounds) {
    head = src.slice(0, bounds.start);
    body = src.slice(bounds.start, bounds.end);
    tail = src.slice(bounds.end);
  } else {
    head = src.length > 0 && !src.endsWith("\n") ? src + "\n" : src;
    body = "";
    tail = "";
  }

  // Header offset within body (0 when we just created the section): new
  // keys must land after it, not before it.
  const headerMatch = body.match(/^\[[^\]]+\]\s*\n/);
  const headerLen = headerMatch ? headerMatch[0].length : 0;
  const afterHeader = body.slice(headerLen);

  const span = findKeySpan(afterHeader, key);
  if (span) {
    const values = parseTomlValue(span.raw);
    if (values.includes(command)) return "skipped";
    const joined = values.concat(command).map((v) => escapeTomlString(v)).join(", ");
    const newAfter =
      afterHeader.slice(0, span.start) + `${key} = [${joined}]` + afterHeader.slice(span.end);
    writeTextAtomic(configPath, head + body.slice(0, headerLen) + newAfter + tail);
    return "written";
  }

  const newAfter = `${key} = [${escapeTomlString(command)}]\n` + afterHeader;
  const out = bounds
    ? head + body.slice(0, headerLen) + newAfter + tail
    : head + `[${section}]\n` + newAfter;
  writeTextAtomic(configPath, out);
  return "written";
}

/** Remove only entries whose array contains command; deletes empty keys. */
export function removeTomlArrayValue(
  configPath: string,
  section: string,
  key: string,
  command: string,
): void {
  if (!existsSync(configPath)) return;
  const src = readFileSync(configPath, "utf8");
  const bounds = sectionBounds(src, section);
  if (!bounds) return;
  const body = src.slice(bounds.start, bounds.end);
  const span = findKeySpan(body, key);
  if (!span) return;
  const parsed = parseTomlValue(span.raw);
  if (!parsed.includes(command)) return;
  const values = parsed.filter((v) => v !== command);

  let replacement = "";
  if (values.length > 0) {
    replacement = `${key} = [${values.map((v) => escapeTomlString(v)).join(", ")}]`;
  }
  const rest = body.slice(span.end);
  const lineRemainder = rest.match(/^[ \t]*(#[^\n]*)?(?:\n|$)/);
  const skipLen = replacement === "" && lineRemainder ? lineRemainder[0].length : 0;
  let newBody = body.slice(0, span.start) + replacement + rest.slice(skipLen);
  newBody = newBody.replace(/\n{3,}/g, "\n\n");
  writeTextAtomic(configPath, src.slice(0, bounds.start) + newBody + src.slice(bounds.end));
}

/** Read the user's existing mcp.json, or an empty wrapper object. */
export function readJcodeMcpJson(jcodeDir = join(homedir(), ".jcode")): Record<string, unknown> {
  const p = join(jcodeDir, "mcp.json");
  if (!existsSync(p)) return { mcpServers: {} };
  // Malformed JSON throws to the caller: overwriting an unreadable file
  // with a fresh wrapper would silently delete the user's other servers.
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  return parsed && typeof parsed === "object" ? parsed : { mcpServers: {} };
}

export function writeJcodeMcpJson(
  data: unknown,
  jcodeDir = join(homedir(), ".jcode"),
): void {
  writeTextAtomic(join(jcodeDir, "mcp.json"), JSON.stringify(data, null, 2) + "\n");
}

export function jcodeConfigPath(jcodeDir = join(homedir(), ".jcode")): string {
  return join(jcodeDir, "config.toml");
}
