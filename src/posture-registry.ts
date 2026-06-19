import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ============================================================
// Types
// ============================================================

export type ContextDecision = "inherit" | "suppress";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ContextPolicy = {
  global?: ContextDecision;
  project?: ContextDecision;
};

export type PosturePolicy = {
  /** Origin of this policy object: "static" for adapter-generated compat shim,
   *  "custom" for user-supplied. */
  type: "static" | "custom";
  /** Invoked before the posture is activated. Return a modified state or undefined. */
  onBeforeActivate?: (state: PostureRuntimeState) => PostureRuntimeState | undefined;
  /** Invoked after the posture becomes active. */
  onActivate?: (state: PostureRuntimeState) => void;
  /** Invoked when switching away from this posture. */
  onDeactivate?: (state: PostureRuntimeState) => void;
};

/** Declarative posture definition. Each posture is a named configuration
 * that modifies Pi's behavior via prompt overlays, context policies,
 * tool restrictions, and thinking levels. */
export type PostureDefinition = {
  id: string;
  label: string;
  description: string;
  promptOverlay?: string;
  contextPolicy?: ContextPolicy;
  activeTools?: string[];
  thinking?: ThinkingLevel;
  /** Reserved for future policy hooks. */
  policy?: PosturePolicy;
};

/** Per-posture runtime state, reserved for session persistence. */
export type PostureRuntimeState = {
  /** Timestamp (ms since epoch) when this posture was last activated. */
  lastActivatedAt?: number;
  /** Monotonically increasing counter of activations. */
  activationCount: number;
};

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export type StartupPickerConfig = {
  enabled: boolean;
  onlyWhenUnset: boolean;
  include: string[];
  reasons: SessionStartReason[];
  timeoutMs?: number;
};

export type PostureConfig = {
  postures?: Record<string, Partial<PostureDefinition>>;
  aliases?: Record<string, string>;
  startupPicker?: Partial<StartupPickerConfig> | boolean;
};

// ============================================================
// Constants
// ============================================================

export const DEFAULT_STARTUP_PICKER: StartupPickerConfig = {
  enabled: false,
  onlyWhenUnset: true,
  include: ["default", "agent", "assist", "learn", "review"],
  reasons: ["startup", "new", "resume", "fork"],
};

export const BUILTIN_POSTURES: PostureDefinition[] = [
  {
    id: "default",
    label: "Default",
    description: "Plugin-off behavior. Pi runs normally with no posture overlay.",
  },
  {
    id: "agent",
    label: "Agent",
    description:
      "Autonomous implementation posture for when the user wants Pi to take the wheel.",
    promptOverlay: `You are in agent posture.

The user explicitly wants delegated agentic execution. Move work forward with concise planning, code changes, command execution, and verification when appropriate. Keep the user informed, but do not stall on unnecessary permission checks. Continue to respect all higher-priority user, project, and safety instructions.`,
  },
  {
    id: "assist",
    label: "Assist",
    description:
      "Human-led pair-programming posture. The user keeps implementation ownership.",
    promptOverlay: `You are in assist posture.

The user remains the primary implementer. Use tools freely to inspect code, fetch docs, run verification, and explain local context. Give the next small step, highlight trade-offs and risks, and offer narrow help. Do not take over core implementation or make broad edits unless the user explicitly asks you to do so.`,
  },
  {
    id: "learn",
    label: "Learn",
    description:
      "Tutor posture for learning while still using the full toolset for accurate guidance.",
    promptOverlay: `You are in learn posture.

Your goal is to help the user understand and practice, not to replace them. Use tools freely to inspect code, fetch official/up-to-date documentation, search examples, and run verification so your teaching is grounded. Prefer concepts, mental models, short questions, hints, micro-exercises, and the next small step. Do not rush to deliver a complete implementation or patch unless the user explicitly asks for it. If code changes are needed, first explain what to change and why.`,
  },
  {
    id: "review",
    label: "Review",
    description:
      "Critique-oriented posture for inspecting work and explaining risks before edits.",
    promptOverlay: `You are in review posture.

Focus on understanding, critique, correctness, maintainability, reuse, security, and verification. Use tools freely to inspect the repository and run checks. Prefer findings, evidence, and suggested fixes over direct edits. Do not modify files unless the user explicitly asks you to apply a fix.`,
  },
];

