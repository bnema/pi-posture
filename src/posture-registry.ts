import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ============================================================
// Pi Config Directory Name
// ============================================================

/**
 * Directory name for Pi project configuration files (`postures.json`).
 * Mirrors CONFIG_DIR_NAME from @earendil-works/pi-coding-agent (not exported
 * from main index in the installed version). When the dependency is updated,
 * this can be replaced with an import from the package.
 */
export const CONFIG_DIR_NAME = ".pi";

// ============================================================
// Types
// ============================================================

export type ContextDecision = "inherit" | "suppress";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type InteractionStyle = "autonomous" | "assistive" | "review" | "socratic" | "custom";
export type MutationPolicy = "allow" | "guarded" | "read-mostly";
export type AnswerPolicy = "direct" | "hint-first" | "explicit-request";
export type DynamicPromptPreset = "none" | "objective-aware" | "verification-focused" | "socratic" | "review-focused";

export type ContextPolicy = {
  global?: ContextDecision;
  project?: ContextDecision;
};

// ============================================================
// Policy Hook Types
// ============================================================

/** Context passed to all policy hooks. */
export type PolicyHookContext = {
  postureId: string;
  runtimeState: PostureRuntimeState;
};

/** Input data for before_agent_start hook. */
export type PolicyBeforeAgentStartInput = {
  prompt: string;
  systemPrompt: string;
};

/** Result from before_agent_start hook. */
export type PolicyBeforeAgentStartResult = {
  systemPrompt?: string;
};

/** Input data for input hook (user message). */
export type PolicyInputInput = {
  text: string;
};

/** Result from input hook. */
export type PolicyInputResult = {
  action?: "continue" | "handled" | "transform";
  text?: string;
};

/** Input data for tool_call hook. */
export type PolicyToolCallInput = {
  toolCallId: string;
  toolName: string;
};

/** Result from tool_call hook. */
export type PolicyToolCallResult = {
  block?: boolean;
  reason?: string;
};

/** Input data for tool_result hook. */
export type PolicyToolResultInput = {
  toolCallId: string;
  toolName: string;
};

/** Result from tool_result hook. */
// Local definitions matching Pi's TextContent and ImageContent types
// (not re-exported from @earendil-works/pi-coding-agent)
export interface PolicyTextContent {
  readonly type: "text";
  readonly text: string;
  readonly textSignature?: string;
}

export interface PolicyImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type PolicyToolResultContent = Array<PolicyTextContent | PolicyImageContent>;

export type PolicyToolResultResult = {
  content?: PolicyToolResultContent;
  isError?: boolean;
};

export type PosturePolicy = {
  /** Origin of this policy object: "static" for adapter-generated compat shim,
   *  "custom" for user-supplied. */
  type: "static" | "custom";
  /**
   * Invoked before the posture is activated. Lifecycle hooks receive the
   * runtimeState object directly; event hooks below receive PolicyHookContext.
   * Return a modified state or undefined.
   */
  onBeforeActivate?: (state: PostureRuntimeState) => PostureRuntimeState | undefined;
  /**
   * Invoked after the posture becomes active. Lifecycle hooks receive the
   * runtimeState object directly; event hooks below receive PolicyHookContext.
   */
  onActivate?: (state: PostureRuntimeState) => void;
  /**
   * Invoked when switching away from this posture. Lifecycle hooks receive the
   * runtimeState object directly; event hooks below receive PolicyHookContext.
   */
  onDeactivate?: (state: PostureRuntimeState) => void;
  /** Invoked before each agent turn to modify the system prompt or add messages. */
  onBeforeAgentStart?: (
    ctx: PolicyHookContext,
    input: PolicyBeforeAgentStartInput,
  ) => PolicyBeforeAgentStartResult | undefined;
  /** Invoked on user input to transform or intercept the message. */
  onInput?: (
    ctx: PolicyHookContext,
    input: PolicyInputInput,
  ) => PolicyInputResult | undefined;
  /** Invoked before a tool executes; can block or transform the call. */
  onToolCall?: (
    ctx: PolicyHookContext,
    input: PolicyToolCallInput,
  ) => PolicyToolCallResult | undefined;
  /** Invoked after a tool executes; can patch the result. */
  onToolResult?: (
    ctx: PolicyHookContext,
    input: PolicyToolResultInput,
  ) => PolicyToolResultResult | undefined;
  /** Invoked at the end of each turn for observation. */
  onTurnEnd?: (ctx: PolicyHookContext) => void;
  /** Invoked when the agent loop ends for observation. */
  onAgentEnd?: (ctx: PolicyHookContext) => void;
  /** Invoked on session start. */
  onSessionStart?: (ctx: PolicyHookContext) => void;
  /** Invoked on session shutdown. */
  onSessionShutdown?: (ctx: PolicyHookContext) => void;
  /** Return status text for the footer, or undefined for default fallback. */
  renderStatus?: (ctx: PolicyHookContext) => string | undefined;
  /** Return widget lines above the editor, or undefined for no widget. */
  renderWidget?: (ctx: PolicyHookContext) => string[] | undefined;
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
  interactionStyle?: InteractionStyle;
  mutationPolicy?: MutationPolicy;
  answerPolicy?: AnswerPolicy;
  statusLabel?: string;
  dynamicPrompt?: DynamicPromptPreset;
  /** Reserved for future policy hooks. */
  policy?: PosturePolicy;
};

