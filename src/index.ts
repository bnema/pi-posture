import { getAgentDir, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  addConfigError,
  getRegistryState,
  isRecord,
  loadPostures as registryLoadPostures,
  normalizeId,
  resetRegistry,
  resolvePostureId,
  selectableStartupPostures,
  withStaticPosturePolicy,
} from "./posture-registry.js";

import type {
  ContextPolicy,
  PolicyBeforeAgentStartInput,
  PolicyHookContext,
  PolicyInputInput,
  PolicyToolCallInput,
  PolicyToolResultInput,
  PostureDefinition,
  PostureRuntimeState,
  SessionStartReason,
  ThinkingLevel,
} from "./posture-registry.js";

// ============================================================
// Runtime Types
// ============================================================

type ContextFilterReport = {
  kept: string[];
  suppressed: string[];
};

type RuntimeState = {
  activePostureId: string;
  contextFilterReport?: ContextFilterReport;
  toolSnapshot?: string[];
  appliedToolsOverride?: string[];
  thinkingSnapshot?: ThinkingLevel;
  appliedThinkingOverride?: ThinkingLevel;
};

// ============================================================
// Constants
// ============================================================

const STATUS_KEY = "pi-posture";
const WIDGET_KEY = "pi-posture-widget";
const MESSAGE_TYPE = "pi-posture";

// ============================================================
// Runtime State
// ============================================================

const runtimeState: RuntimeState = {
  activePostureId: "default",
};

// ============================================================
// Per-Posture Runtime State (persisted via session entries)
// ============================================================

const postureRuntimeStates: Map<string, PostureRuntimeState> = new Map();

function getOrCreatePostureRuntimeState(id: string): PostureRuntimeState {
  let state = postureRuntimeStates.get(id);
  if (!state) {
    state = { activationCount: 0 };
    postureRuntimeStates.set(id, state);
  }
  return state;
}

function persistPostureRuntimeState(pi: ExtensionAPI): void {
  const states: Record<string, PostureRuntimeState> = {};
  for (const [id, state] of postureRuntimeStates) {
    states[id] = { ...state };
  }
  if (Object.keys(states).length > 0) {
    pi.appendEntry("pi-posture-state", { states });
  }
}

function restorePostureRuntimeState(ctx: ExtensionContext): void {
  postureRuntimeStates.clear();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "pi-posture-state") {
      const data = entry.data as Record<string, unknown> | undefined;
      const states = data?.states;
      if (!isRecord(states)) continue;
      for (const [id, rawState] of Object.entries(states)) {
        const sanitized = sanitizePostureRuntimeState(rawState);
        if (sanitized) {
          postureRuntimeStates.set(id, sanitized);
        }
      }
    }
  }
}

function snapshotPostureRuntimeStates(): string {
  const sorted: Record<string, PostureRuntimeState> = {};
  for (const key of Array.from(postureRuntimeStates.keys()).sort()) {
    sorted[key] = postureRuntimeStates.get(key)!;
  }
  return JSON.stringify(sorted);
}

function sanitizePostureRuntimeState(value: unknown): PostureRuntimeState | null {
  if (!isRecord(value)) return null;
  const { activationCount, lastActivatedAt, turnsInSession } = value as Record<string, unknown>;
  if (typeof activationCount !== "number" || !Number.isFinite(activationCount)) return null;
  if (lastActivatedAt !== undefined && (typeof lastActivatedAt !== "number" || !Number.isFinite(lastActivatedAt))) return null;
  if (turnsInSession !== undefined) {
    if (
      typeof turnsInSession !== "number" ||
      !Number.isFinite(turnsInSession) ||
      turnsInSession < 0 ||
      !Number.isInteger(turnsInSession)
    )
      return null;
  }
  const result: PostureRuntimeState = { activationCount };
  if (lastActivatedAt !== undefined) result.lastActivatedAt = lastActivatedAt;
  if (turnsInSession !== undefined) result.turnsInSession = turnsInSession;
  return result;
}

function persistIfChanged(pi: ExtensionAPI, before: string): void {
  if (before !== snapshotPostureRuntimeStates()) {
    persistPostureRuntimeState(pi);
  }
}

// ============================================================
// Runtime Helper Functions
// ============================================================

