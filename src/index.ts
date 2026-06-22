import { getAgentDir, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  getOrCreatePostureRuntimeState,
  isValidTimestamp,
  persistIfChanged,
  persistPostureRuntimeState,
  postureRuntimeStates,
  restorePostureRuntimeState,
  runtimeState,
  sanitizePostureRuntimeState,
  snapshotPostureRuntimeStates,
} from "./posture-runtime-state.js";

import {
  addConfigError,
  CONFIG_DIR_NAME,
  getRegistryState,
  loadPostures as registryLoadPostures,
  normalizeId,
  resetRegistry,
  resolvePostureId,
  selectableStartupPostures,
  validatePromptMode,
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
  PromptMode,
  SessionStartReason,
} from "./posture-registry.js";

// ============================================================
// Constants
// ============================================================

const STATUS_KEY = "pi-posture";
const WIDGET_KEY = "pi-posture-widget";
const MESSAGE_TYPE = "pi-posture";
const PROMPT_MODE_ENTRY_TYPE = "pi-posture-prompt-mode";

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

function formatTimestamp(value: number | undefined): string {
  if (value === undefined || !isValidTimestamp(value)) return "—";
  return new Date(value).toISOString();
}

function stateText(activeId = runtimeState.activePostureId): string {
  const state = postureRuntimeStates.get(activeId) ?? { activationCount: 0 };
  const lines = [
    `posture: ${activeId}`,
    `  Activation count: ${state.activationCount}`,
  ];
  if (state.turnsInSession !== undefined) {
    lines.push(`  Turns this session: ${state.turnsInSession}`);
  }
  if (state.lastActivatedAt !== undefined) {
    lines.push(`  Last activated: ${formatTimestamp(state.lastActivatedAt)}`);
  }
  if (state.objective !== undefined) {
    lines.push(`  Objective: ${state.objective}`);
  }
  return lines.join("\n");
}

function isInitialPostureRuntimeState(state: PostureRuntimeState | undefined): boolean {
  return (
    state === undefined ||
    (state.activationCount === 0 &&
      state.lastActivatedAt === undefined &&
      state.turnsInSession === undefined &&
      state.objective === undefined)
  );
}

function clearRuntimeState(pi: ExtensionAPI): void {
  const id = runtimeState.activePostureId;
  const existing = postureRuntimeStates.get(id);
  if (isInitialPostureRuntimeState(existing)) return;
  const before = snapshotPostureRuntimeStates();
  postureRuntimeStates.set(id, { activationCount: 0 });
  persistIfChanged(pi, before);
}

function objectiveText(): string {
  const id = runtimeState.activePostureId;
  const objective = postureRuntimeStates.get(id)?.objective;
  if (!objective) return `posture: ${id}\n  (no objective set)`;
  return `posture: ${id}\n  Objective: ${objective}`;
}

function promptModeText(): string {
  return `prompt mode: ${runtimeState.promptMode}`;
}

function setPostureObjective(pi: ExtensionAPI, text: string): void {
  const before = snapshotPostureRuntimeStates();
  const state = getOrCreatePostureRuntimeState(runtimeState.activePostureId);
  state.objective = text;
  persistIfChanged(pi, before);
}

