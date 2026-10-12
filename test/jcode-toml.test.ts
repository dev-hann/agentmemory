import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  escapeTomlString,
  removeTomlArrayValue,
  tomlHookCommand,
  upsertTomlArrayValue,
} from "../src/cli/connect/jcode-toml.js";

let dir: string;
let configPath: string;

function setup(initial: string): string {
  dir = mkdtempSync(join(tmpdir(), "jcode-toml-"));
  configPath = join(dir, "config.toml");
  if (initial) writeFileSync(configPath, initial);
  return configPath;
}

describe("jcode-toml upsertTomlArrayValue", () => {
  it("merges into a multiline array preserving existing entries", () => {
    const p = setup(
      [
        "# top comment",
        "[provider]",
        'model = "x"',
        "",
        "[hooks]",
        "post_tool = [",
        '  "other-tool --watch",',
        '  "keeper",',
        "]",
        "turn_end = []",
        "",
        "[display]",
        "theme = \"dark\"",
      ].join("\n"),
    );
    const cmd = tomlHookCommand("/home/u/.jcode/plugins/agentmemory/agentmemory-bridge.mjs", "post_tool");
    expect(upsertTomlArrayValue(p, "hooks", "post_tool", cmd)).toBe("written");
    const out = readFileSync(p, "utf8");
    expect(out).toContain('"other-tool --watch"');
    expect(out).toContain('"keeper"');
    expect(out).toContain(escapeTomlString(cmd));
    expect(out).toContain('theme = "dark"');
    expect(out).toMatch(/\[display\]/);
    // single physical array line for the merged key, no leftover brackets
    const line = out.split("\n").find((l) => l.startsWith("post_tool"));
    expect(line).toBe(`post_tool = ["other-tool --watch", "keeper", ${escapeTomlString(cmd)}]`);
  });

  it("is idempotent on re-run", () => {
    const p = setup("[hooks]\npost_tool = []\n");
    const cmd = tomlHookCommand("/bridge.mjs", "post_tool");
    expect(upsertTomlArrayValue(p, "hooks", "post_tool", cmd)).toBe("written");
    const once = readFileSync(p, "utf8");
    expect(upsertTomlArrayValue(p, "hooks", "post_tool", cmd)).toBe("skipped");
    expect(readFileSync(p, "utf8")).toBe(once);
  });

  it("promotes a scalar preserving the original entry", () => {
    const p = setup("[hooks]\nsession_start = \"legacy-hook\"\n");
    const cmd = tomlHookCommand("/bridge.mjs", "session_start");
    upsertTomlArrayValue(p, "hooks", "session_start", cmd);
    const line = readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("session_start"));
    expect(line).toBe(`session_start = ["legacy-hook", ${escapeTomlString(cmd)}]`);
  });

  it("creates the section and key when absent, after the header", () => {
    const p = setup("[provider]\nmodel = \"x\"\n");
    const cmd = tomlHookCommand("/bridge.mjs", "turn_end");
    upsertTomlArrayValue(p, "hooks", "turn_end", cmd);
    const out = readFileSync(p, "utf8");
    const hooksIdx = out.indexOf("[hooks]");
    const keyIdx = out.indexOf("turn_end =");
    expect(hooksIdx).toBeGreaterThan(-1);
    expect(keyIdx).toBeGreaterThan(hooksIdx);
  });

  it("preserves a trailing comment after the value", () => {
    const p = setup("[hooks]\npost_tool = [\"a\"] # mine\n");
    upsertTomlArrayValue(p, "hooks", "post_tool", tomlHookCommand("/bridge.mjs", "post_tool"));
    expect(readFileSync(p, "utf8")).toContain("# mine");
  });

  it("keeps commas and brackets inside quoted commands intact", () => {
    const p = setup("[hooks]\n");
    const cmd = 'run --flag "a,b]c" other';
    upsertTomlArrayValue(p, "hooks", "post_tool", cmd);
    expect(upsertTomlArrayValue(p, "hooks", "post_tool", cmd)).toBe("skipped");
    const line = readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("post_tool"));
    expect(line).toBe(`post_tool = [${escapeTomlString(cmd)}]`);
  });

  it("escapes backslashes and quotes on write and reads them back", () => {
    const p = setup("[hooks]\n");
    const cmd = String.raw`node "C:\tools\bridge.mjs" post_tool`;
    upsertTomlArrayValue(p, "hooks", "post_tool", cmd);
    const line = readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("post_tool"));
    expect(line).toBe('post_tool = ["node \\"C:\\\\tools\\\\bridge.mjs\\" post_tool"]');
    expect(upsertTomlArrayValue(p, "hooks", "post_tool", cmd)).toBe("skipped");
  });

  it("parses comments inside multiline arrays", () => {
    const p = setup(["[hooks]", "post_tool = [", '  "a", # first', '  "b", # second', "]", ""].join("\n"));
    upsertTomlArrayValue(p, "hooks", "post_tool", tomlHookCommand("/bridge.mjs", "post_tool"));
    const line = readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("post_tool"));
    expect(line).toContain('"a"');
    expect(line).toContain('"b"');
  });

  it("throws without writing when the array is unterminated", () => {
    const p = setup("[hooks]\npost_tool = [\n  \"a\",\n");
    const before = readFileSync(p, "utf8");
    expect(() => upsertTomlArrayValue(p, "hooks", "post_tool", "x")).toThrow();
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("only touches the named key, not longer keys sharing a prefix", () => {
    const p = setup("[hooks]\npost_tool_extra = [\"keep\"]\n");
    upsertTomlArrayValue(p, "hooks", "post_tool", tomlHookCommand("/bridge.mjs", "post_tool"));
    const out = readFileSync(p, "utf8");
    expect(out).toContain('post_tool_extra = ["keep"]');
    expect(out.split("\n").filter((l) => l.includes("post_tool")).length).toBe(2);
  });
});