/** Config-only posture entry — excludes "policy" and other internal fields
 *  that are reserved for the registry adapter. User config must not appear
 *  to accept policy configuration. */
export type PostureConfigEntry = Partial<Omit<PostureDefinition, "policy">>;

/** Per-posture runtime state, reserved for session persistence. */
export type PostureRuntimeState = {
  /** Timestamp (ms since epoch) when this posture was last activated. */
  lastActivatedAt?: number;
  /** Monotonically increasing counter of activations. */
  activationCount: number;
  /** Number of turns observed while this posture was active (via onTurnEnd). */
  turnsInSession?: number;
  /** Optional user-supplied objective scoped to this posture. */
  objective?: string;
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
  postures?: Record<string, PostureConfigEntry>;
  aliases?: Record<string, string>;
  startupPicker?: Partial<StartupPickerConfig> | boolean;
};

// ============================================================
// Constants
// ============================================================

/** Built-in orchestrator policy providing dynamic guidance around primary
 *  coordination, sub-agent delegation, autonomous execution, verification,
 *  and escalation. This is an internal policy that uses the same runtime hook
 *  dispatch mechanism as user-supplied custom policies, but is wired in code
 *  rather than via JSON config. */
export const BUILTIN_ORCHESTRATOR_POLICY: PosturePolicy = {
  type: "custom",

  onBeforeAgentStart: () => {
    return {
      systemPrompt:
        "## Orchestrator Guidance\n" +
        "\n" +
        "Act as the primary coordinator that delegates tasks to the appropriate sub-agents when they can make progress independently.\n" +
        "You should remove the human from the loop once a plan has been defined and approved; handle routine execution decisions yourself.\n" +
        "Work autonomously until the goal is complete; do not stall on unnecessary permission checks.\n" +
        "After making code changes, verify them (typecheck, tests, or relevant commands).\n" +
        "If blocked, uncertain, or needing human judgment — explain clearly and ask.\n" +
        "Respect all higher-priority instructions and project safety rules.",
    };
  },

  onTurnEnd: (ctx) => {
    ctx.runtimeState.turnsInSession =
      (ctx.runtimeState.turnsInSession ?? 0) + 1;
  },
};

/** Built-in assist policy providing dynamic guidance around human ownership
 *  and guarded next-step behavior. This is an internal policy that uses the
 *  same runtime hook dispatch mechanism as user-supplied custom policies,
 *  but is wired in code rather than via JSON config. */
export const BUILTIN_ASSIST_POLICY: PosturePolicy = {
  type: "custom",

  onBeforeAgentStart: () => {
    return {
      systemPrompt:
        "## Assist Guidance\n" +
        "\n" +
        "The user remains the primary implementer — you are their pair. Do not take over or make broad edits unless explicitly asked to do so.\n" +
        "Propose narrow, specific next steps. Offer to inspect, run, verify, or explain local context.\n" +
        "Highlight trade-offs and risks before suggesting changes.\n" +
        "If the user asks you to take the wheel, offer to switch to orchestrator posture or proceed only with explicit permission.",
    };
  },

  // Assist intentionally does not count turns; it is cognitive guidance for a
  // human-led pairing session, not an autonomous progress tracker.
};