function activePosture(): PostureDefinition {
  const reg = getRegistryState();
  return (
    reg.postures.get(runtimeState.activePostureId) ??
    reg.postures.get("default")!
  );
}

function ensureActivePostureExists(): void {
  if (!resolvePostureId(runtimeState.activePostureId)) {
    runtimeState.activePostureId = "default";
  }
}

function contextSummary(policy: ContextPolicy | undefined): string {
  const global = policy?.global ?? "inherit";
  const project = policy?.project ?? "inherit";
  return `global=${global}, project=${project}`;
}

function postureSummary(posture = activePosture()): string {
  if (posture.id === "default") return "posture: default";
  const suppressed: string[] = [];
  if (posture.contextPolicy?.global === "suppress")
    suppressed.push("global ctx suppressed");
  if (posture.contextPolicy?.project === "suppress")
    suppressed.push("project ctx suppressed");
  return [`posture: ${posture.id}`, ...suppressed].join(" · ");
}

function updatePostureUi(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const posture = activePosture();
  const policyCtx = activePolicyContext();
  const policy = posture.policy;

  // Snapshot before UI hooks (each may mutate runtimeState)
  const before = snapshotPostureRuntimeStates();

  // --- Status ---
  let statusText: string | undefined;

  if (policy?.type === "custom" && policy.renderStatus) {
    const customStatus = policy.renderStatus(policyCtx);
    if (customStatus !== undefined) {
      statusText = customStatus;
    }
  }

  if (statusText === undefined) {
    statusText =
      posture.id === "default" ? undefined : postureSummary(posture);
  }

  ctx.ui.setStatus(STATUS_KEY, statusText);

  // --- Widget ---
  let widgetContent: string[] | undefined;

  if (policy?.type === "custom" && policy.renderWidget) {
    widgetContent = policy.renderWidget(policyCtx);
  }

  ctx.ui.setWidget(WIDGET_KEY, widgetContent);

  // Persist once if any UI hook mutated runtime state
  persistIfChanged(pi, before);
}

function sameStringSet(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function restoreToolsAndThinking(pi: ExtensionAPI) {
  if (runtimeState.toolSnapshot) {
    if (
      sameStringSet(
        pi.getActiveTools(),
        runtimeState.appliedToolsOverride,
      )
    ) {
      pi.setActiveTools(runtimeState.toolSnapshot);
    }
    runtimeState.toolSnapshot = undefined;
    runtimeState.appliedToolsOverride = undefined;
  }
  if (runtimeState.thinkingSnapshot) {
    if (pi.getThinkingLevel() === runtimeState.appliedThinkingOverride) {
      pi.setThinkingLevel(runtimeState.thinkingSnapshot);
    }
    runtimeState.thinkingSnapshot = undefined;
    runtimeState.appliedThinkingOverride = undefined;
  }
}

function validatedActiveTools(
  pi: ExtensionAPI,
  posture: PostureDefinition,
): string[] | undefined {
  if (!posture.activeTools) return undefined;
  const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const valid = posture.activeTools.filter((tool) => knownTools.has(tool));
  const invalid = posture.activeTools.filter(
    (tool) => !knownTools.has(tool),
  );
  for (const tool of invalid) {
    addConfigError(`posture ${posture.id}.activeTools: unknown tool "${tool}"`);
  }
  if (valid.length === 0 && posture.activeTools.length > 0) {
    addConfigError(
      `posture ${posture.id}.activeTools: no valid tools; override skipped`,
    );
    return undefined;
  }
  return valid;
}

function applyRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  posture: PostureDefinition,
) {
  if (posture.id === "default") {
    runtimeState.contextFilterReport = undefined;
    restoreToolsAndThinking(pi);
    updatePostureUi(pi, ctx);
    return;
  }

  const activeTools = validatedActiveTools(pi, posture);
  if (activeTools) {
    if (!runtimeState.toolSnapshot)
      runtimeState.toolSnapshot = pi.getActiveTools();
    pi.setActiveTools(activeTools);
    runtimeState.appliedToolsOverride = activeTools;
  } else if (runtimeState.toolSnapshot) {
    if (
      sameStringSet(
        pi.getActiveTools(),
        runtimeState.appliedToolsOverride,
      )
    ) {
      pi.setActiveTools(runtimeState.toolSnapshot);
    }
    runtimeState.toolSnapshot = undefined;
    runtimeState.appliedToolsOverride = undefined;
  }

  if (posture.thinking) {
    if (!runtimeState.thinkingSnapshot)
      runtimeState.thinkingSnapshot = pi.getThinkingLevel();
    pi.setThinkingLevel(posture.thinking);
    runtimeState.appliedThinkingOverride = posture.thinking;
  } else if (runtimeState.thinkingSnapshot) {
    if (pi.getThinkingLevel() === runtimeState.appliedThinkingOverride) {
      pi.setThinkingLevel(runtimeState.thinkingSnapshot);
    }
    runtimeState.thinkingSnapshot = undefined;
    runtimeState.appliedThinkingOverride = undefined;
  }

  updatePostureUi(pi, ctx);
}

