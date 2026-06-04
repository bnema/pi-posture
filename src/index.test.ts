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

function fakeExtension(cwd: string) {
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const messages: string[] = [];
  const pi = {
    registerMessageRenderer() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on() {},
    appendEntry() {},
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
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {},
    },
    sessionManager: { getBranch: () => [] },
  };

  piPosture(pi as any);
  if (!commandHandler) throw new Error("/posture command was not registered");
  return { pi, ctx, messages, run: (args: string) => commandHandler!(args, ctx) };
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
});
