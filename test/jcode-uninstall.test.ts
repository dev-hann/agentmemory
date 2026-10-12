import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { escapeTomlString, tomlHookCommand } from "../src/cli/connect/jcode-toml.js";

// uninstallJcode() derives ~/.jcode from homedir() at module scope, so the
// os mock has to be in place (with a throwaway home) before the import.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(actual.tmpdir(), "jcode-uninstall-"));
  return { ...actual, homedir: () => home };
});

const { uninstallJcode } = await import("../src/cli/connect/jcode.ts");

describe("jcode uninstallJcode", () => {
  it("removes TOML hooks and tolerates an unreadable mcp.json", () => {
    const home = homedir();
    const jcodeDir = join(home, ".jcode");
    mkdirSync(jcodeDir, { recursive: true });
    // The exact command uninstallJcode looks for, derived the same way the
    // adapter derives it from PLUGIN_DIR.
    const cmd = tomlHookCommand(
      join(jcodeDir, "plugins", "agentmemory", "agentmemory-bridge.mjs"),
      "post_tool",
    );
    writeFileSync(join(jcodeDir, "config.toml"), `[hooks]\npost_tool = [${escapeTomlString(cmd)}, "user-tool"]\n`);
    writeFileSync(join(jcodeDir, "mcp.json"), "{not json");

    expect(() => uninstallJcode()).not.toThrow();

    const toml = readFileSync(join(jcodeDir, "config.toml"), "utf8");
    expect(toml).toBe('[hooks]\npost_tool = ["user-tool"]\n');
    expect(readFileSync(join(jcodeDir, "mcp.json"), "utf8")).toBe("{not json");

    rmSync(home, { recursive: true, force: true });
  });
});