function inspectText(): string {
  const reg = getRegistryState();
  const posture = activePosture();
  const aliases = Array.from(reg.aliases.entries())
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
  if (runtimeState.contextFilterReport) {
    lines.push(
      `Context kept: ${runtimeState.contextFilterReport.kept.length > 0 ? runtimeState.contextFilterReport.kept.join(", ") : "none"}`,
      `Context suppressed: ${runtimeState.contextFilterReport.suppressed.length > 0 ? runtimeState.contextFilterReport.suppressed.join(", ") : "none"}`,
    );
  }
  if (reg.configErrors.length > 0) {
    lines.push(
      "",
      "Config errors:",
      ...reg.configErrors.map((error) => `- ${error}`),
    );
  }
  return lines.join("\n");
}

function listText(): string {
  const reg = getRegistryState();
  return Array.from(reg.postures.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (posture) => `${posture.id.padEnd(10)} ${posture.description}`,
    )
    .join("\n");
}

// ============================================================
// Context Filtering
// ============================================================

function isGlobalContextPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const agentDir = getAgentDir().replace(/\\/g, "/");
  const homeAgents = join(homedir(), ".agents").replace(/\\/g, "/");
  return (
    normalized.startsWith(`${agentDir}/`) ||
    normalized.startsWith(`${homeAgents}/`)
  );
}

function shouldSuppressContext(
  filePath: string,
  policy: ContextPolicy,
): boolean {
  const global = isGlobalContextPath(filePath);
  return global ? policy.global === "suppress" : policy.project === "suppress";
}

const PROJECT_INSTRUCTIONS_PATTERN =
  /<project_instructions path="([^"]+)">\n[\s\S]*?\n<\/project_instructions>\n*/g;
const PROJECT_CONTEXT_PATTERN =
  /<project_context>([\s\S]*?)<\/project_context>\n?/;

type ContextFile = NonNullable<
  BuildSystemPromptOptions["contextFiles"]
>[number];

function sameStringArraySet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function renderedContextPaths(body: string): string[] {
  return Array.from(
    body.matchAll(PROJECT_INSTRUCTIONS_PATTERN),
    (match) => match[1],
  );
}

function contextFileOrder(
  body: string,
  contextFiles?: ContextFile[],
): string[] | undefined {
  if (!contextFiles || contextFiles.length === 0) return undefined;
  const renderedPaths = renderedContextPaths(body);
  const metadataPaths = contextFiles.map((file) => file.path);
  return sameStringArraySet(renderedPaths, metadataPaths)
    ? metadataPaths
    : undefined;
}

function filterRenderedProjectContextBody(
  body: string,
  policy: ContextPolicy,
  contextFiles?: ContextFile[],
): string {
  runtimeState.contextFilterReport = { kept: [], suppressed: [] };
  const reportOrder = contextFileOrder(body, contextFiles);

  const filteredBody = body.replace(
    PROJECT_INSTRUCTIONS_PATTERN,
    (entry: string, filePath: string) => {
      if (shouldSuppressContext(filePath, policy)) {
        runtimeState.contextFilterReport?.suppressed.push(filePath);
        return "";
      }

      const normalizedEntry = entry.endsWith("\n\n")
        ? entry
        : `${entry.trimEnd()}\n\n`;
      runtimeState.contextFilterReport?.kept.push(filePath);
      return normalizedEntry;
    },
  );

  if (!reportOrder) return filteredBody;

  runtimeState.contextFilterReport = { kept: [], suppressed: [] };
  for (const filePath of reportOrder) {
    if (shouldSuppressContext(filePath, policy))
      runtimeState.contextFilterReport.suppressed.push(filePath);
    else runtimeState.contextFilterReport.kept.push(filePath);
  }

  return filteredBody;
}