/** Built-in review policy providing dynamic guidance around evidence-first
 *  critique, read-mostly behavior, and guarded mutation. This is an internal
 *  policy that uses the same runtime hook dispatch mechanism as user-supplied
 *  custom policies, but is wired in code rather than via JSON config. */
export const BUILTIN_REVIEW_POLICY: PosturePolicy = {
  type: "custom",

  onBeforeAgentStart: () => {
    return {
      systemPrompt:
        "## Review Guidance\n" +
        "\n" +
        "Adopt an evidence-first approach — inspect code and context before making any judgment.\n" +
        "Cite file and line evidence when reporting findings or suggested fixes.\n" +
        "Prefer explaining risks, trade-offs, and opportunities over making direct changes.\n" +
        "Verify assumptions by running tools and reading relevant files.\n" +
        "Do not modify files unless the user explicitly asks you to apply a fix.",
    };
  },

  onTurnEnd: (ctx) => {
    ctx.runtimeState.turnsInSession =
      (ctx.runtimeState.turnsInSession ?? 0) + 1;
  },
};

/** Built-in learn policy providing dynamic guidance around Socratic,
 *  hint-first teaching. This is an internal policy that uses the same
 *  runtime hook dispatch mechanism as user-supplied custom policies,
 *  but is wired in code rather than via JSON config. */
export const BUILTIN_LEARN_POLICY: PosturePolicy = {
  type: "custom",

  onBeforeAgentStart: () => {
    return {
      systemPrompt:
        "## Learn Guidance\n" +
        "\n" +
        "Adopt a Socratic, hint-first teaching approach:\n" +
        "- Diagnose what the user is trying to learn or do before giving answers.\n" +
        "- Ask short guiding questions to draw out understanding.\n" +
        "- Favor concepts, mental models, hints, and micro-exercises over full solutions.\n" +
        "- Use tools to inspect code and fetch documentation so your teaching is grounded.\n" +
        "- When code changes are needed, explain what to change and why before writing code.\n" +
        "- Do not provide full implementations or patches unless the user explicitly asks.\n" +
        "- If the user seems stuck, offer a small nudge or clarifying question.",
    };
  },

  onTurnEnd: (ctx) => {
    ctx.runtimeState.turnsInSession =
      (ctx.runtimeState.turnsInSession ?? 0) + 1;
  },
};

export const DEFAULT_STARTUP_PICKER: StartupPickerConfig = {
  enabled: false,
  onlyWhenUnset: true,
  include: ["default", "orchestrator", "assist", "learn", "review"],
  reasons: ["startup", "new", "resume", "fork"],
};

