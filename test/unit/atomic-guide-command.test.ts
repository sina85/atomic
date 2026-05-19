import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@bastani/atomic";
import { registerAtomicGuideCommand } from "../../packages/subagents/src/slash/atomic-guide-command.js";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type SentGuideMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

interface RegisteredCommandCapture {
  name: string;
  options: CommandOptions;
}

function createHarness(): {
  command: RegisteredCommandCapture;
  guideMessages: SentGuideMessage[];
} {
  const commands: RegisteredCommandCapture[] = [];
  const guideMessages: SentGuideMessage[] = [];

  const pi = {
    registerCommand(name: string, options: CommandOptions): void {
      commands.push({ name, options });
    },
    sendMessage(message: SentGuideMessage): void {
      guideMessages.push(message);
    },
  } satisfies Pick<ExtensionAPI, "registerCommand" | "sendMessage">;

  registerAtomicGuideCommand(pi as ExtensionAPI);
  const command = commands.find((registeredCommand) => registeredCommand.name === "atomic");
  assert.ok(command, "expected /atomic command to be registered");
  return { command, guideMessages };
}

function createCommandContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  const ctx = {
    hasUI: false,
    cwd: "/repo",
    isIdle: () => true,
    ...overrides,
  } satisfies Partial<ExtensionCommandContext>;
  return ctx as ExtensionCommandContext;
}

describe("/atomic guide command", () => {
  test("registers onboarding command metadata and static guide completions", async () => {
    const { command } = createHarness();

    assert.equal(command.options.description, "Atomic onboarding and help guide");
    assert.equal(typeof command.options.getArgumentCompletions, "function");

    const completions = (await command.options.getArgumentCompletions?.("")) ?? [];
    assert.deepEqual(
      completions.map((completion) => completion.value),
      ["overview", "workflows", "example", "what's new"],
    );
  });

  test("shows the static help menu by default", async () => {
    const { command, guideMessages } = createHarness();

    await command.options.handler("", createCommandContext());

    assert.equal(guideMessages.length, 1);
    const content = String(guideMessages[0]?.content ?? "");
    assert.match(content, /^# Atomic/);
    assert.match(content, /`overview` — run `\/atomic overview`/);
  });

  test("keeps explicit onboarding options routed to their static guides", async () => {
    const { command, guideMessages } = createHarness();
    const ctx = createCommandContext();

    await command.options.handler("overview", ctx);
    await command.options.handler("workflows", ctx);
    await command.options.handler("example", ctx);
    await command.options.handler("what's new", ctx);

    assert.equal(guideMessages.length, 4);
    assert.match(String(guideMessages[0]?.content ?? ""), /^# Atomic overview/);
    assert.match(String(guideMessages[1]?.content ?? ""), /^# Workflows primer/);
    assert.match(String(guideMessages[2]?.content ?? ""), /^# Practical example/);
    assert.match(String(guideMessages[3]?.content ?? ""), /^# What's new/);
  });

  test("UI help selection only offers static guide options", async () => {
    const { command, guideMessages } = createHarness();
    let offeredChoices: string[] = [];
    const ctx = createCommandContext({
      hasUI: true,
      ui: {
        select: async (_message: string, choices: string[]) => {
          offeredChoices = choices;
          return "workflows";
        },
      } as ExtensionCommandContext["ui"],
    });

    await command.options.handler("", ctx);

    assert.deepEqual(offeredChoices, ["overview", "workflows", "example", "what's new"]);
    assert.equal(guideMessages.length, 1);
    assert.match(String(guideMessages[0]?.content ?? ""), /^# Workflows primer/);
  });
});