export const BUILTIN_ALIASES: Record<string, string> = {
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

// ============================================================
// Internal Registry State
// ============================================================

type InternalState = {
  postures: Map<string, PostureDefinition>;
  aliases: Map<string, string>;
  startupPicker: StartupPickerConfig;
  configErrors: string[];
};

const internalState: InternalState = {
  postures: new Map(),
  aliases: new Map(),
  startupPicker: {
    ...DEFAULT_STARTUP_PICKER,
    include: [...DEFAULT_STARTUP_PICKER.include],
    reasons: [...DEFAULT_STARTUP_PICKER.reasons],
  },
  configErrors: [],
};

// ============================================================
// Pure Helpers
// ============================================================

export function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateContextDecision(value: unknown): value is ContextDecision {
  return value === "inherit" || value === "suppress";
}

export function validateThinking(value: unknown): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

export function normalizeContextPolicy(
  value: unknown,
  source: string,
): ContextPolicy | undefined {
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

export function isConfigurableSessionStartReason(
  value: unknown,
): value is Exclude<SessionStartReason, "reload"> {
  return (
    value === "startup" || value === "new" || value === "resume" || value === "fork"
  );
}

export function normalizeStringList(value: unknown, source: string): string[] | undefined {
  if (!Array.isArray(value)) {
    addConfigError(`${source}: must be an array`);
    return undefined;
  }
  const normalized: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      addConfigError(`${source}[${index}]: must be a string`);
      return;
    }
    const id = normalizeId(item);
    if (!id) {
      addConfigError(`${source}[${index}]: must not be empty`);
      return;
    }
    normalized.push(id);
  });
  return normalized;
}

/** Wrap a PostureDefinition that has no explicit policy with a static compat shim.
 *  If the definition already carries a policy it is returned as a shallow copy
 *  with the existing policy preserved. */
export function withStaticPosturePolicy(def: PostureDefinition): PostureDefinition {
  if (def.policy) return { ...def };
  return {
    ...def,
    policy: { type: "static" },
  };
}

// ============================================================
// Registry State Mutators / Queries
// ============================================================

export function addConfigError(message: string): void {
  if (!internalState.configErrors.includes(message))
    internalState.configErrors.push(message);
}

export function resetRegistry(): void {
  internalState.postures = new Map(
    BUILTIN_POSTURES.map((posture) => [posture.id, withStaticPosturePolicy(posture)]),
  );
  internalState.aliases = new Map(Object.entries(BUILTIN_ALIASES));
  internalState.startupPicker = {
    ...DEFAULT_STARTUP_PICKER,
    include: [...DEFAULT_STARTUP_PICKER.include],
    reasons: [...DEFAULT_STARTUP_PICKER.reasons],
  };
  internalState.configErrors = [];
}

