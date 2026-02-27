import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  PluginLogger,
} from "openclaw/plugin-sdk";
import { AcpRuntimeError } from "openclaw/plugin-sdk";
import type { ResolvedStandardAcpConfig } from "./config.js";

export const STANDARD_ACP_BACKEND_ID = "acp-standard";

/** Timeout for control-plane requests (initialize, session/new, etc.). */
const CONTROL_TIMEOUT_MS = 30_000;

/** Methods that are expected to return quickly. */
const CONTROL_METHODS = new Set([
  "initialize",
  "session/new",
  "session/cancel",
  "session/set_mode",
]);

type AgentProcess = {
  child: ChildProcess;
  sessionId: string | null;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  notifications: ((event: AcpRuntimeEvent) => void) | null;
};

const CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/set_mode"],
};

export class StandardAcpRuntime implements AcpRuntime {
  private healthy = false;
  private agents = new Map<string, AgentProcess>();

  constructor(
    private readonly config: ResolvedStandardAcpConfig,
    private readonly logger?: PluginLogger,
  ) {}

  isHealthy(): boolean {
    return this.healthy;
  }

  async probeAvailability(): Promise<void> {
    try {
      const child = spawn(this.config.command, ["--help"], {
        cwd: this.config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const code = await new Promise<number>((resolve) => {
        child.on("close", (c) => resolve(c ?? 1));
        child.on("error", () => resolve(1));
      });
      this.healthy = code === 0;
    } catch {
      this.healthy = false;
    }
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const key = input.sessionKey;
    let agent = this.agents.get(key);

    if (!agent) {
      agent = this.spawnAgent(key);
      this.agents.set(key, agent);

      await this.sendRequest(agent, "initialize", {
        clientInfo: { name: "openclaw", version: "1.0.0" },
      });

      const sessionResult = (await this.sendRequest(agent, "session/new", {})) as Record<
        string,
        unknown
      >;
      agent.sessionId = (sessionResult?.id as string) ?? key;
    }

    return {
      sessionKey: key,
      backend: STANDARD_ACP_BACKEND_ID,
      runtimeSessionName: agent.sessionId ?? key,
      cwd: input.cwd ?? this.config.cwd,
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const agent = this.agents.get(input.handle.sessionKey);
    if (!agent) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "No agent process for session.");
    }

    const events: AcpRuntimeEvent[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    agent.notifications = (event) => {
      events.push(event);
      resolveWait?.();
    };

    // Push error event on unexpected process exit so the loop never hangs.
    const onClose = () => {
      if (!done) {
        events.push({ type: "error", message: "agent process exited unexpectedly" });
        resolveWait?.();
      }
    };
    agent.child.on("close", onClose);

    const promptPromise = this.sendRequest(agent, "session/prompt", {
      sessionId: agent.sessionId,
      messages: [{ role: "user", content: { type: "text", text: input.text } }],
    });

    const onAbort = () => {
      void this.cancel({ handle: input.handle });
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!done) {
        if (events.length > 0) {
          const event = events.shift()!;
          yield event;
          if (event.type === "done" || event.type === "error") {
            done = true;
          }
        } else {
          await new Promise<void>((r) => {
            resolveWait = r;
          });
        }
      }
      await promptPromise.catch(() => {});
    } finally {
      agent.notifications = null;
      agent.child.removeListener("close", onClose);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return CAPABILITIES;
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
    const agent = this.agents.get(input.handle.sessionKey);
    return {
      summary: agent ? `running, sessionId=${agent.sessionId}` : "no process",
    };
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    const agent = this.agents.get(input.handle.sessionKey);
    if (!agent) return;
    await this.sendRequest(agent, "session/set_mode", {
      sessionId: agent.sessionId,
      mode: input.mode,
    });
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    try {
      await this.probeAvailability();
      return this.healthy
        ? { ok: true, message: `${this.config.command} available` }
        : {
            ok: false,
            code: "ACP_BACKEND_UNAVAILABLE",
            message: `${this.config.command} not responding`,
          };
    } catch (err) {
      return { ok: false, code: "ACP_BACKEND_UNAVAILABLE", message: String(err) };
    }
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const agent = this.agents.get(input.handle.sessionKey);
    if (!agent) return;
    await this.sendRequest(agent, "session/cancel", {
      sessionId: agent.sessionId,
    }).catch(() => {});
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const agent = this.agents.get(input.handle.sessionKey);
    if (!agent) return;
    agent.child.kill("SIGTERM");
    this.agents.delete(input.handle.sessionKey);
  }

  // --- JSON-RPC 2.0 transport ---

  private spawnAgent(key: string): AgentProcess {
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    });

    const agent: AgentProcess = {
      child,
      sessionId: null,
      nextId: 1,
      pending: new Map(),
      notifications: null,
    };

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;

        if ("id" in msg && msg.id != null) {
          const id = msg.id as number;
          const p = agent.pending.get(id);
          if (p) {
            agent.pending.delete(id);
            if ("error" in msg) {
              p.reject(new Error(JSON.stringify(msg.error)));
            } else {
              p.resolve(msg.result);
            }
          }
          return;
        }

        if ("method" in msg && msg.method === "session/update") {
          const params = msg.params as Record<string, unknown> | undefined;
          if (!params) return;
          const event = this.mapNotificationToEvent(params);
          if (event) agent.notifications?.(event);
        }
      } catch {
        // ignore malformed lines
      }
    });

    child.stderr.on("data", (chunk) => {
      this.logger?.warn?.(`[acp-standard:${key}] stderr: ${String(chunk).trim()}`);
    });

    child.on("close", () => {
      for (const p of agent.pending.values()) {
        p.reject(new Error("agent process exited"));
      }
      agent.pending.clear();
      this.agents.delete(key);
    });

    return agent;
  }

  private sendRequest(agent: AgentProcess, method: string, params: unknown): Promise<unknown> {
    const id = agent.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeoutMs = CONTROL_METHODS.has(method) ? CONTROL_TIMEOUT_MS : undefined;

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs) {
        timer = setTimeout(() => {
          agent.pending.delete(id);
          reject(new Error(`JSON-RPC request timed out: ${method}`));
        }, timeoutMs);
      }

      agent.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });

      agent.child.stdin.write(msg + "\n", (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          agent.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private mapNotificationToEvent(params: Record<string, unknown>): AcpRuntimeEvent | null {
    const type = params.type as string | undefined;
    switch (type) {
      case "AgentMessageChunk":
        return { type: "text_delta", text: (params.delta as string) ?? "", stream: "output" };
      case "ToolCall":
        return { type: "tool_call", text: (params.name as string) ?? "tool" };
      case "ToolCallUpdate":
        return { type: "status", text: `tool: ${(params.name as string) ?? ""}` };
      case "TurnEnd":
        return { type: "done", stopReason: (params.stopReason as string) ?? "end_turn" };
      default:
        return null;
    }
  }
}
