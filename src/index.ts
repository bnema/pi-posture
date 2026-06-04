import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type ContextDecision = "inherit" | "suppress";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ContextPolicy = {
  global?: ContextDecision;
  project?: ContextDecision;
};

type Posture = {
  id: string;
  label: string;
  description: string;
  promptOverlay?: string;
  contextPolicy?: ContextPolicy;
  activeTools?: string[];
  thinking?: ThinkingLevel;
};

type PostureConfig = {
  postures?: Record<string, Partial<Posture>>;
  aliases?: Record<string, string>;
};

type ContextFilterReport = {
  kept: string[];
  suppressed: string[];
};

type RuntimeState = {
  activePostureId: string;
  postures: Map<string, Posture>;
  aliases: Map<string, string>;
  configErrors: string[];
  contextFilterReport?: ContextFilterReport;
  toolSnapshot?: string[];
  appliedToolsOverride?: string[];
  thinkingSnapshot?: ThinkingLevel;
  appliedThinkingOverride?: ThinkingLevel;
};

const STATUS_KEY = "pi-posture";
const MESSAGE_TYPE = "pi-posture";

const BUILTIN_POSTURES: Posture[] = [
  {
    id: "default",
    label: "Default",
    description: "Plugin-off behavior. Pi runs normally with no posture overlay.",
  },
  {
    id: "agent",
    label: "Agent",
    description: "Autonomous implementation posture for when the user wants Pi to take the wheel.",
    promptOverlay: `You are in agent posture.

The user explicitly wants delegated agentic execution. Move work forward with concise planning, code changes, command execution, and verification when appropriate. Keep the user informed, but do not stall on unnecessary permission checks. Continue to respect all higher-priority user, project, and safety instructions.`,
  },
  {
    id: "assist",
    label: "Assist",
    description: "Human-led pair-programming posture. The user keeps implementation ownership.",
    promptOverlay: `You are in assist posture.

The user remains the primary implementer. Use tools freely to inspect code, fetch docs, run verification, and explain local context. Give the next small step, highlight trade-offs and risks, and offer narrow help. Do not take over core implementation or make broad edits unless the user explicitly asks you to do so.`,
  },
  {
    id: "learn",
    label: "Learn",
    description: "Tutor posture for learning while still using the full toolset for accurate guidance.",
    promptOverlay: `You are in learn posture.

Your goal is to help the user understand and practice, not to replace them. Use tools freely to inspect code, fetch official/up-to-date documentation, search examples, and run verification so your teaching is grounded. Prefer concepts, mental models, short questions, hints, micro-exercises, and the next small step. Do not rush to deliver a complete implementation or patch unless the user explicitly asks for it. If code changes are needed, first explain what to change and why.`,
  },
  {
    id: "review",
    label: "Review",
    description: "Critique-oriented posture for inspecting work and explaining risks before edits.",
    promptOverlay: `You are in review posture.

Focus on understanding, critique, correctness, maintainability, reuse, security, and verification. Use tools freely to inspect the repository and run checks. Prefer findings, evidence, and suggested fixes over direct edits. Do not modify files unless the user explicitly asks you to apply a fix.`,
  },
];

const BUILTIN_ALIASES: Record<string, string> = {
  off: "default",
  reset: "default",
  vanilla: "default",
  teacher: "learn",
  tutor: "learn",
  study: "learn",
  pair: "assist",
  autonomous: "agent",
  execute: "agent",
};

