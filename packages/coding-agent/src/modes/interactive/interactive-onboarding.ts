import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import type { Api, Model } from "./interactive-mode-deps.ts";
import { isUnknownModel } from "./interactive-mode-helpers.ts";

export const ONBOARDING_PLACEHOLDER = "Paste a ticket, issue, path to a spec, or task prompt…";

export const ONBOARDING_COPY = [
  "Atomic runs agent loops as workflows you can watch and trust:",
  "implement a ticket, research a codebase, design a UI, or build",
  "your own loop.",
  "",
  "Paste a ticket description, GitHub issue, path to a spec, or task prompt to start.",
  "/chat to chat normally · /atomic for guides",
  "If you have not logged in yet, first run /login.",
].join("\n");

export const NORMAL_CHAT_TRANSITION_COPY = [
  "You're in a normal coding-agent session now. Atomic can chat and edit like other",
  "coding agents, but it also runs loops and workflows. Ask Atomic to build any loop,",
  "or run a built-in workflow like `goal` for small focused changes or `ralph` for",
  "larger, cross-cutting work. Run `/workflow list` to see built-ins, and use `/atomic`",
  "for help running or building your own loops and workflows.",
].join("\n");

export const ONBOARDING_SEED_STASHED_COPY = [
  "Task saved for after login. Run /login to connect a provider; once login finishes,",
  "Atomic will continue with your saved task.",
].join("\n");

export const ONBOARDING_SEED_REPLACED_COPY = [
  "Latest task saved for after login, replacing the previous saved task. Run /login to",
  "connect a provider; once login finishes, Atomic will continue with the latest task.",
].join("\n");

export const ONBOARDING_HANDOFF_NOTICE = "Handing your task to the normal coding-agent session.";

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathCandidatesWithOptionalLocationSuffix(pathText: string): string[] {
  const candidates = [pathText, pathText.replace(/:\d+:\d+$/, ""), pathText.replace(/:\d+$/, "")];
  return candidates.filter((candidate, index) => candidate && candidates.indexOf(candidate) === index);
}

function firstSeedLine(seed: string): string { return seed.trim().split(/\r?\n/, 1)[0]?.trim() ?? ""; }

