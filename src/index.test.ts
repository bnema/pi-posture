import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piPosture, { __testing } from "./index.js";
import { BUILTIN_POSTURES, buildPostureRegistry } from "./posture-registry.js";

function tempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-posture-"));
  mkdirSync(join(cwd, ".pi"));
  return cwd;
}

function writeProjectConfig(cwd: string, config: unknown) {
  writeFileSync(join(cwd, ".pi", "postures.json"), JSON.stringify(config), "utf8");
}

function projectContext(path: string, content: string) {
  return `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
}

function fakeExtension(cwd: string, options: { hasUI?: boolean; selectChoice?: string; branch?: any[] } = {}) {
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();
  const messages: string[] = [];
  const appended: Array<{ customType: string; data?: unknown }> = [];
  const selectCalls: Array<{ title: string; choices: string[]; options?: unknown }> = [];
  const widgetCalls: Array<{ key: string; content: string[] | undefined }> = [];
  const pi = {
    registerMessageRenderer() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data?: unknown) {
      appended.push({ customType, data });
    },
    sendMessage(message: { content: string }) {
      messages.push(message.content);
    },
    getAllTools() {
      return [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }];
    },
    activeTools: ["read", "bash", "edit", "write"],
    getActiveTools() {
      return this.activeTools;
    },
    setActiveTools(tools: string[]) {
      this.activeTools = tools;
    },
    thinking: "medium",
    getThinkingLevel() {
      return this.thinking;
    },
    setThinkingLevel(level: string) {
      this.thinking = level;
    },
  };
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? false,
    ui: {
      notify() {},
      setStatus() {},
      setWidget(key: string, content: string[] | undefined) {
        widgetCalls.push({ key, content });
      },
      select: async (title: string, choices: string[], selectOptions?: unknown) => {
        selectCalls.push({ title, choices, options: selectOptions });
        return options.selectChoice;
      },
    },
    sessionManager: { getBranch: () => options.branch ?? [] },
  };

  piPosture(pi as any);
  if (!commandHandler) throw new Error("/posture command was not registered");
  return {
    pi,
    ctx,
    messages,
    appended,
    selectCalls,
    widgetCalls,
    run: (args: string) => commandHandler!(args, ctx),
    emit: async (event: string, payload: any): Promise<any[]> => {
      const results: any[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results;
    },
  };
}

describe("pi-posture internals", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempProject();
    __testing.resetRegistry();
    __testing.runtimeState.activePostureId = "default";
    __testing.runtimeState.toolSnapshot = undefined;
    __testing.runtimeState.appliedToolsOverride = undefined;
    __testing.runtimeState.thinkingSnapshot = undefined;
    __testing.runtimeState.appliedThinkingOverride = undefined;
    __testing.runtimeState.contextFilterReport = undefined;
    __testing.postureRuntimeStates.clear();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  // ============================================================
  // Phase 1 re-review: behavior regression tests
  // ============================================================

  it("preserves parse/root config file errors through loadPostures", () => {
    writeFileSync(join(cwd, ".pi", "postures.json"), "not valid json", "utf8");
    __testing.loadPostures(cwd);
    const text = __testing.inspectText();
    expect(text).toContain("postures.json: Unexpected token");
    expect(text).toContain("Config errors:");
  });

  it("preserves non-object root config file error through loadPostures", () => {
    writeFileSync(join(cwd, ".pi", "postures.json"), JSON.stringify([]), "utf8");
    __testing.loadPostures(cwd);
    const text = __testing.inspectText();
    expect(text).toContain("postures.json: root must be an object");
    expect(text).toContain("Config errors:");
  });

  it("preserves parse error alongside builder validation errors", () => {
    writeFileSync(join(cwd, ".pi", "postures.json"), "{ invalid json", "utf8");
    __testing.loadPostures(cwd);
    const text = __testing.inspectText();
    expect(text).toContain("postures.json:");
    expect(text).toContain("Config errors:");
  });

  it("resolves built-in aliases", () => {
    expect(__testing.resolvePostureId("vanilla")).toBe("default");
    expect(__testing.resolvePostureId("teacher")).toBe("learn");
    expect(__testing.resolvePostureId("pair")).toBe("assist");
  });

  it("loads project config overrides and reports validation errors", () => {
    writeProjectConfig(cwd, {
      postures: {
        learn: { description: "Project learn", thinking: "medium" },
        broken: { thinking: "huge" },
      },
      aliases: { socratic: "learn" },
    });

    __testing.loadPostures(cwd);

    expect(__testing.resolvePostureId("socratic")).toBe("learn");
    __testing.runtimeState.activePostureId = "learn";
    expect(__testing.inspectText()).toContain("Project learn");
    expect(__testing.inspectText()).toContain("project config.postures.broken.thinking: invalid thinking level");
  });

  it("adds prompt overlays for non-default postures but not default", () => {
    __testing.runtimeState.activePostureId = "learn";
    const learnPrompt = __testing.addPromptOverlay("base", __testing.activePosture());
    expect(learnPrompt).toContain('<pi_posture id="learn">');

    __testing.runtimeState.activePostureId = "default";
    const defaultPrompt = __testing.addPromptOverlay("base", __testing.activePosture());
    expect(defaultPrompt).toBe("base");
  });

  it("filters only existing rendered project instructions and does not reconstruct missing context", () => {
    const globalPath = `${getAgentDir()}/AGENTS.md`;
    const prompt = `<project_context>\n\nProject-specific instructions and guidelines:\n\n${projectContext(globalPath, "global")}${projectContext("/repo/AGENTS.md", "project")}</project_context>\nOTHER`;

    const filtered = __testing.filterProjectContext(prompt, { global: "suppress", project: "inherit" });

    expect(filtered).not.toContain("global");
    expect(filtered).toContain("project");
    expect(__testing.runtimeState.contextFilterReport?.suppressed).toEqual([globalPath]);

    const noContext = __testing.filterProjectContext("NO_CONTEXT", { global: "suppress", project: "suppress" });
    expect(noContext).toBe("NO_CONTEXT");
    expect(noContext).not.toContain("<project_context>");
  });

  it("filters rendered context using structured context file metadata", () => {
    const globalPath = `${getAgentDir()}/AGENTS.md`;
    const projectPath = "/repo/[special]/AGENTS.md";
    const prompt = `<project_context>\n\nProject-specific instructions and guidelines:\n\n${projectContext(globalPath, "global")}${projectContext(projectPath, "project")}</project_context>\nBASE`;

    const filtered = __testing.addPromptOverlay(
      prompt,
      {
        id: "quiet",
        label: "Quiet",
        description: "Quiet",
        promptOverlay: "overlay",
        contextPolicy: { global: "suppress", project: "inherit" },
      },
      {
        cwd: "/repo",
        contextFiles: [
          { path: globalPath, content: "global" },
          { path: projectPath, content: "project" },
        ],
      },
    );

    expect(filtered).not.toContain(projectContext(globalPath, "global"));
    expect(filtered).toContain(projectContext(projectPath, "project"));
    expect(filtered).toContain('<pi_posture id="quiet">');
    expect(__testing.runtimeState.contextFilterReport).toEqual({ kept: [projectPath], suppressed: [globalPath] });
  });

  it("falls back to rendered context filtering when structured metadata contains paths missing from the prompt", () => {
    const globalPath = `${getAgentDir()}/AGENTS.md`;
    const projectPath = "/repo/AGENTS.md";
    const missingPath = "/repo/missing/AGENTS.md";
    const prompt = `<project_context>\n\nProject-specific instructions and guidelines:\n\n${projectContext(globalPath, "global")}${projectContext(projectPath, "project")}</project_context>\nBASE`;

    const filtered = __testing.addPromptOverlay(
      prompt,
      {
        id: "quiet",
        label: "Quiet",
        description: "Quiet",
        promptOverlay: "overlay",
        contextPolicy: { global: "suppress", project: "inherit" },
      },
      {
        cwd: "/repo",
        contextFiles: [
          { path: globalPath, content: "global" },
          { path: projectPath, content: "project" },
          { path: missingPath, content: "missing" },
        ],
      },
    );

    expect(filtered).not.toContain(projectContext(globalPath, "global"));
    expect(filtered).toContain(projectContext(projectPath, "project"));
    expect(__testing.runtimeState.contextFilterReport).toEqual({ kept: [projectPath], suppressed: [globalPath] });
  });

  it("falls back to rendered context filtering when the prompt contains context missing from structured metadata", () => {
    const globalPath = `${getAgentDir()}/AGENTS.md`;
    const projectPath = "/repo/AGENTS.md";
    const prompt = `<project_context>\n\nProject-specific instructions and guidelines:\n\n${projectContext(globalPath, "global")}${projectContext(projectPath, "project")}</project_context>\nBASE`;

    const filtered = __testing.addPromptOverlay(
      prompt,
      {
        id: "quiet",
        label: "Quiet",
        description: "Quiet",
        promptOverlay: "overlay",
        contextPolicy: { global: "suppress", project: "inherit" },
      },
      {
        cwd: "/repo",
        contextFiles: [{ path: projectPath, content: "project" }],
      },
    );

    expect(filtered).not.toContain(projectContext(globalPath, "global"));
    expect(filtered).toContain(projectContext(projectPath, "project"));
    expect(__testing.runtimeState.contextFilterReport).toEqual({ kept: [projectPath], suppressed: [globalPath] });
  });

  it("falls back to rendered context filtering when duplicate rendered paths diverge from metadata", () => {
    const globalPath = `${getAgentDir()}/AGENTS.md`;
    const projectPath = "/repo/AGENTS.md";
    const missingPath = "/repo/missing/AGENTS.md";
    const prompt = `<project_context>\n\nProject-specific instructions and guidelines:\n\n${projectContext(globalPath, "global")}${projectContext(projectPath, "project-one")}${projectContext(projectPath, "project-two")}</project_context>\nBASE`;

    const filtered = __testing.addPromptOverlay(
      prompt,
      {
        id: "quiet",
        label: "Quiet",
        description: "Quiet",
        promptOverlay: "overlay",
        contextPolicy: { global: "suppress", project: "inherit" },
      },
      {
        cwd: "/repo",
        contextFiles: [
          { path: globalPath, content: "global" },
          { path: projectPath, content: "project" },
          { path: missingPath, content: "missing" },
        ],
      },
    );

    expect(filtered).not.toContain(projectContext(globalPath, "global"));
    expect(filtered).toContain(projectContext(projectPath, "project-one"));
    expect(filtered).toContain(projectContext(projectPath, "project-two"));
    expect(__testing.runtimeState.contextFilterReport).toEqual({ kept: [projectPath, projectPath], suppressed: [globalPath] });
  });

  it("passes systemPromptOptions contextFiles through before_agent_start", async () => {
    const firstProjectPath = join(cwd, "first/AGENTS.md");
    const secondProjectPath = join(cwd, "second/AGENTS.md");
    writeProjectConfig(cwd, {
      postures: {
        quiet: {
          description: "Quiet",
          promptOverlay: "overlay",
          contextPolicy: { project: "suppress" },
        },
      },
    });
    const harness = fakeExtension(cwd);
    await harness.emit("session_start", { reason: "startup" });
    await harness.run("quiet");

    const prompt = `<project_context>\n\nProject-specific instructions and guidelines:\n\n${projectContext(firstProjectPath, "first")}${projectContext(secondProjectPath, "second")}</project_context>\nBASE`;
    const results = await harness.emit("before_agent_start", {
      systemPrompt: prompt,
      systemPromptOptions: {
        cwd,
        contextFiles: [
          { path: secondProjectPath, content: "second" },
          { path: firstProjectPath, content: "first" },
        ],
      },
    });

    const result = results.find((entry): entry is { systemPrompt: string } => Boolean(entry && "systemPrompt" in entry));
    expect(result?.systemPrompt).not.toContain("<project_context>");
    expect(result?.systemPrompt).toContain('<pi_posture id="quiet">');
    expect(__testing.runtimeState.contextFilterReport?.suppressed).toEqual([secondProjectPath, firstProjectPath]);
  });

  it("restores tool and thinking overrides only when current values still match plugin-applied overrides", () => {
    const pi = {
      activeTools: ["read", "bash", "edit", "write"],
      getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
      getActiveTools() { return this.activeTools; },
      setActiveTools(tools: string[]) { this.activeTools = tools; },
      thinking: "medium",
      getThinkingLevel() { return this.thinking; },
      setThinkingLevel(level: string) { this.thinking = level; },
    };
    const ctx = { ui: { setStatus() {}, setWidget() {} } };
    const posture = {
      id: "limited",
      label: "Limited",
      description: "Limited",
      activeTools: ["read"],
      thinking: "low" as const,
    };

    __testing.applyRuntime(pi as any, ctx as any, posture);
    expect(pi.activeTools).toEqual(["read"]);
    expect(pi.thinking).toBe("low");

    pi.setActiveTools(["read", "bash"]);
    pi.setThinkingLevel("high");
    __testing.applyRuntime(pi as any, ctx as any, { id: "default", label: "Default", description: "Default" });

    expect(pi.activeTools).toEqual(["read", "bash"]);
    expect(pi.thinking).toBe("high");
  });

  it("reconciles stale custom runtime overrides when config reload removes the active posture", async () => {
    writeProjectConfig(cwd, {
      postures: {
        limited: {
          label: "Limited",
          description: "Limited",
          activeTools: ["read"],
          thinking: "low",
        },
      },
    });
    const harness = fakeExtension(cwd);

    await harness.run("limited");
    expect(harness.pi.activeTools).toEqual(["read"]);
    expect(harness.pi.thinking).toBe("low");

    writeProjectConfig(cwd, { postures: {} });
    await harness.run("status");

    expect(harness.pi.activeTools).toEqual(["read", "bash", "edit", "write"]);
    expect(harness.pi.thinking).toBe("medium");
    expect(harness.messages.at(-1)).toBe("posture: default");
  });

  it("loads startup picker config and exposes selectable postures", () => {
    writeProjectConfig(cwd, {
      startupPicker: {
        enabled: true,
        include: ["learn", "pair"],
        reasons: ["startup", "new"],
        timeoutMs: 2500,
      },
    });

    __testing.loadPostures(cwd);

    const registry = __testing.getRegistryState();
    expect(registry.startupPicker.enabled).toBe(true);
    expect(registry.startupPicker.reasons).toEqual(["startup", "new"]);
    expect(registry.startupPicker.timeoutMs).toBe(2500);
    expect(__testing.selectableStartupPostures().map((posture) => posture.id)).toEqual(["learn", "assist"]);
  });

  it("reports invalid startup picker entries and deduplicates alias targets", () => {
    writeProjectConfig(cwd, {
      startupPicker: {
        enabled: true,
        include: ["learn", "teacher", "missing", "", 123],
        reasons: ["startup", "reload", 123],
      },
    });

    __testing.loadPostures(cwd);

    expect(__testing.selectableStartupPostures().map((posture) => posture.id)).toEqual(["learn"]);
    expect(__testing.inspectText()).toContain('startupPicker.include: duplicate posture "learn" from "teacher"');
    expect(__testing.inspectText()).toContain('startupPicker.include: unknown posture or alias "missing"');
    expect(__testing.inspectText()).toContain("project config.startupPicker.include[3]: must not be empty");
    expect(__testing.inspectText()).toContain("project config.startupPicker.include[4]: must be a string");
    expect(__testing.inspectText()).toContain('project config.startupPicker.reasons: invalid reason "reload"');
    expect(__testing.inspectText()).toContain("project config.startupPicker.reasons[2]: must be a string");
  });

  it("does not run startup picker without UI or when session already has a posture", () => {
    writeProjectConfig(cwd, { startupPicker: true });
    __testing.loadPostures(cwd);

    const noUi = { hasUI: false };
    expect(__testing.startupPickerShouldRun("startup", noUi as any, false)).toBe(false);

    const withUi = { hasUI: true };
    expect(__testing.startupPickerShouldRun("startup", withUi as any, true)).toBe(false);
    expect(__testing.startupPickerShouldRun("reload", withUi as any, false)).toBe(false);
    expect(__testing.startupPickerShouldRun("startup", withUi as any, false)).toBe(true);
  });

  it("session_start never opens the picker on reload or non-UI sessions", async () => {
    writeProjectConfig(cwd, { startupPicker: { enabled: true, reasons: ["reload", "startup"] } });
    const reloadHarness = fakeExtension(cwd, { hasUI: true, selectChoice: "learn — Tutor posture for learning while still using the full toolset for accurate guidance." });
    await reloadHarness.emit("session_start", { type: "session_start", reason: "reload" });
    expect(reloadHarness.selectCalls).toHaveLength(0);
    expect(reloadHarness.appended).toEqual([]);

    const noUiHarness = fakeExtension(cwd, { hasUI: false, selectChoice: "learn — Tutor posture for learning while still using the full toolset for accurate guidance." });
    await noUiHarness.emit("session_start", { type: "session_start", reason: "startup" });
    expect(noUiHarness.selectCalls).toHaveLength(0);
    expect(noUiHarness.appended).toEqual([]);
  });

  it("startup picker applies and persists the selected posture", async () => {
    writeProjectConfig(cwd, { startupPicker: { enabled: true, include: ["default", "learn"], timeoutMs: 1234 } });
    const harness = fakeExtension(cwd, { hasUI: true, selectChoice: "learn — Tutor posture for learning while still using the full toolset for accurate guidance." });

    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    expect(harness.selectCalls).toEqual([
      {
        title: "Choose posture for this session",
        choices: [
          "default — Plugin-off behavior. Pi runs normally with no posture overlay.",
          "learn — Tutor posture for learning while still using the full toolset for accurate guidance.",
        ],
        options: { timeout: 1234 },
      },
    ]);
    expect(__testing.runtimeState.activePostureId).toBe("learn");
    expect(harness.appended).toContainEqual({ customType: "posture", data: expect.objectContaining({ id: "learn" }) });
    expect(harness.messages.at(-1)).toBe("Switched to posture: learn");
  });

  it("startup picker cancel or unknown selection leaves posture unchanged", async () => {
    writeProjectConfig(cwd, { startupPicker: { enabled: true, include: ["learn"] } });

    const cancelHarness = fakeExtension(cwd, { hasUI: true });
    await cancelHarness.emit("session_start", { type: "session_start", reason: "startup" });
    expect(__testing.runtimeState.activePostureId).toBe("default");
    expect(cancelHarness.appended).toEqual([]);
    expect(cancelHarness.messages).toEqual([]);

    const unknownHarness = fakeExtension(cwd, { hasUI: true, selectChoice: "missing" });
    await unknownHarness.emit("session_start", { type: "session_start", reason: "startup" });
    expect(__testing.runtimeState.activePostureId).toBe("default");
    expect(unknownHarness.appended).toEqual([]);
    expect(unknownHarness.messages).toEqual([]);
  });

  it("session restore detects existing posture entries and skips startup picker", async () => {
    writeProjectConfig(cwd, { startupPicker: true });
    const branch = [{ type: "custom", customType: "posture", data: { id: "review" } }];
    const harness = fakeExtension(cwd, { hasUI: true, selectChoice: "learn — Tutor posture for learning while still using the full toolset for accurate guidance.", branch });

    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    expect(__testing.runtimeState.activePostureId).toBe("review");
    expect(harness.selectCalls).toHaveLength(0);
    expect(harness.appended).toEqual([]);
    expect(harness.messages).toEqual([]);
  });

  it("onlyWhenUnset false prompts even when the session branch already has a posture", async () => {
    writeProjectConfig(cwd, { startupPicker: { enabled: true, onlyWhenUnset: false, include: ["learn"] } });
    const branch = [{ type: "custom", customType: "posture", data: { id: "review" } }];
    const harness = fakeExtension(cwd, { hasUI: true, selectChoice: "learn — Tutor posture for learning while still using the full toolset for accurate guidance.", branch });

    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    expect(harness.selectCalls).toHaveLength(1);
    expect(__testing.runtimeState.activePostureId).toBe("learn");
    expect(harness.appended).toContainEqual({ customType: "posture", data: expect.objectContaining({ id: "learn" }) });
  });

  // ============================================================
  // Policy adapter tests (Phase 1 — static compat shim)
  // ============================================================

  it("adds static policy to built-in postures after registry reset", () => {
    __testing.resetRegistry();
    const reg = __testing.getRegistryState();
    for (const posture of reg.postures.values()) {
      expect(posture.policy).toBeDefined();
      expect(posture.policy!.type).toBe("static");
    }
  });

  it("adds static policy to custom config postures", () => {
    writeProjectConfig(cwd, {
      postures: {
        custom: { description: "Custom posture from config" },
      },
    });
    __testing.loadPostures(cwd);
    const posture = __testing.getRegistryState().postures.get("custom")!;
    expect(posture.policy).toBeDefined();
    expect(posture.policy!.type).toBe("static");
  });

  it("preserves an explicitly supplied policy object through the adapter", () => {
    const customPolicy = { type: "custom" as const };
    const adapted = __testing.withStaticPosturePolicy({
      id: "custom-policy",
      label: "Custom Policy",
      description: "Has a custom policy",
      policy: customPolicy,
    });
    // Reference equality — the adapter returns a shallow copy preserving the same object
    expect(adapted.policy).toBe(customPolicy);
    expect(adapted.policy!.type).toBe("custom");
  });

  it("prompt overlay behavior remains unchanged after adapter integration", () => {
    __testing.runtimeState.activePostureId = "learn";
    const learnPrompt = __testing.addPromptOverlay("base", __testing.activePosture());
    expect(learnPrompt).toContain('<pi_posture id="learn">');

    __testing.runtimeState.activePostureId = "default";
    const defaultPrompt = __testing.addPromptOverlay("base", __testing.activePosture());
    expect(defaultPrompt).toBe("base");
  });

  // ============================================================
  // Foundation coverage (Phase 1 Task 4)
  // ============================================================

  it("preserves built-in prompt overlay when project config only overrides description and thinking", () => {
    writeProjectConfig(cwd, {
      postures: {
        learn: { description: "Custom learn", thinking: "low" },
      },
    });
    __testing.loadPostures(cwd);
    const learn = __testing.getRegistryState().postures.get("learn")!;
    expect(learn.description).toBe("Custom learn");
    expect(learn.thinking).toBe("low");
    const builtIn = BUILTIN_POSTURES.find((p) => p.id === "learn")!;
    expect(learn.promptOverlay).toBe(builtIn.promptOverlay);
  });

  it("inspect output lists aliases for active posture", () => {
    writeProjectConfig(cwd, {
      aliases: { socratic: "learn" },
    });
    __testing.loadPostures(cwd);
    __testing.runtimeState.activePostureId = "learn";
    expect(__testing.inspectText()).toContain("Aliases: socratic");
  });

  it("inspect output does not expose policy internals for policy-backed postures", () => {
    __testing.resetRegistry();
    __testing.runtimeState.activePostureId = "agent";
    const text = __testing.inspectText();
    // Standard fields still present
    expect(text).toContain("Active posture: agent (Agent)");
    expect(text).toContain("Context policy: global=inherit, project=inherit");
    // Policy internals not leaked
    expect(text).not.toMatch(/onActivate|onDeactivate|onBeforeActivate/);
  });

  it("built-in prompt overlays remain byte-for-byte unchanged through registry", () => {
    __testing.resetRegistry();
    for (const builtIn of BUILTIN_POSTURES) {
      if (!builtIn.promptOverlay) continue;
      const stored = __testing.getRegistryState().postures.get(builtIn.id)!;
      expect(stored.promptOverlay).toBe(builtIn.promptOverlay);
    }
  });

  // ============================================================
  // Per-posture runtime state (Phase 2 Task 5)
  // ============================================================

  it("restores runtime state from a session branch pi-posture-state custom entry", () => {
    const branch = [
      {
        type: "custom",
        customType: "pi-posture-state",
        data: {
          states: {
            agent: { activationCount: 3, lastActivatedAt: 1234 },
          },
        },
      },
    ];
    const ctx = { sessionManager: { getBranch: () => branch } } as any;
    __testing.restorePostureRuntimeState(ctx);
    const state = __testing.getOrCreatePostureRuntimeState("agent");
    expect(state.activationCount).toBe(3);
    expect(state.lastActivatedAt).toBe(1234);
  });

  it("later runtime state entries override earlier ones", () => {
    const branch = [
      {
        type: "custom",
        customType: "pi-posture-state",
        data: {
          states: {
            agent: { activationCount: 1, lastActivatedAt: 100 },
          },
        },
      },
      {
        type: "custom",
        customType: "pi-posture-state",
        data: {
          states: {
            agent: { activationCount: 5, lastActivatedAt: 500 },
          },
        },
      },
    ];
    const ctx = { sessionManager: { getBranch: () => branch } } as any;
    __testing.restorePostureRuntimeState(ctx);
    const state = __testing.getOrCreatePostureRuntimeState("agent");
    expect(state.activationCount).toBe(5);
    expect(state.lastActivatedAt).toBe(500);
  });

  it("switching a posture persists both active posture entry and hidden runtime state entry", async () => {
    writeProjectConfig(cwd, {
      postures: {
        focused: { description: "Focused", activeTools: ["read"] },
      },
    });
    const harness = fakeExtension(cwd);
    await harness.run("focused");

    const postureEntry = harness.appended.find(
      (e) => e.customType === "posture",
    );
    expect(postureEntry).toBeDefined();
    expect((postureEntry!.data as any).id).toBe("focused");

    const stateEntry = harness.appended.find(
      (e) => e.customType === "pi-posture-state",
    );
    expect(stateEntry).toBeDefined();
    const states = (stateEntry!.data as any).states;
    expect(states.focused).toBeDefined();
    expect(states.focused.activationCount).toBe(1);
    expect(typeof states.focused.lastActivatedAt).toBe("number");
  });

  it("existing restorePostureFromSession still works with old posture entries", () => {
    const branch = [
      { type: "custom", customType: "posture", data: { id: "learn" } },
    ];
    const ctx = { sessionManager: { getBranch: () => branch } } as any;
    __testing.runtimeState.activePostureId = "default";
    const restored = __testing.restorePostureFromSession(ctx);
    expect(restored).toBe(true);
    expect(__testing.runtimeState.activePostureId).toBe("learn");
  });
});

// ============================================================
// Policy hook dispatch tests (Phase 2 Task 6)
// ============================================================

describe("policy hook dispatch", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempProject();
    __testing.resetRegistry();
    __testing.runtimeState.activePostureId = "default";
    __testing.runtimeState.toolSnapshot = undefined;
    __testing.runtimeState.appliedToolsOverride = undefined;
    __testing.runtimeState.thinkingSnapshot = undefined;
    __testing.runtimeState.appliedThinkingOverride = undefined;
    __testing.runtimeState.contextFilterReport = undefined;
    __testing.postureRuntimeStates.clear();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function createCustomPolicy() {
    return {
      type: "custom" as const,
      onBeforeActivate: vi.fn(),
      onActivate: vi.fn(),
      onDeactivate: vi.fn(),
      onBeforeAgentStart: vi.fn(),
      onInput: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onTurnEnd: vi.fn(),
      onAgentEnd: vi.fn(),
      onSessionStart: vi.fn(),
      onSessionShutdown: vi.fn(),
      renderStatus: vi.fn(),
      renderWidget: vi.fn(),
    };
  }

  /** Register a custom posture with a policy in the registry and activate it.
   *  Must be called after creating a fakeExtension harness since resetRegistry()
   *  wipes custom entries. */
  function installAndActivate(id: string, policy: ReturnType<typeof createCustomPolicy>) {
    __testing.setPostureDefinition(id, {
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      description: `Custom ${id} posture`,
      policy,
    });
    __testing.runtimeState.activePostureId = id;
  }

  // ---- UI hooks ----

  it("custom active policy can override status text via renderStatus", () => {
    const policy = createCustomPolicy();
    policy.renderStatus = vi.fn().mockReturnValue("custom status");
    installAndActivate("guided", policy);

    const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as any;
    __testing.updatePostureUi(ctx);

    expect(policy.renderStatus).toHaveBeenCalledTimes(1);
    expect(policy.renderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-posture", "custom status");
  });

  it("if renderStatus returns undefined, fallback status summary is used", () => {
    const policy = createCustomPolicy();
    policy.renderStatus = vi.fn().mockReturnValue(undefined);
    installAndActivate("guided", policy);

    const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as any;
    __testing.updatePostureUi(ctx);

    expect(policy.renderStatus).toHaveBeenCalledTimes(1);
    // Fallback for non-default posture: "posture: guided"
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-posture", "posture: guided");
  });

  it("custom active policy can render widget lines", () => {
    const policy = createCustomPolicy();
    policy.renderWidget = vi.fn().mockReturnValue(["Line 1", "Line 2"]);
    installAndActivate("guided", policy);

    const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as any;
    __testing.updatePostureUi(ctx);

    expect(policy.renderWidget).toHaveBeenCalledTimes(1);
    expect(policy.renderWidget).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-posture-widget", ["Line 1", "Line 2"]);
  });

  it("widget clears when switching to default posture", () => {
    __testing.runtimeState.activePostureId = "default";

    const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as any;
    __testing.updatePostureUi(ctx);

    // Default posture clears widget
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-posture-widget", undefined);
  });

  it("widget clears when switching to posture without renderWidget", () => {
    const policy = createCustomPolicy();
    // No renderWidget on policy
    installAndActivate("guided", policy);

    const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as any;
    __testing.updatePostureUi(ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-posture-widget", undefined);
  });

  it("static/default postures keep existing status and no-widget behavior", () => {
    __testing.runtimeState.activePostureId = "default";
    const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as any;
    __testing.updatePostureUi(ctx);

    // Default: clears status
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-posture", undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-posture-widget", undefined);

    // Non-default static posture (e.g. agent)
    __testing.runtimeState.activePostureId = "agent";
    __testing.updatePostureUi(ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-posture", "posture: agent");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-posture-widget", undefined);
  });

  it("renderStatus and renderWidget are not called for inactive posture", () => {
    const policy = createCustomPolicy();
    policy.renderStatus = vi.fn();
    policy.renderWidget = vi.fn();
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other posture",
      policy,
    });
    __testing.runtimeState.activePostureId = "default";

    const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } } as any;
    __testing.updatePostureUi(ctx);

    expect(policy.renderStatus).not.toHaveBeenCalled();
    expect(policy.renderWidget).not.toHaveBeenCalled();
    // Default posture still clears status
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-posture", undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("pi-posture-widget", undefined);
  });

  it("updatePostureUi is called on applyRuntime and before_agent_start", async () => {
    const policy = createCustomPolicy();
    policy.renderStatus = vi.fn().mockReturnValue("🔵 focused");
    policy.renderWidget = vi.fn().mockReturnValue(["Widget line"]);

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("focused", {
      id: "focused",
      label: "Focused",
      description: "Focused posture",
      policy,
    });
    __testing.runtimeState.activePostureId = "focused";

    // applyRuntime calls updatePostureUi
    __testing.applyRuntime(harness.pi as any, harness.ctx as any, __testing.activePosture());

    expect(harness.widgetCalls).toContainEqual({
      key: "pi-posture-widget",
      content: ["Widget line"],
    });

    // before_agent_start also calls updatePostureUi
    harness.widgetCalls.length = 0; // reset
    await harness.emit("before_agent_start", {
      prompt: "test",
      systemPrompt: "base",
      systemPromptOptions: { cwd: "/tmp" },
    });

    expect(harness.widgetCalls).toContainEqual({
      key: "pi-posture-widget",
      content: ["Widget line"],
    });
    expect(policy.renderStatus).toHaveBeenCalled();
    expect(policy.renderWidget).toHaveBeenCalled();
  });

  // ---- before_agent_start ----

  it("before_agent_start hook appends system prompt for active custom posture", () => {
    const policy = createCustomPolicy();
    policy.onBeforeAgentStart.mockReturnValue({ systemPrompt: "policy-extra" });
    installAndActivate("guided", policy);

    const result = __testing.callPolicyHook(policy.onBeforeAgentStart, {
      prompt: "hello",
      systemPrompt: "original",
    });

    expect(policy.onBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ systemPrompt: "policy-extra" });
  });

  it("before_agent_start hook chains with static overlay through event handler", async () => {
    const policy = createCustomPolicy();
    policy.onBeforeAgentStart.mockReturnValue({ systemPrompt: "policy-overlay" });

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    const results = await harness.emit("before_agent_start", {
      prompt: "test",
      systemPrompt: "base",
      systemPromptOptions: { cwd: "/tmp" },
    });

    const result = results.find(
      (r: any) => r && "systemPrompt" in r,
    ) as { systemPrompt: string } | undefined;
    expect(result).toBeDefined();
    // The overlay gets appended, then the policy hook result is chained
    expect(result!.systemPrompt).toContain("base");
    expect(result!.systemPrompt).toContain("policy-overlay");
    expect(policy.onBeforeAgentStart).toHaveBeenCalledTimes(1);
  });

  it("before_agent_start hook does not erase static overlay when it returns undefined", async () => {
    const policy = createCustomPolicy();
    policy.onBeforeAgentStart.mockReturnValue(undefined);

    const harness = fakeExtension("/tmp");
    // Use a posture with a promptOverlay so we can verify the static overlay survives
    __testing.setPostureDefinition("guided", {
      id: "guided",
      label: "Guided",
      description: "Guided posture",
      promptOverlay: "You are in guided posture.",
      policy,
    });
    __testing.runtimeState.activePostureId = "guided";
    const results = await harness.emit("before_agent_start", {
      prompt: "test",
      systemPrompt: "base",
      systemPromptOptions: { cwd: "/tmp" },
    });

    const result = results.find(
      (r: any) => r && "systemPrompt" in r,
    ) as { systemPrompt: string } | undefined;
    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain("base");
    // Overlay is still added (non-default posture)
    expect(result!.systemPrompt).toContain('<pi_posture id="guided">');
  });

  it("before_agent_start handler does not call policy hooks for default/static posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    // Don't install/activate the custom policy — stay on default
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    __testing.runtimeState.activePostureId = "default";

    const results = await harness.emit("before_agent_start", {
      prompt: "test",
      systemPrompt: "base",
      systemPromptOptions: { cwd: "/tmp" },
    });

    // Handler still returns { systemPrompt } — just no overlay or hook calls
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ systemPrompt: "base" });
    expect(policy.onBeforeAgentStart).not.toHaveBeenCalled();
  });

  // ---- input ----

  it("input hook can mark input as handled for active custom posture", async () => {
    const policy = createCustomPolicy();
    policy.onInput.mockReturnValue({ action: "handled" });

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    const results = await harness.emit("input", {
      type: "input",
      text: "user message",
      source: "interactive",
    });

    expect(policy.onInput).toHaveBeenCalledTimes(1);
    expect(policy.onInput).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
      expect.objectContaining({ text: "user message" }),
    );
    const handledResult = results.find(
      (r: any) => r && r.action === "handled",
    );
    expect(handledResult).toBeDefined();
  });

  it("input hook is not called for inactive posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    // activePostureId is still "default"
    await harness.emit("input", {
      type: "input",
      text: "user message",
      source: "interactive",
    });

    expect(policy.onInput).not.toHaveBeenCalled();
  });

  it("input hook is not called for default/static posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    __testing.runtimeState.activePostureId = "default";
    const results = await harness.emit("input", {
      type: "input",
      text: "user message",
      source: "interactive",
    });

    // For default/static posture, handler returns undefined (no hook action)
    expect(results.every((r: any) => r === undefined)).toBe(true);
    expect(policy.onInput).not.toHaveBeenCalled();
  });

  // ---- input transform ----

  it("input hook can transform text for active custom posture", async () => {
    const policy = createCustomPolicy();
    policy.onInput.mockReturnValue({ action: "transform", text: "transformed message" });

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    const results = await harness.emit("input", {
      type: "input",
      text: "original message",
      source: "interactive",
    });

    expect(policy.onInput).toHaveBeenCalledTimes(1);
    expect(policy.onInput).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
      expect.objectContaining({ text: "original message" }),
    );
    const transformResult = results.find(
      (r: any) => r && r.action === "transform",
    );
    expect(transformResult).toBeDefined();
    expect(transformResult!.text).toBe("transformed message");
  });

  it("input hook transform falls back to original text when result.text is missing", async () => {
    const policy = createCustomPolicy();
    policy.onInput.mockReturnValue({ action: "transform" });

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    const results = await harness.emit("input", {
      type: "input",
      text: "original message",
      source: "interactive",
    });

    const transformResult = results.find(
      (r: any) => r && r.action === "transform",
    );
    expect(transformResult).toBeDefined();
    expect(transformResult!.text).toBe("original message");
  });

  // ---- tool_call ----

  it("tool_call hook can block tool execution for active custom posture", async () => {
    const policy = createCustomPolicy();
    policy.onToolCall.mockReturnValue({ block: true, reason: "not allowed" });

    const harness = fakeExtension("/tmp");
    installAndActivate("restricted", policy);
    const results = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "rm -rf /" },
    });

    expect(policy.onToolCall).toHaveBeenCalledTimes(1);
    expect(policy.onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "restricted" }),
      expect.objectContaining({ toolCallId: "call-1", toolName: "bash" }),
    );
    const blockResult = results.find(
      (r: any) => r && r.block === true,
    );
    expect(blockResult).toBeDefined();
    expect(blockResult!.reason).toBe("not allowed");
  });

  it("tool_call hook is not called for inactive posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "read",
      input: {},
    });

    expect(policy.onToolCall).not.toHaveBeenCalled();
  });

  it("tool_call hook not called for default/static posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    __testing.runtimeState.activePostureId = "default";
    const results = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "echo hi" },
    });

    expect(results.every((r: any) => r === undefined)).toBe(true);
    expect(policy.onToolCall).not.toHaveBeenCalled();
  });

  // ---- tool_result ----

  it("tool_result hook can patch content for active custom posture", async () => {
    const policy = createCustomPolicy();
    policy.onToolResult.mockReturnValue({
      content: [{ type: "text", text: "patched" }],
    });

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    const results = await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "read",
      input: { path: "/tmp/file" },
      content: [{ type: "text", text: "original" }],
      isError: false,
    });

    expect(policy.onToolResult).toHaveBeenCalledTimes(1);
    expect(policy.onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
      expect.objectContaining({ toolCallId: "call-1", toolName: "read" }),
    );
    const patchResult = results.find(
      (r: any) => r && r.content,
    );
    expect(patchResult).toBeDefined();
    expect(patchResult!.content![0].text).toBe("patched");
  });

  it("tool_result hook can mark error for active custom posture", async () => {
    const policy = createCustomPolicy();
    policy.onToolResult.mockReturnValue({ isError: true });

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    const results = await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "false" },
      content: [{ type: "text", text: "failed" }],
      isError: false,
    });

    const errorResult = results.find((r: any) => r && r.isError === true);
    expect(errorResult).toBeDefined();
  });

  it("tool_result hook is not called for inactive posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "echo hi" },
      content: [{ type: "text", text: "output" }],
      isError: false,
    });

    expect(policy.onToolResult).not.toHaveBeenCalled();
  });

  // ---- turn_end / agent_end (observation only) ----

  it("turn_end hook is called for active custom posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, timestamp: 100 });

    expect(policy.onTurnEnd).toHaveBeenCalledTimes(1);
    expect(policy.onTurnEnd).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
    );
  });

  it("agent_end hook is called for active custom posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    await harness.emit("agent_end", { type: "agent_end", messages: [] });

    expect(policy.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(policy.onAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
    );
  });

  it("turn_end and agent_end hooks are not called for default/static posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    __testing.runtimeState.activePostureId = "default";
    await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, timestamp: 100 });
    await harness.emit("agent_end", { type: "agent_end", messages: [] });

    expect(policy.onTurnEnd).not.toHaveBeenCalled();
    expect(policy.onAgentEnd).not.toHaveBeenCalled();
  });

  // ---- session hooks ----

  it("session_shutdown hook is called for active custom posture through dispatch", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    installAndActivate("guided", policy);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    expect(policy.onSessionShutdown).toHaveBeenCalledTimes(1);
    expect(policy.onSessionShutdown).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
    );
  });

  it("session_shutdown hook is not called for default/static posture", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    __testing.runtimeState.activePostureId = "default";
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    expect(policy.onSessionShutdown).not.toHaveBeenCalled();
  });

  // ---- onSessionStart ----

  it("onSessionStart hook is called for active custom posture via callPolicyHook", () => {
    const policy = createCustomPolicy();
    installAndActivate("guided", policy);

    __testing.callPolicyHook(policy.onSessionStart);

    expect(policy.onSessionStart).toHaveBeenCalledTimes(1);
    expect(policy.onSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ postureId: "guided" }),
    );
  });

  it("onSessionStart hook receives restored runtime state via callPolicyHook", () => {
    const policy = createCustomPolicy();

    installAndActivate("tracked", policy);
    // Populate runtime state simulating restorePostureRuntimeState
    const state = __testing.getOrCreatePostureRuntimeState("tracked");
    state.activationCount = 42;
    state.lastActivatedAt = 99999;

    __testing.callPolicyHook(policy.onSessionStart);

    expect(policy.onSessionStart).toHaveBeenCalledTimes(1);
    expect(policy.onSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        postureId: "tracked",
        runtimeState: expect.objectContaining({
          activationCount: 42,
          lastActivatedAt: 99999,
        }),
      }),
    );
  });

  it("onSessionStart hook is not called for default/static posture via callPolicyHook", () => {
    const policy = createCustomPolicy();

    __testing.setPostureDefinition("other", {
      id: "other",
      label: "Other",
      description: "Other",
      policy,
    });
    __testing.runtimeState.activePostureId = "default";

    const result = __testing.callPolicyHook(policy.onSessionStart);
    expect(result).toBeUndefined();
    expect(policy.onSessionStart).not.toHaveBeenCalled();
  });

  // ---- callPolicyHook helper ----

  it("callPolicyHook returns undefined when policy is static or missing", () => {
    __testing.resetRegistry();
    __testing.runtimeState.activePostureId = "agent";
    // agent has type "static" policy
    const result = __testing.callPolicyHook(vi.fn(), {});
    expect(result).toBeUndefined();
  });

  it("callPolicyHook returns undefined when hook is undefined", () => {
    const policy = createCustomPolicy();
    installAndActivate("guided", policy);
    const result = __testing.callPolicyHook(undefined);
    expect(result).toBeUndefined();
  });

  it("activePolicyContext returns correct postureId and mutable runtime state", () => {
    const policy = createCustomPolicy();
    installAndActivate("guided", policy);

    const ctx = __testing.activePolicyContext();
    expect(ctx.postureId).toBe("guided");
    expect(ctx.runtimeState.activationCount).toBe(0);

    // Mutation reflects in the stored state
    ctx.runtimeState.activationCount = 1;
    expect(__testing.getOrCreatePostureRuntimeState("guided").activationCount).toBe(1);
  });

  it("no hooks are called for inactive posture even when all emit events", async () => {
    const policy = createCustomPolicy();

    const harness = fakeExtension("/tmp");
    __testing.setPostureDefinition("active-posture", {
      id: "active-posture",
      label: "Active",
      description: "Active posture",
      policy,
    });
    __testing.runtimeState.activePostureId = "default";
    await harness.emit("before_agent_start", {
      prompt: "test",
      systemPrompt: "base",
      systemPromptOptions: { cwd: "/tmp" },
    });
    await harness.emit("input", { type: "input", text: "hi", source: "interactive" });
    await harness.emit("tool_call", { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
    await harness.emit("tool_result", { type: "tool_result", toolCallId: "c1", toolName: "bash", input: { command: "ls" }, content: [], isError: false });
    await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, timestamp: 100 });
    await harness.emit("agent_end", { type: "agent_end", messages: [] });
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    expect(policy.onBeforeAgentStart).not.toHaveBeenCalled();
    expect(policy.onInput).not.toHaveBeenCalled();
    expect(policy.onToolCall).not.toHaveBeenCalled();
    expect(policy.onToolResult).not.toHaveBeenCalled();
    expect(policy.onTurnEnd).not.toHaveBeenCalled();
    expect(policy.onAgentEnd).not.toHaveBeenCalled();
    expect(policy.onSessionShutdown).not.toHaveBeenCalled();
  });

  it("session_start restores per-posture runtime state and before_agent_start hook observes it", async () => {
    const policy = createCustomPolicy();
    policy.onBeforeAgentStart = vi.fn().mockReturnValue(undefined);

    // Define the posture in project config so it survives session_start reload
    writeProjectConfig(cwd, {
      postures: {
        tracked: {
          label: "Tracked",
          description: "Posture with tracked runtime state",
        },
      },
    });

    const branch = [
      { type: "custom", customType: "posture", data: { id: "tracked" } },
      {
        type: "custom",
        customType: "pi-posture-state",
        data: {
          states: {
            tracked: { activationCount: 42, lastActivatedAt: 99999 },
          },
        },
      },
    ];

    const harness = fakeExtension(cwd, { branch });

    // session_start reloads registry (tracked loads from config with static policy),
    // restores active posture from branch ("tracked"),
    // restores per-posture runtime state (activationCount: 42)
    await harness.emit("session_start", { reason: "resume" });

    // Verify restoration
    expect(__testing.runtimeState.activePostureId).toBe("tracked");
    const restoredState = __testing.getOrCreatePostureRuntimeState("tracked");
    expect(restoredState.activationCount).toBe(42);
    expect(restoredState.lastActivatedAt).toBe(99999);

    // Install custom policy on the posture now that it's loaded from config
    __testing.setPostureDefinition("tracked", {
      id: "tracked",
      label: "Tracked",
      description: "Posture with tracked runtime state",
      policy,
    });

    // Emit before_agent_start — the policy hook should see the restored state
    await harness.emit("before_agent_start", {
      prompt: "test",
      systemPrompt: "base",
      systemPromptOptions: { cwd: "/tmp" },
    });

    expect(policy.onBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(policy.onBeforeAgentStart).toHaveBeenCalledWith(
      expect.objectContaining({
        postureId: "tracked",
        runtimeState: expect.objectContaining({
          activationCount: 42,
          lastActivatedAt: 99999,
        }),
      }),
      expect.objectContaining({ prompt: "test" }),
    );
  });
});

// ============================================================
// Pure registry builder tests (no filesystem, no extension runtime)
// ============================================================

describe("buildPostureRegistry (pure)", () => {
  it("includes built-in postures and aliases with no configs", () => {
    const result = buildPostureRegistry([]);
    expect(result.postures.has("default")).toBe(true);
    expect(result.postures.has("agent")).toBe(true);
    expect(result.postures.has("learn")).toBe(true);
    expect(result.postures.has("assist")).toBe(true);
    expect(result.postures.has("review")).toBe(true);
    expect(result.aliases.get("vanilla")).toBe("default");
    expect(result.aliases.get("teacher")).toBe("learn");
    expect(result.aliases.get("pair")).toBe("assist");
    expect(result.aliases.get("autonomous")).toBe("agent");
    expect(result.configErrors).toEqual([]);
  });

  it("merges config overrides for built-in postures preserving promptOverlay", () => {
    const result = buildPostureRegistry([
      {
        postures: {
          learn: { description: "Custom learn", thinking: "low" },
        },
      },
    ]);
    const learn = result.postures.get("learn")!;
    expect(learn.description).toBe("Custom learn");
    expect(learn.thinking).toBe("low");
    const builtIn = BUILTIN_POSTURES.find((p) => p.id === "learn")!;
    expect(learn.promptOverlay).toBe(builtIn.promptOverlay);
    expect(result.configErrors).toEqual([]);
  });

  it("adds custom aliases", () => {
    const result = buildPostureRegistry([{ aliases: { socratic: "learn" } }]);
    expect(result.aliases.get("socratic")).toBe("learn");
    expect(result.configErrors).toEqual([]);
  });

  it("reports validation errors for invalid thinking", () => {
    const result = buildPostureRegistry([
      {
        postures: {
          broken: { thinking: "huge" as any },
        },
      },
    ]);
    expect(result.configErrors).toContain(
      "config[0].postures.broken.thinking: invalid thinking level",
    );
  });

  it("reports validation errors for contextPolicy", () => {
    const result = buildPostureRegistry([
      {
        postures: {
          broken: { contextPolicy: { global: "nope" } as any },
        },
      },
    ]);
    expect(result.configErrors).toContain(
      "config[0].postures.broken.contextPolicy.global: expected inherit or suppress",
    );
  });

  it("applies startup picker config", () => {
    const result = buildPostureRegistry([
      {
        startupPicker: {
          enabled: true,
          include: ["learn", "pair"],
          reasons: ["startup", "new"],
          timeoutMs: 2500,
        },
      },
    ]);
    expect(result.startupPicker.enabled).toBe(true);
    expect(result.startupPicker.reasons).toEqual(["startup", "new"]);
    expect(result.startupPicker.timeoutMs).toBe(2500);
    expect(result.configErrors).toEqual([]);
  });

  it("resolves aliases and deduplicates in startup picker include", () => {
    const result = buildPostureRegistry([
      {
        startupPicker: {
          enabled: true,
          include: ["learn", "teacher", "missing"],
          reasons: ["startup", "reload"],
        },
      },
    ]);
    // "teacher" resolves to "learn" → duplicate; "missing" is unknown;
    // only "learn" should survive normalization
    expect(result.startupPicker.include).toEqual(["learn"]);
    expect(result.configErrors).toContain(
      'startupPicker.include: duplicate posture "learn" from "teacher"',
    );
    expect(result.configErrors).toContain(
      'startupPicker.include: unknown posture or alias "missing"',
    );
  });

  it("reports validation errors for startup picker include and reasons", () => {
    const result = buildPostureRegistry([
      {
        startupPicker: {
          include: ["" as any, "learn", 123 as any],
          reasons: ["reload" as any, 456 as any],
        },
      },
    ]);
    expect(result.configErrors).toContain(
      "config[0].startupPicker.include[0]: must not be empty",
    );
    expect(result.configErrors).toContain(
      "config[0].startupPicker.include[2]: must be a string",
    );
    expect(result.configErrors).toContain(
      'config[0].startupPicker.reasons: invalid reason "reload"',
    );
    expect(result.configErrors).toContain(
      "config[0].startupPicker.reasons[1]: must be a string",
    );
  });

  it("resolves custom aliases through the startup picker normalizer", () => {
    const result = buildPostureRegistry([
      { aliases: { socratic: "learn" } },
      {
        startupPicker: {
          enabled: true,
          include: ["socratic"],
        },
      },
    ]);
    // "socratic" resolves to "learn" → known posture, kept
    expect(result.startupPicker.include).toEqual(["socratic"]);
    expect(result.configErrors).toEqual([]);
  });

  it("handles undefined configs in the array", () => {
    const result = buildPostureRegistry([
      undefined,
      { aliases: { socratic: "learn" } },
    ]);
    expect(result.aliases.get("socratic")).toBe("learn");
    expect(result.postures.size).toBe(5);
    expect(result.configErrors).toEqual([]);
  });

  it("multiple configs overlay correctly", () => {
    const result = buildPostureRegistry([
      { aliases: { socratic: "learn" } },
      { postures: { custom: { description: "Custom" } } },
    ]);
    expect(result.aliases.get("socratic")).toBe("learn");
    expect(result.postures.has("custom")).toBe(true);
    expect(result.configErrors).toEqual([]);
  });

  it("does not leak policy field through config posture entry", () => {
    // Even when policy is passed through a wide cast, the builder
    // never reads it — it only reads PostureConfigEntry fields.
    const entry: Record<string, unknown> = { description: "No policy" };
    entry.policy = { type: "custom" };
    const result = buildPostureRegistry([{ postures: { test: entry } }]);
    const posture = result.postures.get("test")!;
    // withStaticPosturePolicy adds static when no policy is present
    expect(posture.policy?.type).toBe("static");
  });

  it("adds static policy to built-in postures from builder", () => {
    const result = buildPostureRegistry([]);
    for (const posture of result.postures.values()) {
      expect(posture.policy).toBeDefined();
      expect(posture.policy!.type).toBe("static");
    }
  });

  it("adds static policy to custom postures from builder", () => {
    const result = buildPostureRegistry([
      { postures: { custom: { description: "Custom posture" } } },
    ]);
    const posture = result.postures.get("custom")!;
    expect(posture.policy).toBeDefined();
    expect(posture.policy!.type).toBe("static");
  });

  it("invalid thinking clears existing value from previous config", () => {
    const result = buildPostureRegistry([
      { postures: { test: { thinking: "low" } } },
      { postures: { test: { thinking: "huge" as any } } },
    ]);
    const posture = result.postures.get("test")!;
    expect(posture.thinking).toBeUndefined();
    expect(result.configErrors).toContain(
      "config[1].postures.test.thinking: invalid thinking level",
    );
  });

  it("invalid thinking without existing value also sets undefined", () => {
    const result = buildPostureRegistry([
      { postures: { test: { thinking: "huge" as any } } },
    ]);
    const posture = result.postures.get("test")!;
    expect(posture.thinking).toBeUndefined();
    expect(result.configErrors).toContain(
      "config[0].postures.test.thinking: invalid thinking level",
    );
  });

  it("valid thinking override preserves from later config", () => {
    const result = buildPostureRegistry([
      { postures: { test: { thinking: "low" } } },
      { postures: { test: { thinking: "high" } } },
    ]);
    const posture = result.postures.get("test")!;
    expect(posture.thinking).toBe("high");
    expect(result.configErrors).toEqual([]);
  });
});