const state: RuntimeState = {
  activePostureId: "default",
  postures: new Map(),
  aliases: new Map(),
  configErrors: [],
};

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function resetRegistry() {
  state.postures = new Map(BUILTIN_POSTURES.map((posture) => [posture.id, posture]));
  state.aliases = new Map(Object.entries(BUILTIN_ALIASES));
  state.configErrors = [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addConfigError(message: string) {
  if (!state.configErrors.includes(message)) state.configErrors.push(message);
}

function readConfig(path: string): PostureConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("root must be an object");
    return parsed as PostureConfig;
  } catch (error) {
    addConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function validateContextDecision(value: unknown): value is ContextDecision {
  return value === "inherit" || value === "suppress";
}

function validateThinking(value: unknown): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

function normalizeContextPolicy(value: unknown, source: string): ContextPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addConfigError(`${source}.contextPolicy: must be an object`);
    return undefined;
  }
  const policy: ContextPolicy = {};
  if (value.global !== undefined) {
    if (validateContextDecision(value.global)) policy.global = value.global;
    else addConfigError(`${source}.contextPolicy.global: expected inherit or suppress`);
  }
  if (value.project !== undefined) {
    if (validateContextDecision(value.project)) policy.project = value.project;
    else addConfigError(`${source}.contextPolicy.project: expected inherit or suppress`);
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function normalizePosture(id: string, value: Partial<Posture>, source: string): Posture | undefined {
  if (!isRecord(value)) {
    addConfigError(`${source}: posture must be an object`);
    return undefined;
  }

  const existing = state.postures.get(id);
  const label = typeof value.label === "string" ? value.label : existing?.label ?? id;
  const description =
    typeof value.description === "string" ? value.description : existing?.description ?? "Custom posture";
  const promptOverlay =
    typeof value.promptOverlay === "string" ? value.promptOverlay : existing?.promptOverlay;
  const contextPolicy = normalizeContextPolicy(value.contextPolicy, source) ?? existing?.contextPolicy;
  const activeTools = Array.isArray(value.activeTools)
    ? value.activeTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
    : existing?.activeTools;
  const thinking = value.thinking === undefined
    ? existing?.thinking
    : validateThinking(value.thinking)
      ? value.thinking
      : undefined;

  if (value.thinking !== undefined && thinking === undefined) {
    addConfigError(`${source}.thinking: invalid thinking level`);
  }

  return {
    id,
    label,
    description,
    promptOverlay,
    contextPolicy,
    activeTools,
    thinking,
  };
}

function mergeConfig(config: PostureConfig | undefined, source: string) {
  if (!config) return;
  if (config.postures !== undefined) {
    if (!isRecord(config.postures)) {
      addConfigError(`${source}.postures: must be an object`);
    } else {
      for (const [rawId, rawPosture] of Object.entries(config.postures)) {
        const id = normalizeId(rawId);
        if (!id) continue;
        const posture = normalizePosture(id, rawPosture as Partial<Posture>, `${source}.postures.${rawId}`);
        if (posture) state.postures.set(id, posture);
      }
    }
  }

  if (config.aliases !== undefined) {
    if (!isRecord(config.aliases)) {
      addConfigError(`${source}.aliases: must be an object`);
    } else {
      for (const [rawAlias, target] of Object.entries(config.aliases)) {
        if (typeof target !== "string") {
          addConfigError(`${source}.aliases.${rawAlias}: target must be a string`);
          continue;
        }
        state.aliases.set(normalizeId(rawAlias), normalizeId(target));
      }
    }
  }
}

function loadPostures(cwd: string) {
  resetRegistry();
  mergeConfig(readConfig(join(getAgentDir(), "postures.json")), "global config");
  mergeConfig(readConfig(resolve(cwd, ".pi", "postures.json")), "project config");
  if (!state.postures.has(state.activePostureId)) {
    state.activePostureId = "default";
  }
}

function reloadAndReconcile(pi: ExtensionAPI, ctx: ExtensionContext) {
  loadPostures(ctx.cwd);
  applyRuntime(pi, ctx, activePosture());
}

function resolvePostureId(input: string): string | undefined {
  const normalized = normalizeId(input);
  const resolved = state.aliases.get(normalized) ?? normalized;
  return state.postures.has(resolved) ? resolved : undefined;
}

function activePosture(): Posture {
  return state.postures.get(state.activePostureId) ?? state.postures.get("default")!;
}

function contextSummary(policy: ContextPolicy | undefined): string {
  const global = policy?.global ?? "inherit";
  const project = policy?.project ?? "inherit";
  return `global=${global}, project=${project}`;
}

function postureSummary(posture = activePosture()): string {
  if (posture.id === "default") return "posture: default";
  const suppressed: string[] = [];
  if (posture.contextPolicy?.global === "suppress") suppressed.push("global ctx suppressed");
  if (posture.contextPolicy?.project === "suppress") suppressed.push("project ctx suppressed");
  return [`posture: ${posture.id}`, ...suppressed].join(" · ");
}

function setStatus(ctx: ExtensionContext) {
  const posture = activePosture();
  ctx.ui.setStatus(STATUS_KEY, posture.id === "default" ? undefined : postureSummary(posture));
}

function sameStringSet(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function restoreToolsAndThinking(pi: ExtensionAPI) {
  if (state.toolSnapshot) {
    if (sameStringSet(pi.getActiveTools(), state.appliedToolsOverride)) {
      pi.setActiveTools(state.toolSnapshot);
    }
    state.toolSnapshot = undefined;
    state.appliedToolsOverride = undefined;
  }
  if (state.thinkingSnapshot) {
    if (pi.getThinkingLevel() === state.appliedThinkingOverride) {
      pi.setThinkingLevel(state.thinkingSnapshot);
    }
    state.thinkingSnapshot = undefined;
    state.appliedThinkingOverride = undefined;
  }
}

function validatedActiveTools(pi: ExtensionAPI, posture: Posture): string[] | undefined {
  if (!posture.activeTools) return undefined;
  const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const valid = posture.activeTools.filter((tool) => knownTools.has(tool));
  const invalid = posture.activeTools.filter((tool) => !knownTools.has(tool));
  for (const tool of invalid) {
    addConfigError(`posture ${posture.id}.activeTools: unknown tool "${tool}"`);
  }
  if (valid.length === 0 && posture.activeTools.length > 0) {
    addConfigError(`posture ${posture.id}.activeTools: no valid tools; override skipped`);
    return undefined;
  }
  return valid;
}

function applyRuntime(pi: ExtensionAPI, ctx: ExtensionContext, posture: Posture) {
  if (posture.id === "default") {
    state.contextFilterReport = undefined;
    restoreToolsAndThinking(pi);
    setStatus(ctx);
    return;
  }

  const activeTools = validatedActiveTools(pi, posture);
  if (activeTools) {
    if (!state.toolSnapshot) state.toolSnapshot = pi.getActiveTools();
    pi.setActiveTools(activeTools);
    state.appliedToolsOverride = activeTools;
  } else if (state.toolSnapshot) {
    if (sameStringSet(pi.getActiveTools(), state.appliedToolsOverride)) {
      pi.setActiveTools(state.toolSnapshot);
    }
    state.toolSnapshot = undefined;
    state.appliedToolsOverride = undefined;
  }

  if (posture.thinking) {
    if (!state.thinkingSnapshot) state.thinkingSnapshot = pi.getThinkingLevel();
    pi.setThinkingLevel(posture.thinking);
    state.appliedThinkingOverride = posture.thinking;
  } else if (state.thinkingSnapshot) {
    if (pi.getThinkingLevel() === state.appliedThinkingOverride) {
      pi.setThinkingLevel(state.thinkingSnapshot);
    }
    state.thinkingSnapshot = undefined;
    state.appliedThinkingOverride = undefined;
  }

  setStatus(ctx);
}

function inspectText(): string {
  const posture = activePosture();
  const aliases = Array.from(state.aliases.entries())
    .filter(([, target]) => target === posture.id)
    .map(([alias]) => alias)
    .sort();
  const lines = [
    `Active posture: ${posture.id} (${posture.label})`,
    posture.description,
    `Context policy: ${contextSummary(posture.contextPolicy)}`,
    `Prompt overlay: ${posture.promptOverlay ? "yes" : "no"}`,
    `Active tools override: ${posture.activeTools ? posture.activeTools.join(", ") : "none"}`,
    `Thinking override: ${posture.thinking ?? "none"}`,
    `Aliases: ${aliases.length > 0 ? aliases.join(", ") : "none"}`,
  ];
  if (state.contextFilterReport) {
    lines.push(
      `Context kept: ${state.contextFilterReport.kept.length > 0 ? state.contextFilterReport.kept.join(", ") : "none"}`,
      `Context suppressed: ${state.contextFilterReport.suppressed.length > 0 ? state.contextFilterReport.suppressed.join(", ") : "none"}`,
    );
  }
  if (state.configErrors.length > 0) {
    lines.push("", "Config errors:", ...state.configErrors.map((error) => `- ${error}`));
  }
  return lines.join("\n");
}

function listText(): string {
  return Array.from(state.postures.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((posture) => `${posture.id.padEnd(10)} ${posture.description}`)
    .join("\n");
}

function isGlobalContextPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const agentDir = getAgentDir().replace(/\\/g, "/");
  const homeAgents = join(homedir(), ".agents").replace(/\\/g, "/");
  return normalized.startsWith(`${agentDir}/`) || normalized.startsWith(`${homeAgents}/`);
}

function shouldSuppressContext(filePath: string, policy: ContextPolicy): boolean {
  const global = isGlobalContextPath(filePath);
  return global ? policy.global === "suppress" : policy.project === "suppress";
}

function filterRenderedProjectContextBody(body: string, policy: ContextPolicy): string {
  state.contextFilterReport = { kept: [], suppressed: [] };
  return body.replace(
    /<project_instructions path="([^"]+)">\n[\s\S]*?\n<\/project_instructions>\n*/g,
    (entry: string, filePath: string) => {
      if (shouldSuppressContext(filePath, policy)) {
        state.contextFilterReport?.suppressed.push(filePath);
        return "";
      }
      state.contextFilterReport?.kept.push(filePath);
      return entry.endsWith("\n\n") ? entry : `${entry.trimEnd()}\n\n`;
    },
  );
}

function filterProjectContext(systemPrompt: string, policy: ContextPolicy | undefined): string {
  state.contextFilterReport = undefined;
  if (!policy || (policy.global !== "suppress" && policy.project !== "suppress")) return systemPrompt;

  const projectContextPattern = /<project_context>([\s\S]*?)<\/project_context>\n?/;
  if (!projectContextPattern.test(systemPrompt)) {
    addConfigError("contextPolicy: current system prompt has no project_context block; suppression skipped");
    return systemPrompt;
  }

  return systemPrompt.replace(projectContextPattern, (_full, body: string) => {
    const filteredBody = filterRenderedProjectContextBody(body, policy);
    if (!filteredBody.includes("<project_instructions")) return "";
    return `<project_context>${filteredBody}</project_context>\n`;
  });
}

function addPromptOverlay(systemPrompt: string, posture: Posture): string {
  const filtered = filterProjectContext(systemPrompt, posture.contextPolicy);
  if (!posture.promptOverlay) return filtered;
  return `${filtered}\n\n<pi_posture id="${posture.id}">\n${posture.promptOverlay}\n</pi_posture>`;
}

function rememberPosture(pi: ExtensionAPI, id: string) {
  pi.appendEntry("posture", { id, timestamp: Date.now() });
}

function restorePostureFromSession(ctx: ExtensionContext) {
  state.activePostureId = "default";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "posture") {
      const data = entry.data as { id?: unknown } | undefined;
      const id = typeof data?.id === "string" ? resolvePostureId(data.id) : undefined;
      if (id) state.activePostureId = id;
    }
  }
}