function getContainedExistingPath(pathText: string, cwd: string): string | undefined {
  if (!pathText || /\r|\n/.test(pathText) || /^[a-z]+:\/\//i.test(pathText)) return undefined;
  const root = resolve(cwd);
  let rootReal: string;
  try { rootReal = realpathSync(root); } catch { return undefined; }
  for (const candidate of pathCandidatesWithOptionalLocationSuffix(pathText)) {
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
    if (!isInside(root, absolute)) continue;
    try {
      lstatSync(absolute);
      const real = realpathSync(absolute);
      if (isInside(rootReal, real)) return real;
    } catch {}
  }
  return undefined;
}

export function isCwdLocalExistingPathSeed(seed: string, cwd: string): boolean {
  const trimmed = firstSeedLine(seed);
  if (!trimmed || !isAbsolute(trimmed)) return false;
  const real = getContainedExistingPath(trimmed, cwd);
  if (!real) return false;
  try {
    const stat = statSync(real);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

export function isExistingAbsolutePathSeed(seed: string): boolean {
  const trimmed = firstSeedLine(seed);
  if (!trimmed || /\r|\n/.test(trimmed) || /^[a-z]+:\/\//i.test(trimmed) || !isAbsolute(trimmed)) return false;
  for (const candidate of pathCandidatesWithOptionalLocationSuffix(trimmed)) {
    if (!isAbsolute(candidate)) continue;
    try {
      const stat = statSync(candidate);
      if (stat.isFile() || stat.isDirectory()) return true;
    } catch {}
  }
  return false;
}

function sameModel(a: Model<Api>, b: Model<Api>): boolean {
  return a.provider === b.provider && a.id === b.id;
}

function backtickFenceFor(seed: string): string {
  let longest = 0;
  for (const match of seed.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function buildOnboardingHandoffPrompt(seed: string): string {
  const fence = backtickFenceFor(seed);
  return [
    "First-run onboarding handoff: continue as a normal Atomic coding-agent session.",
    "",
    "Original task seed:",
    `${fence}text`,
    seed,
    fence,
    "",
    "Perform a quick scope-routing pass before acting. Use the existing Atomic workflow guidance:",
    "choose `goal` for small focused fixes or quick fixes; choose `ralph` for non-trivial,",
    "broad, cross-cutting, or around-2K+-changed-line work. Start the selected workflow with",
    "the original seed, then continue normally in this session. Slash commands should behave",
    "like normal coding-agent slash commands from here on.",
  ].join("\n");
}

InteractiveModeBase.prototype.isFirstRunOnboardingEligible = function(this: InteractiveModeBase): boolean {
  const hasInitialInput = Boolean(this.options.initialMessage) || Boolean(this.options.initialMessages?.length);
  return this.session.state.messages.length === 0
    && !hasInitialInput
    && !this.settingsManager.getOnboardedVersion()
    && Boolean(this.settingsManager.getFirstRunOnboardingStartedVersion());
};

InteractiveModeBase.prototype.isFirstRunOnboardingReadyForHandoff = function(this: InteractiveModeBase): boolean {
  const registry = this.session.modelRegistry;
  if (!registry) return true;
  const model = this.session.model;
  if (!model || isUnknownModel(model)) return false;
  if (typeof registry.hasConfiguredAuth === "function") {
    return registry.hasConfiguredAuth(model);
  }
  if (typeof registry.getAvailable === "function") {
    return registry.getAvailable().some((availableModel) => sameModel(availableModel, model));
  }
  return true;
};

InteractiveModeBase.prototype.stashFirstRunOnboardingSeed = function(this: InteractiveModeBase, seed: string): void {
  const replaced = Boolean(this.pendingFirstRunOnboardingSeed);
  this.pendingFirstRunOnboardingSeed = seed;
  this.showStatus(replaced ? ONBOARDING_SEED_REPLACED_COPY : ONBOARDING_SEED_STASHED_COPY);
};

InteractiveModeBase.prototype.resumePendingFirstRunOnboardingSeed = async function(this: InteractiveModeBase): Promise<void> {
  if (!this.firstRunOnboardingActive || !this.pendingFirstRunOnboardingSeed) return;
  if (!this.isFirstRunOnboardingReadyForHandoff()) return;
  const seed = this.pendingFirstRunOnboardingSeed;
  this.pendingFirstRunOnboardingSeed = undefined;
  try {
    await this.handleOnboardingWorkflowSeed(seed);
  } catch (error: unknown) {
    this.pendingFirstRunOnboardingSeed = seed;
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.showError(errorMessage);
  }
};

InteractiveModeBase.prototype.clearFirstRunOnboardingUi = function(this: InteractiveModeBase): void {
  this.firstRunOnboardingActive = false;
  this.firstRunOnboardingSeedInFlight = false;
  this.pendingFirstRunOnboardingSeed = undefined;
  this.defaultEditor.setPlaceholder(undefined);
  if (this.firstRunOnboardingHeaderComponents.length > 0) {
    this.headerContainer.children = this.headerContainer.children.filter(
      (child) => !this.firstRunOnboardingHeaderComponents.includes(child),
    );
    this.firstRunOnboardingHeaderComponents = [];
  }
  this.ui.requestRender();
};

InteractiveModeBase.prototype.completeFirstRunOnboarding = function(this: InteractiveModeBase): void {
  this.settingsManager.setOnboardedVersion(this.version);
  InteractiveModeBase.prototype.clearFirstRunOnboardingUi.call(this);
};

InteractiveModeBase.prototype.handleOnboardingWorkflowSeed = async function(
  this: InteractiveModeBase,
  seed: string,
): Promise<void> {
  const handoffPrompt = buildOnboardingHandoffPrompt(seed);
  this.flushPendingBashComponents();
  if (this.onInputCallback) {
    this.onInputCallback(handoffPrompt);
  } else {
    this.pendingUserInputs.push(handoffPrompt);
  }
  this.showStatus(ONBOARDING_HANDOFF_NOTICE);
  this.completeFirstRunOnboarding();
};