describe("jcode-toml removeTomlArrayValue", () => {
  it("strips only our command from a multiline array", () => {
    const p = setup(
      ["[hooks]", "post_tool = [", '  "other-tool --watch",', `  ${escapeTomlString(tomlHookCommand("/bridge.mjs", "post_tool"))},`, "]", ""].join("\n"),
    );
    removeTomlArrayValue(p, "hooks", "post_tool", tomlHookCommand("/bridge.mjs", "post_tool"));
    expect(readFileSync(p, "utf8")).toBe('[hooks]\npost_tool = ["other-tool --watch"]\n');
  });

  it("deletes the key when removing our last entry", () => {
    const cmd = tomlHookCommand("/bridge.mjs", "post_tool");
    const p = setup(`[hooks]\npost_tool = [${escapeTomlString(cmd)}]\n`);
    removeTomlArrayValue(p, "hooks", "post_tool", cmd);
    expect(readFileSync(p, "utf8")).toBe("[hooks]\n");
  });

  it("leaves an empty array untouched when our command is absent", () => {
    const p = setup("[hooks]\npost_tool = []\n");
    removeTomlArrayValue(p, "hooks", "post_tool", tomlHookCommand("/bridge.mjs", "post_tool"));
    expect(readFileSync(p, "utf8")).toBe("[hooks]\npost_tool = []\n");
  });

  it("leaves other keys and sections untouched", () => {
    const cmd = tomlHookCommand("/bridge.mjs", "turn_end");
    const p = setup(`[hooks]\nturn_end = [${escapeTomlString(cmd)}]\nsession_start = "keep"\n\n[display]\ntheme = "dark"\n`);
    removeTomlArrayValue(p, "hooks", "turn_end", cmd);
    const out = readFileSync(p, "utf8");
    expect(out).toContain('session_start = "keep"');
    expect(out).toContain('theme = "dark"');
    expect(out).not.toContain("turn_end =");
  });

  it("removes entries written with escaped paths", () => {
    const cmd = String.raw`node "C:\tools\bridge.mjs" post_tool`;
    const p = setup("[hooks]\n");
    upsertTomlArrayValue(p, "hooks", "post_tool", cmd);
    removeTomlArrayValue(p, "hooks", "post_tool", cmd);
    expect(readFileSync(p, "utf8")).toBe("[hooks]\n");
  });
});

describe("jcode-toml tomlHookCommand", () => {
  it("runs the bridge through node with a quoted path", () => {
    expect(tomlHookCommand("/home/u/.jcode/plugins/agentmemory/agentmemory-bridge.mjs", "post_tool")).toBe(
      'node "/home/u/.jcode/plugins/agentmemory/agentmemory-bridge.mjs" post_tool',
    );
    expect(tomlHookCommand("/opt/my tools/bridge.mjs", "session_start")).toBe(
      'node "/opt/my tools/bridge.mjs" session_start',
    );
  });
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
