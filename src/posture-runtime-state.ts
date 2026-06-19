import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./posture-registry.js";

import type { PostureRuntimeState, ThinkingLevel } from "./posture-registry.js";

export type ContextFilterReport = {
  kept: string[];
  suppressed: string[];
};

export type RuntimeState = {
  activePostureId: string;
  contextFilterReport?: ContextFilterReport;
  toolSnapshot?: string[];
  appliedToolsOverride?: string[];
  thinkingSnapshot?: ThinkingLevel;
  appliedThinkingOverride?: ThinkingLevel;
};

export const runtimeState: RuntimeState = {
  activePostureId: "default",
};

export const postureRuntimeStates: Map<string, PostureRuntimeState> = new Map();

export function getOrCreatePostureRuntimeState(id: string): PostureRuntimeState {
  let state = postureRuntimeStates.get(id);
  if (!state) {
    state = { activationCount: 0 };
    postureRuntimeStates.set(id, state);
  }
  return state;
}

export function persistPostureRuntimeState(pi: ExtensionAPI): void {
  const states: Record<string, PostureRuntimeState> = {};
  for (const [id, state] of postureRuntimeStates) {
    states[id] = { ...state };
  }
  if (Object.keys(states).length > 0) {
    pi.appendEntry("pi-posture-state", { states });
  }
}

export function restorePostureRuntimeState(ctx: ExtensionContext): void {
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

export function snapshotPostureRuntimeStates(): string {
  const sorted: Record<string, PostureRuntimeState> = {};
  for (const key of Array.from(postureRuntimeStates.keys()).sort()) {
    sorted[key] = postureRuntimeStates.get(key)!;
  }
  return JSON.stringify(sorted);
}

export function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

export function sanitizePostureRuntimeState(value: unknown): PostureRuntimeState | null {
  if (!isRecord(value)) return null;
  const { activationCount, lastActivatedAt, turnsInSession, objective } = value as Record<string, unknown>;
  if (
    typeof activationCount !== "number" ||
    !Number.isFinite(activationCount) ||
    activationCount < 0 ||
    !Number.isInteger(activationCount)
  )
    return null;
  if (lastActivatedAt !== undefined && !isValidTimestamp(lastActivatedAt)) return null;
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
  if (typeof objective === "string" && objective.length > 0) result.objective = objective;
  return result;
}

export function persistIfChanged(pi: ExtensionAPI, before: string): void {
  if (before !== snapshotPostureRuntimeStates()) {
    persistPostureRuntimeState(pi);
  }
}