function filterProjectContext(
  systemPrompt: string,
  policy: ContextPolicy | undefined,
  options?: BuildSystemPromptOptions,
): string {
  runtimeState.contextFilterReport = undefined;
  if (
    !policy ||
    (policy.global !== "suppress" && policy.project !== "suppress")
  )
    return systemPrompt;

  if (!PROJECT_CONTEXT_PATTERN.test(systemPrompt)) {
    addConfigError(
      "contextPolicy: current system prompt has no project_context block; suppression skipped",
    );
    return systemPrompt;
  }

  return systemPrompt.replace(PROJECT_CONTEXT_PATTERN, (_full, body: string) => {
    const filteredBody = filterRenderedProjectContextBody(
      body,
      policy,
      options?.contextFiles,
    );
    if (!filteredBody.includes("<project_instructions")) return "";
    return `<project_context>${filteredBody}</project_context>\n`;
  });
}

function addPromptOverlay(
  systemPrompt: string,
  posture: PostureDefinition,
  options?: BuildSystemPromptOptions,
): string {
  const filtered = filterProjectContext(
    systemPrompt,
    posture.contextPolicy,
    options,
  );
  if (!posture.promptOverlay) return filtered;
  return `${filtered}\n\n<pi_posture id="${posture.id}">\n${posture.promptOverlay}\n</pi_posture>`;
}

// ============================================================
// Session & Posture Management
// ============================================================

function rememberPosture(pi: ExtensionAPI, id: string) {
  pi.appendEntry("posture", { id, timestamp: Date.now() });
}

function restorePostureFromSession(ctx: ExtensionContext): boolean {
  let found = false;
  runtimeState.activePostureId = "default";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "posture") {
      const data = entry.data as { id?: unknown } | undefined;
      const id =
        typeof data?.id === "string"
          ? resolvePostureId(data.id)
          : undefined;
      if (id) {
        runtimeState.activePostureId = id;
        found = true;
      }
    }
  }
  return found;
}

function postureLabel(posture: PostureDefinition): string {
  return `${posture.id} — ${posture.description}`;
}

async function selectPosture(
  ctx: ExtensionContext,
  title: string,
  postures: PostureDefinition[],
  timeoutMs?: number,
): Promise<PostureDefinition | undefined> {
  const labels = postures.map(postureLabel);
  const choice = await ctx.ui.select(title, labels, { timeout: timeoutMs });
  const index = labels.indexOf(choice ?? "");
  return index >= 0 ? postures[index] : undefined;
}

function switchPosture(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  posture: PostureDefinition,
) {
  runtimeState.activePostureId = posture.id;
  applyRuntime(pi, ctx, posture);
  rememberPosture(pi, posture.id);
  // Update per-posture runtime state
  const state = getOrCreatePostureRuntimeState(posture.id);
  state.lastActivatedAt = Date.now();
  state.activationCount += 1;
  persistPostureRuntimeState(pi);
  pi.sendMessage({
    customType: MESSAGE_TYPE,
    content: `Switched to ${postureSummary(posture)}`,
    display: true,
  });
}

function reloadAndReconcile(pi: ExtensionAPI, ctx: ExtensionContext) {
  registryLoadPostures(ctx.cwd);
  ensureActivePostureExists();
  applyRuntime(pi, ctx, activePosture());
}

// ============================================================
// Startup Picker
// ============================================================

function startupPickerShouldRun(
  reason: SessionStartReason,
  ctx: ExtensionContext,
  hasSessionPosture: boolean,
): boolean {
  if (reason === "reload") return false;
  const reg = getRegistryState();
  if (!reg.startupPicker.enabled) return false;
  if (!ctx.hasUI) return false;
  if (!reg.startupPicker.reasons.includes(reason)) return false;
  if (reg.startupPicker.onlyWhenUnset && hasSessionPosture) return false;
  return selectableStartupPostures().length > 0;
}

