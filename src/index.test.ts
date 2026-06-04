import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piPosture, { __testing } from "./index.js";

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
    run: (args: string) => commandHandler!(args, ctx),
    emit: async (event: string, payload: any) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

describe("pi-posture internals", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempProject();
    __testing.resetRegistry();
    __testing.state.activePostureId = "default";
    __testing.state.toolSnapshot = undefined;
    __testing.state.appliedToolsOverride = undefined;
    __testing.state.thinkingSnapshot = undefined;
    __testing.state.appliedThinkingOverride = undefined;
    __testing.state.contextFilterReport = undefined;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
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
    __testing.state.activePostureId = "learn";
    expect(__testing.inspectText()).toContain("Project learn");
    expect(__testing.inspectText()).toContain("project config.postures.broken.thinking: invalid thinking level");
  });

  it("adds prompt overlays for non-default postures but not default", () => {
    __testing.state.activePostureId = "learn";
    const learnPrompt = __testing.addPromptOverlay("base", __testing.activePosture());
    expect(learnPrompt).toContain('<pi_posture id="learn">');

    __testing.state.activePostureId = "default";
    const defaultPrompt = __testing.addPromptOverlay("base", __testing.activePosture());
    expect(defaultPrompt).toBe("base");
  });

  it("filters only existing rendered project instructions and does not reconstruct missing context", () => {
    const globalPath = `${getAgentDir()}/AGENTS.md`;
    const prompt = `<project_context>\n\nProject-specific instructions and guidelines:\n\n${projectContext(globalPath, "global")}${projectContext("/repo/AGENTS.md", "project")}</project_context>\nOTHER`;

    const filtered = __testing.filterProjectContext(prompt, { global: "suppress", project: "inherit" });

    expect(filtered).not.toContain("global");
    expect(filtered).toContain("project");
    expect(__testing.state.contextFilterReport?.suppressed).toEqual([globalPath]);

    const noContext = __testing.filterProjectContext("NO_CONTEXT", { global: "suppress", project: "suppress" });
    expect(noContext).toBe("NO_CONTEXT");
    expect(noContext).not.toContain("<project_context>");
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
    const ctx = { ui: { setStatus() {} } };
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

    expect(__testing.state.startupPicker.enabled).toBe(true);
    expect(__testing.state.startupPicker.reasons).toEqual(["startup", "new"]);
    expect(__testing.state.startupPicker.timeoutMs).toBe(2500);
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
    expect(__testing.state.activePostureId).toBe("learn");
    expect(harness.appended).toContainEqual({ customType: "posture", data: expect.objectContaining({ id: "learn" }) });
    expect(harness.messages.at(-1)).toBe("Switched to posture: learn");
  });

  it("startup picker cancel or unknown selection leaves posture unchanged", async () => {
    writeProjectConfig(cwd, { startupPicker: { enabled: true, include: ["learn"] } });

    const cancelHarness = fakeExtension(cwd, { hasUI: true });
    await cancelHarness.emit("session_start", { type: "session_start", reason: "startup" });
    expect(__testing.state.activePostureId).toBe("default");
    expect(cancelHarness.appended).toEqual([]);
    expect(cancelHarness.messages).toEqual([]);

    const unknownHarness = fakeExtension(cwd, { hasUI: true, selectChoice: "missing" });
    await unknownHarness.emit("session_start", { type: "session_start", reason: "startup" });
    expect(__testing.state.activePostureId).toBe("default");
    expect(unknownHarness.appended).toEqual([]);
    expect(unknownHarness.messages).toEqual([]);
  });

  it("session restore detects existing posture entries and skips startup picker", async () => {
    writeProjectConfig(cwd, { startupPicker: true });
    const branch = [{ type: "custom", customType: "posture", data: { id: "review" } }];
    const harness = fakeExtension(cwd, { hasUI: true, selectChoice: "learn — Tutor posture for learning while still using the full toolset for accurate guidance.", branch });

    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    expect(__testing.state.activePostureId).toBe("review");
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
    expect(__testing.state.activePostureId).toBe("learn");
    expect(harness.appended).toContainEqual({ customType: "posture", data: expect.objectContaining({ id: "learn" }) });
  });
});