export const BUILTIN_POSTURES: PostureDefinition[] = [
  {
    id: "default",
    label: "Default",
    description: "Plugin-off behavior. Pi runs normally with no posture overlay.",
  },
  {
    id: "orchestrator",
    label: "Orchestrator",
    description:
      "Primary coordination posture for approved plans: delegates to sub-agents and works autonomously until the goal is complete.",
    promptOverlay: `You are in orchestrator posture.

The user wants you to act as the primary coordinator that delegates tasks to the appropriate sub-agents. You should remove the human from the loop once a plan has been defined and approved, and work autonomously until the goal is complete. Move work forward with concise planning, code changes, command execution, and verification when appropriate. Continue to respect all higher-priority user, project, and safety instructions.`,
    policy: BUILTIN_ORCHESTRATOR_POLICY,
  },
  {
    id: "assist",
    label: "Assist",
    description:
      "Human-led pair-programming posture. The user keeps implementation ownership.",
    promptOverlay: `You are in assist posture.

The user remains the primary implementer. Use tools freely to inspect code, fetch docs, run verification, and explain local context. Give the next small step, highlight trade-offs and risks, and offer narrow help. Do not take over core implementation or make broad edits unless the user explicitly asks you to do so.`,
    policy: BUILTIN_ASSIST_POLICY,
  },
  {
    id: "learn",
    label: "Learn",
    description:
      "Tutor posture for learning while still using the full toolset for accurate guidance.",
    promptOverlay: `You are in learn posture.

Your goal is to help the user understand and practice, not to replace them. Use tools freely to inspect code, fetch official/up-to-date documentation, search examples, and run verification so your teaching is grounded. Prefer concepts, mental models, short questions, hints, micro-exercises, and the next small step. Do not rush to deliver a complete implementation or patch unless the user explicitly asks for it. If code changes are needed, first explain what to change and why.`,
    policy: BUILTIN_LEARN_POLICY,
  },
  {
    id: "review",
    label: "Review",
    description:
      "Critique-oriented posture for inspecting work and explaining risks before edits.",
    promptOverlay: `You are in review posture.

Focus on understanding, critique, correctness, maintainability, reuse, security, and verification. Use tools freely to inspect the repository and run checks. Prefer findings, evidence, and suggested fixes over direct edits. Do not modify files unless the user explicitly asks you to apply a fix.`,
    policy: BUILTIN_REVIEW_POLICY,
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
  autonomous: "orchestrator",
  execute: "orchestrator",
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
// Helper Functions
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

export function validateInteractionStyle(value: unknown): value is InteractionStyle {
  return (
    typeof value === "string" &&
    ["autonomous", "assistive", "review", "socratic", "custom"].includes(value)
  );
}

export function validateMutationPolicy(value: unknown): value is MutationPolicy {
  return (
    typeof value === "string" &&
    ["allow", "guarded", "read-mostly"].includes(value)
  );
}

export function validateAnswerPolicy(value: unknown): value is AnswerPolicy {
  return (
    typeof value === "string" &&
    ["direct", "hint-first", "explicit-request"].includes(value)
  );
}

export function validateDynamicPromptPreset(value: unknown): value is DynamicPromptPreset {
  return (
    typeof value === "string" &&
    ["none", "objective-aware", "verification-focused", "socratic", "review-focused"].includes(value)
  );
}

/**
 * Stateful context-policy normalizer for direct registry APIs. Validation
 * errors are recorded in the module-level config error list.
 */
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
// Pure Registry Builder
// ============================================================

export type RegistryBuildResult = {
  postures: Map<string, PostureDefinition>;
  aliases: Map<string, string>;
  startupPicker: StartupPickerConfig;
  configErrors: string[];
};

/**
 * Build a posture registry from in-memory config objects without any
 * filesystem access or mutable module state. Pure — no side effects.
 *
 * @param configs  Config objects to merge in order (undefined entries are skipped).
 * @param sources  Optional source labels for config error messages.
 */
export function buildPostureRegistry(
  configs: (PostureConfig | undefined)[],
  sources?: string[],
): RegistryBuildResult {
  // Start with built-ins (with static policy shim)
  const postures = new Map<string, PostureDefinition>(
    BUILTIN_POSTURES.map((p) => [p.id, withStaticPosturePolicy(p)]),
  );
  const aliases = new Map<string, string>(Object.entries(BUILTIN_ALIASES));
  const startupPicker: StartupPickerConfig = {
    ...DEFAULT_STARTUP_PICKER,
    include: [...DEFAULT_STARTUP_PICKER.include],
    reasons: [...DEFAULT_STARTUP_PICKER.reasons],
  };
  const configErrors: string[] = [];
  const addErr = (msg: string) => {
    if (!configErrors.includes(msg)) configErrors.push(msg);
  };

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    if (!config) continue;
    const source = sources?.[i] ?? `config[${i}]`;

    // --- Merge postures ---
    if (config.postures !== undefined) {
      if (!isRecord(config.postures)) {
        addErr(`${source}.postures: must be an object`);
      } else {
        for (const [rawId, rawPosture] of Object.entries(config.postures)) {
          const id = normalizeId(rawId);
          if (!id) continue;

          if (!isRecord(rawPosture)) {
            addErr(`${source}.postures.${rawId}: posture must be an object`);
            continue;
          }

          const entry = rawPosture as PostureConfigEntry;
          const existing = postures.get(id);

          const label =
            typeof entry.label === "string"
              ? entry.label
              : existing?.label ?? id;
          const description =
            typeof entry.description === "string"
              ? entry.description
              : existing?.description ?? "Custom posture";
          const promptOverlay =
            typeof entry.promptOverlay === "string"
              ? entry.promptOverlay
              : existing?.promptOverlay;

          let contextPolicy = existing?.contextPolicy;
          if (entry.contextPolicy !== undefined) {
            if (!isRecord(entry.contextPolicy)) {
              addErr(`${source}.postures.${rawId}.contextPolicy: must be an object`);
            } else {
              const cp: ContextPolicy = {};
              const cpVal = entry.contextPolicy as Record<string, unknown>;
              if (cpVal.global !== undefined) {
                if (validateContextDecision(cpVal.global))
                  cp.global = cpVal.global as ContextDecision;
                else
                  addErr(`${source}.postures.${rawId}.contextPolicy.global: expected inherit or suppress`);
              }
              if (cpVal.project !== undefined) {
                if (validateContextDecision(cpVal.project))
                  cp.project = cpVal.project as ContextDecision;
                else
                  addErr(`${source}.postures.${rawId}.contextPolicy.project: expected inherit or suppress`);
              }
              if (Object.keys(cp).length > 0) contextPolicy = cp;
            }
          }

          const activeTools = Array.isArray(entry.activeTools)
            ? entry.activeTools.filter(
                (tool): tool is string =>
                  typeof tool === "string" && tool.trim().length > 0,
              )
            : existing?.activeTools;

          let thinking = existing?.thinking;
          if (entry.thinking !== undefined) {
            if (validateThinking(entry.thinking)) {
              thinking = entry.thinking;
            } else {
              addErr(`${source}.postures.${rawId}.thinking: invalid thinking level`);
            }
          }

          // --- interactionStyle ---
          let interactionStyle = existing?.interactionStyle;
          if (entry.interactionStyle !== undefined) {
            if (validateInteractionStyle(entry.interactionStyle)) {
              interactionStyle = entry.interactionStyle;
            } else {
              addErr(`${source}.postures.${rawId}.interactionStyle: invalid value`);
            }
          }

          // --- mutationPolicy ---
          let mutationPolicy = existing?.mutationPolicy;
          if (entry.mutationPolicy !== undefined) {
            if (validateMutationPolicy(entry.mutationPolicy)) {
              mutationPolicy = entry.mutationPolicy;
            } else {
              addErr(`${source}.postures.${rawId}.mutationPolicy: invalid value`);
            }
          }

          // --- answerPolicy ---
          let answerPolicy = existing?.answerPolicy;
          if (entry.answerPolicy !== undefined) {
            if (validateAnswerPolicy(entry.answerPolicy)) {
              answerPolicy = entry.answerPolicy;
            } else {
              addErr(`${source}.postures.${rawId}.answerPolicy: invalid value`);
            }
          }

          // --- statusLabel ---
          let statusLabel = existing?.statusLabel;
          if (entry.statusLabel !== undefined) {
            if (typeof entry.statusLabel === "string") {
              statusLabel = entry.statusLabel;
            } else {
              addErr(`${source}.postures.${rawId}.statusLabel: must be a string`);
            }
          }

          // --- dynamicPrompt ---
          let dynamicPrompt = existing?.dynamicPrompt;
          if (entry.dynamicPrompt !== undefined) {
            if (validateDynamicPromptPreset(entry.dynamicPrompt)) {
              dynamicPrompt = entry.dynamicPrompt;
            } else {
              addErr(`${source}.postures.${rawId}.dynamicPrompt: invalid value`);
            }
          }

          // Preserve internal/custom policy from the existing definition
          // (e.g., orchestrator's built-in custom policy) when config override does
          // not provide an explicit policy object.
          const mergedDef: PostureDefinition = {
            id,
            label,
            description,
            promptOverlay,
            contextPolicy,
            activeTools,
            thinking,
            interactionStyle,
            mutationPolicy,
            answerPolicy,
            statusLabel,
            dynamicPrompt,
          };
          if (
            existing?.policy &&
            existing.policy.type !== "static"
          ) {
            mergedDef.policy = existing.policy;
          }
          postures.set(id, withStaticPosturePolicy(mergedDef));
        }
      }
    }

    // --- Merge aliases ---
    if (config.aliases !== undefined) {
      if (!isRecord(config.aliases)) {
        addErr(`${source}.aliases: must be an object`);
      } else {
        for (const [rawAlias, target] of Object.entries(config.aliases)) {
          if (typeof target !== "string") {
            addErr(`${source}.aliases.${rawAlias}: target must be a string`);
            continue;
          }
          aliases.set(normalizeId(rawAlias), normalizeId(target));
        }
      }
    }

    // --- Merge startup picker ---
    if (config.startupPicker !== undefined) {
      if (typeof config.startupPicker === "boolean") {
        startupPicker.enabled = config.startupPicker;
      } else if (!isRecord(config.startupPicker)) {
        addErr(`${source}.startupPicker: must be an object or boolean`);
      } else {
        const sp = config.startupPicker as Record<string, unknown>;

        if (sp.enabled !== undefined) {
          if (typeof sp.enabled === "boolean")
            startupPicker.enabled = sp.enabled;
          else addErr(`${source}.startupPicker.enabled: must be a boolean`);
        }
        if (sp.onlyWhenUnset !== undefined) {
          if (typeof sp.onlyWhenUnset === "boolean")
            startupPicker.onlyWhenUnset = sp.onlyWhenUnset;
          else
            addErr(`${source}.startupPicker.onlyWhenUnset: must be a boolean`);
        }
        if (sp.include !== undefined) {
          if (!Array.isArray(sp.include)) {
            addErr(`${source}.startupPicker.include: must be an array`);
          } else {
            const include: string[] = [];
            sp.include.forEach((item: unknown, index: number) => {
              if (typeof item !== "string") {
                addErr(`${source}.startupPicker.include[${index}]: must be a string`);
                return;
              }
              const id = normalizeId(item);
              if (!id) {
                addErr(`${source}.startupPicker.include[${index}]: must not be empty`);
                return;
              }
              include.push(id);
            });
            startupPicker.include = include;
          }
        }
        if (sp.reasons !== undefined) {
          if (!Array.isArray(sp.reasons)) {
            addErr(`${source}.startupPicker.reasons: must be an array`);
          } else {
            const reasons: SessionStartReason[] = [];
            sp.reasons.forEach((item: unknown, index: number) => {
              if (typeof item !== "string") {
                addErr(`${source}.startupPicker.reasons[${index}]: must be a string`);
                return;
              }
              const reason = normalizeId(item);
              if (isConfigurableSessionStartReason(reason)) {
                reasons.push(reason);
              } else {
                addErr(`${source}.startupPicker.reasons: invalid reason "${item}"`);
              }
            });
            startupPicker.reasons = reasons;
          }
        }
        if (sp.timeoutMs !== undefined) {
          if (
            typeof sp.timeoutMs === "number" &&
            Number.isFinite(sp.timeoutMs) &&
            sp.timeoutMs > 0
          ) {
            startupPicker.timeoutMs = sp.timeoutMs;
          } else {
            addErr(`${source}.startupPicker.timeoutMs: must be a positive number`);
          }
        }
      }
    }
  }

  // --- Normalize startup picker: resolve aliases, dedupe, remove unknown ---
  const seen = new Set<string>();
  const include: string[] = [];
  for (const rawId of startupPicker.include) {
    const normalized = normalizeId(rawId);
    const resolved = aliases.get(normalized) ?? normalized;
    if (!postures.has(resolved)) {
      addErr(`startupPicker.include: unknown posture or alias "${rawId}"`);
      continue;
    }
    if (seen.has(resolved)) {
      addErr(`startupPicker.include: duplicate posture "${resolved}" from "${rawId}"`);
      continue;
    }
    seen.add(resolved);
    include.push(rawId);
  }
  startupPicker.include = include;

  return { postures, aliases, startupPicker, configErrors };
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

function readConfig(path: string): { config: PostureConfig | undefined; errors: string[] } {
  if (!existsSync(path)) return { config: undefined, errors: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("root must be an object");
    return { config: parsed as PostureConfig, errors: [] };
  } catch (error) {
    return {
      config: undefined,
      errors: [
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}








export function resolvePostureId(input: string): string | undefined {
  const normalized = normalizeId(input);
  const resolved = internalState.aliases.get(normalized) ?? normalized;
  return internalState.postures.has(resolved) ? resolved : undefined;
}

export function loadPostures(
  cwd: string,
  options?: { loadProjectConfig?: boolean },
): void {
  const globalConfig = readConfig(join(getAgentDir(), "postures.json"));
  const projectConfig =
    options?.loadProjectConfig !== false
      ? readConfig(resolve(cwd, CONFIG_DIR_NAME, "postures.json"))
      : { config: undefined, errors: [] };
  const result = buildPostureRegistry(
    [globalConfig.config, projectConfig.config],
    ["global config", "project config"],
  );
  internalState.postures = result.postures;
  internalState.aliases = result.aliases;
  internalState.startupPicker = result.startupPicker;
  internalState.configErrors = [
    ...globalConfig.errors,
    ...projectConfig.errors,
    ...result.configErrors,
  ];
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