async function maybePromptStartupPosture(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: SessionStartReason,
  hasSessionPosture: boolean,
): Promise<boolean> {
  if (!startupPickerShouldRun(reason, ctx, hasSessionPosture)) return false;

  const reg = getRegistryState();
  const selected = await selectPosture(
    ctx,
    "Choose posture for this session",
    selectableStartupPostures(),
    reg.startupPicker.timeoutMs,
  );
  if (!selected) return false;

  switchPosture(pi, ctx, selected);
  return true;
}

// ============================================================
// Policy Hook Dispatch
// ============================================================

function activePolicyContext(): PolicyHookContext {
  const posture = activePosture();
  return {
    postureId: posture.id,
    runtimeState: getOrCreatePostureRuntimeState(posture.id),
  };
}

/**
 * Call a policy hook for the active posture if it exists and the policy
 * type is "custom". Returns the hook's result or undefined.
 */
function callPolicyHook<T extends (...args: any[]) => any>(
  hook: T | undefined,
  ...args: T extends (ctx: PolicyHookContext, ...rest: infer R) => any ? R : never
): ReturnType<T> | undefined {
  const posture = activePosture();
  const policy = posture.policy;
  if (!policy || policy.type !== "custom" || !hook) return undefined;
  return hook(activePolicyContext(), ...args);
}

function callPolicyHookAndPersist<T extends (...args: any[]) => any>(
  pi: ExtensionAPI,
  hook: T | undefined,
  ...args: T extends (ctx: PolicyHookContext, ...rest: infer R) => any ? R : never
): ReturnType<T> | undefined {
  const posture = activePosture();
  const policy = posture.policy;
  if (!policy || policy.type !== "custom" || !hook) return undefined;
  // Build context first — may create runtime state entry for this posture
  const ctx = activePolicyContext();
  const before = snapshotPostureRuntimeStates();
  const result = hook(ctx, ...args);
  const after = snapshotPostureRuntimeStates();
  if (before !== after) {
    persistPostureRuntimeState(pi);
  }
  return result;
}

// ============================================================
// Test Surface
// ============================================================

export const __testing = {
  // Registry functions
  resetRegistry,
  loadPostures: registryLoadPostures,
  resolvePostureId,
  selectableStartupPostures,
  getRegistryState,
  withStaticPosturePolicy,

  // Runtime state (mutable, for direct test manipulation)
  runtimeState,

  // Per-posture runtime state (mutable for test inspection)
  postureRuntimeStates,
  getOrCreatePostureRuntimeState,
  persistPostureRuntimeState,
  restorePostureRuntimeState,

  // Runtime functions
  activePosture,
  updatePostureUi,
  applyRuntime,
  addPromptOverlay,
  filterProjectContext,
  inspectText,
  restorePostureFromSession,
  startupPickerShouldRun,
  selectPosture,
  switchPosture,
  postureLabel,
  activePolicyContext,
  callPolicyHook,
  callPolicyHookAndPersist,
  snapshotPostureRuntimeStates,
  sanitizePostureRuntimeState,

  // Test helpers
  setPostureDefinition(id: string, def: PostureDefinition) {
    getRegistryState().postures.set(id, def);
  },
};

// ============================================================
// Pi Extension Entrypoint
// ============================================================