function clearPostureObjective(pi: ExtensionAPI): void {
  const state = postureRuntimeStates.get(runtimeState.activePostureId);
  if (!state?.objective) return;
  const before = snapshotPostureRuntimeStates();
  delete state.objective;
  persistIfChanged(pi, before);
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
    `Prompt mode: ${runtimeState.promptMode}`,
    `Context policy: ${contextSummary(posture.contextPolicy)}`,
    `Prompt overlay: ${posture.promptOverlay ? "yes" : "no"}`,
    `Active tools override: ${posture.activeTools ? posture.activeTools.join(", ") : "none"}`,
    `Thinking override: ${posture.thinking ?? "none"}`,
    `Interaction style: ${posture.interactionStyle ?? "none"}`,
    `Mutation policy: ${posture.mutationPolicy ?? "none"}`,
    `Answer policy: ${posture.answerPolicy ?? "none"}`,
    `Status label: ${posture.statusLabel ?? "none"}`,
    `Dynamic prompt: ${posture.dynamicPrompt ?? "none"}`,
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

function promptDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatReplacementTools(options?: BuildSystemPromptOptions): string {
  const selected = options?.selectedTools ?? [];
  if (selected.length === 0) return "(none)";
  return selected
    .map((name) => {
      const snippet = options?.toolSnippets?.[name];
      return snippet ? `- ${name}: ${snippet}` : `- ${name}`;
    })
    .join("\n");
}

function formatReplacementContext(
  posture: PostureDefinition,
  options?: BuildSystemPromptOptions,
  baseSystemPrompt?: string,
): string | undefined {
  if (baseSystemPrompt !== undefined) {
    const filtered = filterProjectContext(baseSystemPrompt, posture.contextPolicy, options);
    return filtered.match(PROJECT_CONTEXT_PATTERN)?.[0]?.trimEnd();
  }

  const contextFiles = options?.contextFiles ?? [];
  if (contextFiles.length === 0) return undefined;
  const kept = contextFiles.filter(
    (file) => !shouldSuppressContext(file.path, posture.contextPolicy ?? {}),
  );
  if (kept.length === 0) return undefined;
  return [
    "<project_context>",
    "Project-specific instructions and guidelines:",
    "",
    ...kept.map(
      (file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
    ),
    "</project_context>",
  ].join("\n");
}

function buildReplacementPrompt(
  posture: PostureDefinition,
  options?: BuildSystemPromptOptions,
  dynamicGuidance?: string,
  baseSystemPrompt?: string,
): string {
  const lines = [
    "You are operating inside Pi with pi-posture prompt mode set to replace.",
    "Pi's runtime, tools, session handling, and safety model are still active; this prompt replaces only the model-facing system instructions for this turn.",
    "",
    `Active posture: ${posture.id} (${posture.label})`,
    posture.description,
    "",
    "Available tools:",
    formatReplacementTools(options),
    "",
    "Guidelines:",
    "- Be concise in your responses",
    "- Show file paths clearly when working with files",
  ];

  if (posture.promptOverlay) {
    lines.push("", `<pi_posture id="${posture.id}">`, posture.promptOverlay, "</pi_posture>");
  }
  if (dynamicGuidance) {
    lines.push("", dynamicGuidance);
  }
  const context = formatReplacementContext(posture, options, baseSystemPrompt);
  if (context) {
    lines.push("", context);
  }
  lines.push("", `Current date: ${promptDate()}`);
  lines.push(`Current working directory: ${(options?.cwd ?? "").replace(/\\/g, "/")}`);
  return lines.join("\n");
}

// ============================================================
// Session & Posture Management
// ============================================================

function rememberPosture(pi: ExtensionAPI, id: string) {
  pi.appendEntry("posture", { id, timestamp: Date.now() });
}

function rememberPromptMode(pi: ExtensionAPI, mode = runtimeState.promptMode): void {
  pi.appendEntry(PROMPT_MODE_ENTRY_TYPE, { mode });
}

function restorePromptModeFromSession(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== PROMPT_MODE_ENTRY_TYPE) continue;
    const data = entry.data as { mode?: unknown } | undefined;
    if (validatePromptMode(data?.mode)) {
      runtimeState.promptMode = data.mode;
      return true;
    }
  }
  return false;
}

function setPromptMode(pi: ExtensionAPI, mode: PromptMode): void {
  runtimeState.promptMode = mode;
  rememberPromptMode(pi, mode);
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
  const before = snapshotPostureRuntimeStates();

  // --- Lifecycle hooks (before changing activePostureId) ---
  const prevPosture = activePosture();
  const prevId = runtimeState.activePostureId;

  // Previous posture onDeactivate
  if (prevId !== posture.id && prevPosture.policy?.type === "custom" && prevPosture.policy.onDeactivate) {
    const prevState = postureRuntimeStates.get(prevId);
    if (prevState) {
      prevPosture.policy.onDeactivate(prevState);
    }
  }

  // Target posture onBeforeActivate
  const targetState = getOrCreatePostureRuntimeState(posture.id);
  if (posture.policy?.type === "custom" && posture.policy.onBeforeActivate) {
    const result = posture.policy.onBeforeActivate(targetState);
    if (result !== undefined) {
      Object.assign(targetState, result);
    }
  }

  // --- Activation ---
  runtimeState.activePostureId = posture.id;
  targetState.lastActivatedAt = Date.now();
  targetState.activationCount += 1;

  // Target posture onActivate
  if (posture.policy?.type === "custom" && posture.policy.onActivate) {
    posture.policy.onActivate(targetState);
  }

  // --- Apply runtime and persist ---
  applyRuntime(pi, ctx, posture);
  rememberPosture(pi, posture.id);

  // Persist if any lifecycle hook, activation metadata, or UI hook changed state
  persistIfChanged(pi, before);

  pi.sendMessage({
    customType: MESSAGE_TYPE,
    content: `Switched to ${postureSummary(posture)}`,
    display: true,
  });
}

type CompactionResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
};

type SessionSetupTarget = {
  appendMessage(message: unknown): void;
  appendCustomMessageEntry(customType: string, content: unknown, display: boolean, details?: unknown): void;
  appendCustomEntry(customType: string, data?: unknown): void;
};

