import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import {
  jcodeConfigPath,
  readJcodeMcpJson,
  removeTomlArrayValue,
  upsertTomlArrayValue,
  writeJcodeMcpJson,
} from "./jcode-toml.js";

// jcode wires lifecycle capture through TOML array hooks
// (~/.jcode/config.toml [hooks]) that translate jcode's JCODE_HOOK_* env
// vars into the Claude-style stdin JSON the bundled hooks read. The bridge
// script is a small static shim — no build step — installed into
// ~/.jcode/plugins/agentmemory/.

const JCODE_DIR = join(homedir(), ".jcode");
const PLUGIN_DIR = join(JCODE_DIR, "plugins", "agentmemory");
const BRIDGE_SCRIPT = "agentmemory-bridge.mjs";
const HOOK_KEYS = ["session_start", "session_end", "post_tool", "turn_end"];

const BRIDGE_SOURCE = `#!/usr/bin/env node
// agentmemory jcode bridge — translates jcode lifecycle-hook env vars into
// the Claude-style stdin JSON that the bundled agentmemory hooks read.
// Usage: agentmemory-bridge.mjs <session_start|post_tool|turn_end|session_end>
// Always exits 0: a capture failure must never fail the host's tool call.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EVENT = process.argv[2] ?? "";
const MAPPINGS = {
  session_start: { script: "session-start.mjs", event: "SessionStart" },
  post_tool: { script: "post-tool-use.mjs", event: "PostToolUse", error_script: "post-tool-failure.mjs" },
  turn_end: { script: "stop.mjs", event: "Stop" },
  session_end: { script: "session-end.mjs", event: "SessionEnd" },
};
const map = MAPPINGS[EVENT];
if (!map) process.exit(0);

const env = process.env;
let stdin = "";
if (EVENT === "post_tool") {
  try { stdin = readFileSync(0, "utf8"); } catch {}
}
let toolInput = {};
try { toolInput = JSON.parse(stdin || "{}"); } catch {}

const payload = {
  session_id: env.JCODE_HOOK_SESSION_ID ?? "unknown",
  cwd: env.JCODE_HOOK_CWD ?? process.cwd(),
  hook_event_name: map.event,
  tool_name: env.JCODE_HOOK_TOOL_NAME ?? "",
  tool_input: toolInput,
  // jcode exposes output size only, never the raw output text.
  tool_response: env.JCODE_HOOK_OUTPUT_BYTES
    ? "[" + env.JCODE_HOOK_OUTPUT_BYTES + " bytes output]"
    : "",
  // The Stop hook reads the final assistant text through this field.
  prompt: env.JCODE_HOOK_LAST_ASSISTANT_TEXT ?? "",
};

const script = env.JCODE_HOOK_STATUS === "error" && map.error_script
  ? map.error_script
  : map.script;
const hookPath = join(dirname(fileURLToPath(import.meta.url)), script);

try {
  spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    timeout: 8000,
  });
} catch {}
process.exit(0);
`;

export const adapter: ConnectAdapter = {
  name: "jcode",
  displayName: "jcode",
  docs: "https://github.com/1jehuang/jcode",
  category: "native",
  protocolNote:
    "→ Wiring REST capture via jcode's [hooks] TOML arrays. The MCP entry in ~/.jcode/mcp.json is the opt-in bridge for MCP-only flows.",
  detect(): boolean {
    return existsSync(JCODE_DIR);
  },
  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const configPath = jcodeConfigPath();
    const bridgeCmd = join(PLUGIN_DIR, BRIDGE_SCRIPT);

    // 1) Bridge script — installed before any config references it.
    mkdirSync(dirname(bridgeCmd), { recursive: true });
    if (!existsSync(bridgeCmd)) {
      writeFileSync(bridgeCmd, BRIDGE_SOURCE);
      chmodSync(bridgeCmd, 0o755);
    }

    // 2) MCP registration — merge, never clobber other servers.
    const mcp = readJcodeMcpJson();
    const servers = (mcp.mcpServers as Record<string, unknown>) ?? {};
    const existing = servers.agentmemory;
    if (
      !existing ||
      (typeof existing === "object" &&
        JSON.stringify(existing) !==
          JSON.stringify({ command: "agentmemory-mcp", timeout_secs: 60 }))
    ) {
      servers.agentmemory = servers.agentmemory ?? {
        command: "agentmemory-mcp",
        timeout_secs: 60,
      };
      mcp.mcpServers = servers;
      writeJcodeMcpJson(mcp);
    }

    // 3) TOML hooks — append to arrays, preserve everything else.
    let mutated = false;
    for (const key of HOOK_KEYS) {
      if (
        upsertTomlArrayValue(configPath, "hooks", key, bridgeCmd) === "written"
      ) {
        mutated = true;
      }
    }

    if (opts.dryRun) {
      p.log.info(`[dry run] would wire ${HOOK_KEYS.join(", ")} in ${configPath}`);
      return { kind: "skipped", reason: "dry run" };
    }

    if (!mutated && existsSync(bridgeCmd)) {
      return { kind: "already-wired", mutatedPath: configPath };
    }
    return { kind: "installed", mutatedPath: configPath };
  },
};

// Uninstall is handled by jcode-toml.removeTomlArrayValue for each key plus
// mcp.json/mcpServers.agentmemory removal — kept out of the adapter so
// `connect` stays single-purpose (upstream convention: adapters install).
export function uninstallJcode(): void {
  const bridgeCmd = join(PLUGIN_DIR, BRIDGE_SCRIPT);
  for (const key of HOOK_KEYS) {
    removeTomlArrayValue(jcodeConfigPath(), "hooks", key, bridgeCmd);
  }
  const mcp = readJcodeMcpJson();
  const servers = (mcp.mcpServers as Record<string, unknown>) ?? {};
  if (servers.agentmemory !== undefined) {
    delete servers.agentmemory;
    writeJcodeMcpJson(mcp);
  }
}