export default function piPosture(pi: ExtensionAPI) {
  resetRegistry();

  pi.registerMessageRenderer<string>(MESSAGE_TYPE, (message, _options, theme) => {
    return new Text(theme.fg("muted", String(message.content)), 0, 0);
  });

  pi.registerCommand("posture", {
    description: "Switch Pi harness posture: default, agent, assist, learn, review",
    getArgumentCompletions: (prefix) => {
      const reg = getRegistryState();
      const values = [
        "list",
        "status",
        "inspect",
        ...reg.postures.keys(),
        ...reg.aliases.keys(),
      ].sort();
      return values
        .filter((value) => value.startsWith(normalizeId(prefix)))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      reloadAndReconcile(pi, ctx);
      const arg = normalizeId(args);

      if (!arg) {
        if (!ctx.hasUI) {
          pi.sendMessage({
            customType: MESSAGE_TYPE,
            content: listText(),
            display: true,
          });
          return;
        }
        const reg = getRegistryState();
        const selected = await selectPosture(
          ctx,
          "Select posture",
          Array.from(reg.postures.values()),
        );
        if (!selected) return;
        switchPosture(pi, ctx, selected);
        return;
      }

      if (arg === "list") {
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: listText(),
          display: true,
        });
        return;
      }
      if (arg === "status") {
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: postureSummary(),
          display: true,
        });
        return;
      }
      if (arg === "inspect") {
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: inspectText(),
          display: true,
        });
        return;
      }

      const id = resolvePostureId(arg);
      if (!id) {
        const message = `Unknown posture: ${args.trim() || "(empty)"}. Try /posture list.`;
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: message,
          display: true,
        });
        return;
      }

      const reg = getRegistryState();
      switchPosture(pi, ctx, reg.postures.get(id)!);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    registryLoadPostures(ctx.cwd);
    ensureActivePostureExists();
    const hasSessionPosture = restorePostureFromSession(ctx);
    restorePostureRuntimeState(ctx);
    applyRuntime(pi, ctx, activePosture());
    await maybePromptStartupPosture(
      pi,
      ctx,
      event.reason,
      hasSessionPosture,
    );
    callPolicyHookAndPersist(pi, activePosture().policy?.onSessionStart);
    const reg = getRegistryState();
    if (reg.configErrors.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `pi-posture loaded with ${reg.configErrors.length} config error(s). Run /posture inspect.`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    updatePostureUi(pi, ctx);
    const posture = activePosture();
    const policy = posture.policy;

    // Start with existing overlay behavior
    let systemPrompt = event.systemPrompt;
    if (posture.id !== "default") {
      systemPrompt = addPromptOverlay(systemPrompt, posture, event.systemPromptOptions);
    }

    // Chain policy hook result if present
    if (policy?.type === "custom" && policy.onBeforeAgentStart) {
      const hookInput: PolicyBeforeAgentStartInput = {
        prompt: event.prompt,
        systemPrompt: event.systemPrompt,
      };
      const policyCtx = activePolicyContext();
      const before = snapshotPostureRuntimeStates();
      const hookResult = policy.onBeforeAgentStart(
        policyCtx,
        hookInput,
      );
      persistIfChanged(pi, before);
      if (hookResult?.systemPrompt) {
        systemPrompt = `${systemPrompt}\n${hookResult.systemPrompt}`;
      }
    }

    return { systemPrompt };
  });

  pi.on("input", (event) => {
    const policy = activePosture().policy;
    if (policy?.type !== "custom") return;
    const hook = policy.onInput;
    if (!hook) return;
    const hookInput: PolicyInputInput = { text: event.text };
    const policyCtx = activePolicyContext();
    const before = snapshotPostureRuntimeStates();
    const result = hook(policyCtx, hookInput);
    persistIfChanged(pi, before);
    if (!result) return;
    // Map policy hook result to Pi InputEventResult
    if (result.action === "handled") {
      return { action: "handled" as const };
    }
    if (result.action === "continue") {
      return { action: "continue" as const };
    }
    if (result.action === "transform") {
      return { action: "transform" as const, text: result.text ?? event.text };
    }
    return;
  });

  pi.on("tool_call", (event) => {
    const policy = activePosture().policy;
    if (policy?.type !== "custom") return;
    const hook = policy.onToolCall;
    if (!hook) return;
    const hookInput: PolicyToolCallInput = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    };
    const policyCtx = activePolicyContext();
    const before = snapshotPostureRuntimeStates();
    const result = hook(policyCtx, hookInput);
    persistIfChanged(pi, before);
    return result;
  });

  pi.on("tool_result", (event) => {
    const policy = activePosture().policy;
    if (policy?.type !== "custom") return;
    const hook = policy.onToolResult;
    if (!hook) return;
    const hookInput: PolicyToolResultInput = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    };
    const policyCtx = activePolicyContext();
    const before = snapshotPostureRuntimeStates();
    const result = hook(policyCtx, hookInput);
    persistIfChanged(pi, before);
    if (!result) return;
    // Patch content/isError into the result, preserving original content if not patched
    return {
      content: result.content !== undefined ? result.content : undefined,
      isError: result.isError,
    };
  });

  pi.on("turn_end", () => {
    callPolicyHookAndPersist(pi, activePosture().policy?.onTurnEnd);
  });

  pi.on("agent_end", () => {
    callPolicyHookAndPersist(pi, activePosture().policy?.onAgentEnd);
  });

  pi.on("session_shutdown", () => {
    callPolicyHookAndPersist(pi, activePosture().policy?.onSessionShutdown);
  });
}