function hasConversationContext(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) =>
    entry.type === "message" ||
    entry.type === "custom_message" ||
    entry.type === "compaction" ||
    entry.type === "branch_summary"
  );
}

function compactForPostureSwitch(ctx: ExtensionContext, postureId: string): Promise<CompactionResult> {
  return new Promise((resolve, reject) => {
    ctx.compact({
      customInstructions: `Switching posture to ${postureId}. Summarize the current session so the replacement session can continue with the new posture. Preserve goals, decisions, files, blockers, and next steps.`,
      onComplete: resolve,
      onError: reject,
    });
  });
}

function appendRuntimeStateEntry(target: SessionSetupTarget): void {
  const states: Record<string, PostureRuntimeState> = {};
  for (const [id, state] of postureRuntimeStates) {
    states[id] = { ...state };
  }
  target.appendCustomEntry("pi-posture-state", { states });
}

type CopyableSessionEntry = {
  type: string;
  id?: string;
  message?: unknown;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
};

function keptEntriesAfterCompaction(branch: CopyableSessionEntry[], firstKeptEntryId: string): CopyableSessionEntry[] {
  const firstKeptIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) return [];
  return branch.slice(firstKeptIndex).filter((entry) =>
    entry.type === "message" || entry.type === "custom_message"
  );
}

function copyKeptEntry(target: SessionSetupTarget, entry: CopyableSessionEntry): void {
  if (entry.type === "message" && entry.message !== undefined) {
    target.appendMessage(entry.message);
    return;
  }
  if (entry.type === "custom_message" && entry.customType && entry.content !== undefined) {
    target.appendCustomMessageEntry(entry.customType, entry.content, entry.display ?? true, entry.details);
  }
}

function seedReplacementSession(
  target: SessionSetupTarget,
  compaction: CompactionResult,
  branchBeforeCompaction: CopyableSessionEntry[],
): void {
  target.appendCustomMessageEntry(
    "pi-posture-handoff-summary",
    `Compacted summary from previous session:\n\n${compaction.summary}`,
    true,
    {
      firstKeptEntryId: compaction.firstKeptEntryId,
      tokensBefore: compaction.tokensBefore,
      details: compaction.details,
    },
  );
  for (const entry of keptEntriesAfterCompaction(branchBeforeCompaction, compaction.firstKeptEntryId)) {
    copyKeptEntry(target, entry);
  }
  target.appendCustomEntry("posture", { id: runtimeState.activePostureId, timestamp: Date.now() });
  target.appendCustomEntry(PROMPT_MODE_ENTRY_TYPE, { mode: runtimeState.promptMode });
  appendRuntimeStateEntry(target);
}

async function switchPostureWithReplacementSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext & { newSession?: (options: any) => Promise<{ cancelled: boolean }> },
  posture: PostureDefinition,
): Promise<boolean> {
  if (!ctx.newSession || !hasConversationContext(ctx)) return false;

  const branchBeforeCompaction = ctx.sessionManager.getBranch() as CopyableSessionEntry[];
  switchPosture(pi, ctx, posture);
  rememberPromptMode(pi);

  try {
    const compaction = await compactForPostureSwitch(ctx, posture.id);
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({
      parentSession,
      setup: (sessionManager: SessionSetupTarget) => {
        seedReplacementSession(sessionManager, compaction, branchBeforeCompaction);
      },
      withSession: async (replacementCtx: { reload?: () => Promise<void>; ui?: { notify?: (message: string, type?: string) => void } }) => {
        replacementCtx.ui?.notify?.(`Switched to ${postureSummary(posture)} in a compacted replacement session.`, "info");
        await replacementCtx.reload?.();
      },
    });

    if (result.cancelled) {
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: "Posture replacement session cancelled; posture remains switched in the current session.",
        display: true,
      });
    }
    return true;
  } catch (error) {
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: `Could not create compacted replacement session (${error instanceof Error ? error.message : String(error)}); posture remains switched in the current session.`,
      display: true,
    });
    return true;
  }
}