function readConfig(path: string): PostureConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("root must be an object");
    return parsed as PostureConfig;
  } catch (error) {
    addConfigError(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function mergeStartupPicker(
  value: PostureConfig["startupPicker"],
  source: string,
): void {
  if (value === undefined) return;
  if (typeof value === "boolean") {
    internalState.startupPicker.enabled = value;
    return;
  }
  if (!isRecord(value)) {
    addConfigError(`${source}.startupPicker: must be an object or boolean`);
    return;
  }

  if (value.enabled !== undefined) {
    if (typeof value.enabled === "boolean")
      internalState.startupPicker.enabled = value.enabled;
    else addConfigError(`${source}.startupPicker.enabled: must be a boolean`);
  }
  if (value.onlyWhenUnset !== undefined) {
    if (typeof value.onlyWhenUnset === "boolean")
      internalState.startupPicker.onlyWhenUnset = value.onlyWhenUnset;
    else addConfigError(`${source}.startupPicker.onlyWhenUnset: must be a boolean`);
  }
  if (value.include !== undefined) {
    const include = normalizeStringList(value.include, `${source}.startupPicker.include`);
    if (include) internalState.startupPicker.include = include;
  }
  if (value.reasons !== undefined) {
    const reasons = normalizeStringList(value.reasons, `${source}.startupPicker.reasons`);
    if (reasons) {
      const valid = reasons.filter(isConfigurableSessionStartReason);
      const invalid = reasons.filter(
        (reason) => !isConfigurableSessionStartReason(reason),
      );
      for (const reason of invalid)
        addConfigError(`${source}.startupPicker.reasons: invalid reason "${reason}"`);
      internalState.startupPicker.reasons = valid;
    }
  }
  if (value.timeoutMs !== undefined) {
    if (
      typeof value.timeoutMs === "number" &&
      Number.isFinite(value.timeoutMs) &&
      value.timeoutMs > 0
    ) {
      internalState.startupPicker.timeoutMs = value.timeoutMs;
    } else {
      addConfigError(`${source}.startupPicker.timeoutMs: must be a positive number`);
    }
  }
}

function normalizePosture(
  id: string,
  value: Partial<PostureDefinition>,
  source: string,
): PostureDefinition | undefined {
  if (!isRecord(value)) {
    addConfigError(`${source}: posture must be an object`);
    return undefined;
  }

  const existing = internalState.postures.get(id);
  const label =
    typeof value.label === "string" ? value.label : existing?.label ?? id;
  const description =
    typeof value.description === "string"
      ? value.description
      : existing?.description ?? "Custom posture";
  const promptOverlay =
    typeof value.promptOverlay === "string"
      ? value.promptOverlay
      : existing?.promptOverlay;
  const contextPolicy =
    normalizeContextPolicy(value.contextPolicy, source) ?? existing?.contextPolicy;
  const activeTools = Array.isArray(value.activeTools)
    ? value.activeTools.filter(
        (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
      )
    : existing?.activeTools;
  const thinking =
    value.thinking === undefined
      ? existing?.thinking
      : validateThinking(value.thinking)
        ? value.thinking
        : undefined;

  if (value.thinking !== undefined && thinking === undefined) {
    addConfigError(`${source}.thinking: invalid thinking level`);
  }

  return withStaticPosturePolicy({
    id,
    label,
    description,
    promptOverlay,
    contextPolicy,
    activeTools,
    thinking,
  });
}

function mergeConfig(config: PostureConfig | undefined, source: string): void {
  if (!config) return;
  if (config.postures !== undefined) {
    if (!isRecord(config.postures)) {
      addConfigError(`${source}.postures: must be an object`);
    } else {
      for (const [rawId, rawPosture] of Object.entries(config.postures)) {
        const id = normalizeId(rawId);
        if (!id) continue;
        const posture = normalizePosture(
          id,
          rawPosture as Partial<PostureDefinition>,
          `${source}.postures.${rawId}`,
        );
        if (posture) internalState.postures.set(id, posture);
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
        internalState.aliases.set(normalizeId(rawAlias), normalizeId(target));
      }
    }
  }
  mergeStartupPicker(config.startupPicker, source);
}

function normalizeStartupPickerConfig(): void {
  const seen = new Set<string>();
  const include: string[] = [];
  for (const rawId of internalState.startupPicker.include) {
    const id = resolvePostureId(rawId);
    if (!id) {
      addConfigError(`startupPicker.include: unknown posture or alias "${rawId}"`);
      continue;
    }
    if (seen.has(id)) {
      addConfigError(`startupPicker.include: duplicate posture "${id}" from "${rawId}"`);
      continue;
    }
    seen.add(id);
    include.push(rawId);
  }
  internalState.startupPicker.include = include;
}

export function resolvePostureId(input: string): string | undefined {
  const normalized = normalizeId(input);
  const resolved = internalState.aliases.get(normalized) ?? normalized;
  return internalState.postures.has(resolved) ? resolved : undefined;
}

export function loadPostures(cwd: string): void {
  resetRegistry();
  mergeConfig(readConfig(join(getAgentDir(), "postures.json")), "global config");
  mergeConfig(readConfig(resolve(cwd, ".pi", "postures.json")), "project config");
  normalizeStartupPickerConfig();
}

export function selectableStartupPostures(): PostureDefinition[] {
  return internalState.startupPicker.include
    .map(resolvePostureId)
    .filter((id): id is string => !!id)
    .map((id) => internalState.postures.get(id))
    .filter((posture): posture is PostureDefinition => !!posture);
}

// ============================================================
// Test / Inspection Surface
// ============================================================

export function getRegistryState() {
  return internalState;
}
