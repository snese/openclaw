import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

export type StandardAcpPluginConfig = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type ResolvedStandardAcpConfig = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createStandardAcpConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown) {
      if (value === undefined) return { success: true, data: undefined };
      if (!isRecord(value)) {
        return { success: false, error: { issues: [{ path: [], message: "expected config object" }] } };
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
      },
    },
  };
}

export function resolveStandardAcpConfig(params: {
  rawConfig: unknown;
  workspaceDir?: string;
}): ResolvedStandardAcpConfig {
  const raw = (params.rawConfig ?? {}) as StandardAcpPluginConfig;
  return {
    command: raw.command ?? "kiro-cli",
    args: raw.args ?? ["acp"],
    cwd: raw.cwd ?? params.workspaceDir ?? process.cwd(),
    env: raw.env ?? {},
  };
}