export const __testing = {
  state,
  resetRegistry,
  loadPostures,
  resolvePostureId,
  activePosture,
  applyRuntime,
  addPromptOverlay,
  filterProjectContext,
  inspectText,
};

export default function piPosture(pi: ExtensionAPI) {
  resetRegistry();

  pi.registerMessageRenderer<string>(MESSAGE_TYPE, (message, _options, theme) => {
    return new Text(theme.fg("muted", String(message.content)), 0, 0);
  });

  pi.registerCommand("posture", {
    description: "Switch Pi harness posture: default, agent, assist, learn, review",
    getArgumentCompletions: (prefix) => {
      const values = ["list", "status", "inspect", ...state.postures.keys(), ...state.aliases.keys()].sort();
      return values
        .filter((value) => value.startsWith(normalizeId(prefix)))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      reloadAndReconcile(pi, ctx);
      const arg = normalizeId(args);

      if (!arg) {
        if (!ctx.hasUI) {
          pi.sendMessage({ customType: MESSAGE_TYPE, content: listText(), display: true });
          return;
        }
        const choices = Array.from(state.postures.values()).map((posture) => ({
          value: posture.id,
          label: `${posture.id} — ${posture.description}`,
        }));
        const choice = await ctx.ui.select("Select posture", choices.map((choice) => choice.label));
        const selected = choices.find((item) => item.label === choice)?.value;
        if (!selected) return;
        state.activePostureId = selected;
        applyRuntime(pi, ctx, activePosture());
        rememberPosture(pi, selected);
        pi.sendMessage({ customType: MESSAGE_TYPE, content: `Switched to ${postureSummary()}`, display: true });
        return;
      }

      if (arg === "list") {
        pi.sendMessage({ customType: MESSAGE_TYPE, content: listText(), display: true });
        return;
      }
      if (arg === "status") {
        pi.sendMessage({ customType: MESSAGE_TYPE, content: postureSummary(), display: true });
        return;
      }
      if (arg === "inspect") {
        pi.sendMessage({ customType: MESSAGE_TYPE, content: inspectText(), display: true });
        return;
      }

      const id = resolvePostureId(arg);
      if (!id) {
        const message = `Unknown posture: ${args.trim() || "(empty)"}. Try /posture list.`;
        pi.sendMessage({ customType: MESSAGE_TYPE, content: message, display: true });
        return;
      }

      state.activePostureId = id;
      applyRuntime(pi, ctx, activePosture());
      rememberPosture(pi, id);
      const message = `Switched to ${postureSummary()}`;
      pi.sendMessage({ customType: MESSAGE_TYPE, content: message, display: true });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    loadPostures(ctx.cwd);
    restorePostureFromSession(ctx);
    applyRuntime(pi, ctx, activePosture());
    if (state.configErrors.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`pi-posture loaded with ${state.configErrors.length} config error(s). Run /posture inspect.`, "warning");
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    setStatus(ctx);
    const posture = activePosture();
    if (posture.id === "default") return;
    return { systemPrompt: addPromptOverlay(event.systemPrompt, posture) };
  });

  pi.on("session_shutdown", () => {
    // Do not mutate runtime on shutdown; the process/session is going away or reloading.
  });
}