function shouldLoadProjectConfig(ctx: ExtensionContext): boolean {
  return (ctx as ExtensionContext & { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false;
}

function reloadAndReconcile(pi: ExtensionAPI, ctx: ExtensionContext) {
  registryLoadPostures(ctx.cwd, { loadProjectConfig: shouldLoadProjectConfig(ctx) });
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

type PolicyHookFunction = (ctx: PolicyHookContext, ...args: unknown[]) => unknown;

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
function callPolicyHook(
  hook: PolicyHookFunction | undefined,
  ...args: unknown[]
): unknown {
  const posture = activePosture();
  const policy = posture.policy;
  if (!policy || policy.type !== "custom" || !hook) return undefined;
  return hook(activePolicyContext(), ...args);
}

function callPolicyHookAndPersist(
  pi: ExtensionAPI,
  hook: PolicyHookFunction | undefined,
  ...args: unknown[]
): unknown {
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
  // Constants
  CONFIG_DIR_NAME,

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
  stateText,
  clearRuntimeState,
  objectiveText,
  setPostureObjective,
  clearPostureObjective,

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
    description: "Switch Pi harness posture: default, orchestrator, assist, learn, review",
    getArgumentCompletions: (prefix) => {
      const reg = getRegistryState();
      const values = [
        "list",
        "status",
        "inspect",
        "state",
        "prompt-mode",
        "prompt-mode overlay",
        "prompt-mode replace",
        "prompt-mode status",
        "clear-state",
        "objective",
        ...reg.postures.keys(),
        ...reg.aliases.keys(),
      ].sort();
      return values
        .filter((value) => value.startsWith(normalizeId(prefix)))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      reloadAndReconcile(pi, ctx);
      const trimmed = args.trim();
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
        if (await switchPostureWithReplacementSession(pi, ctx, selected)) {
          return;
        }
        switchPosture(pi, ctx, selected);
        return;
      }

      if (arg === "prompt-mode" || arg.startsWith("prompt-mode ")) {
        const modeArg = normalizeId(trimmed.slice("prompt-mode".length));
        if (!modeArg || modeArg === "status") {
          pi.sendMessage({
            customType: MESSAGE_TYPE,
            content: promptModeText(),
            display: true,
          });
          return;
        }
        if (!validatePromptMode(modeArg)) {
          pi.sendMessage({
            customType: MESSAGE_TYPE,
            content: `Unknown prompt mode: ${modeArg}. Try overlay or replace.`,
            display: true,
          });
          return;
        }
        setPromptMode(pi, modeArg);
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: `Switched to ${promptModeText()}`,
          display: true,
        });
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
      if (arg === "state") {
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: stateText(),
          display: true,
        });
        return;
      }
      if (arg === "clear-state") {
        clearRuntimeState(pi);
        updatePostureUi(pi, ctx);
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: `Cleared runtime state for posture: ${runtimeState.activePostureId}`,
          display: true,
        });
        return;
      }
      if (arg === "objective" || arg.startsWith("objective ")) {
        const rest = trimmed.slice("objective".length).trim();
        const restCommand = normalizeId(rest);
        if (!rest || restCommand === "show") {
          pi.sendMessage({
            customType: MESSAGE_TYPE,
            content: objectiveText(),
            display: true,
          });
          return;
        }
        if (restCommand === "clear" || restCommand === "--clear") {
          clearPostureObjective(pi);
          updatePostureUi(pi, ctx);
          pi.sendMessage({
            customType: MESSAGE_TYPE,
            content: `Objective cleared for posture: ${runtimeState.activePostureId}`,
            display: true,
          });
          return;
        }
        setPostureObjective(pi, rest);
        updatePostureUi(pi, ctx);
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: `Objective set for posture: ${runtimeState.activePostureId}`,
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
      const posture = reg.postures.get(id)!;
      if (await switchPostureWithReplacementSession(pi, ctx, posture)) {
        return;
      }
      switchPosture(pi, ctx, posture);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    registryLoadPostures(ctx.cwd, { loadProjectConfig: shouldLoadProjectConfig(ctx) });
    runtimeState.promptMode = getRegistryState().promptMode;
    restorePromptModeFromSession(ctx);
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
    let dynamicGuidance: string | undefined;

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
      dynamicGuidance = hookResult?.systemPrompt;
    }

    let systemPrompt = event.systemPrompt;
    if (runtimeState.promptMode === "replace") {
      if (posture.id === "default" && !dynamicGuidance) return undefined;
      systemPrompt = buildReplacementPrompt(posture, event.systemPromptOptions, dynamicGuidance, event.systemPrompt);
    } else {
      // Existing overlay behavior
      if (posture.id !== "default") {
        systemPrompt = addPromptOverlay(systemPrompt, posture, event.systemPromptOptions);
      }
      if (dynamicGuidance) {
        systemPrompt = `${systemPrompt}\n${dynamicGuidance}`;
      }
    }

    // Only return { systemPrompt } if the prompt was actually modified
    if (systemPrompt !== event.systemPrompt) {
      return { systemPrompt };
    }
    return undefined;
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
    // Patch only fields explicitly returned by the policy hook.
    const patch: { content?: typeof result.content; isError?: boolean } = {};
    if (result.content !== undefined) patch.content = result.content;
    if (result.isError !== undefined) patch.isError = result.isError;
    return patch;
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
