import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildModelCandidates,
  buildModelCandidatesFromCatalog,
  validateWorkflowModels,
  WorkflowModelValidationError,
} from "../../packages/workflows/src/runs/shared/model-fallback.js";
import type { WorkflowModelInfo } from "../../packages/workflows/src/shared/types.js";

const models: readonly WorkflowModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
  { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
];

function model(provider: string, id: string): Model<Api> {
  return {
    provider, id, name: id, api: provider === "cursor" ? "cursor-agent" : "anthropic-messages",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
  } as Model<Api>;
}

describe("Cursor workflow model resolution", () => {
  test("unavailable route rejects before configured/current fallback", async () => {
    await assert.rejects(
      buildModelCandidatesFromCatalog({
        primaryModel: "cursor/grok-4.5-high",
        fallbackModels: ["openai/gpt-5-mini"],
        catalog: {
          currentModel: "anthropic/claude-sonnet-4",
          discoverModels: async () => undefined,
          listModels: async () => models,
        },
      }),
      (err: Error) => {
        assert.ok(err instanceof WorkflowModelValidationError);
        assert.match(err.message, /cursor\/grok-4\.5-high/);
        assert.match(err.message, /reselect/);
        return true;
      },
    );
  });

  test("route rejects when the live catalog is unavailable", async () => {
    await assert.rejects(
      buildModelCandidatesFromCatalog({
        primaryModel: "cursor/cursor-grok-4.5-high",
        fallbackModels: ["openai/gpt-5-mini"],
        catalog: {
          currentModel: "openai/gpt-5-mini",
          discoverModels: async () => undefined,
          listModels: async () => { throw new Error("registry unavailable"); },
        },
      }),
      /registry unavailable/,
    );
  });

  test("exact available flat route remains selectable", () => {
    const candidates = buildModelCandidates({
      primaryModel: "cursor/cursor-grok-4.5-high",
      availableModels: [
        ...models,
        { provider: "cursor", id: "cursor-grok-4.5-high", fullId: "cursor/cursor-grok-4.5-high" },
      ],
    });
    assert.deepEqual(candidates.map((candidate) => ({ id: candidate.id, level: candidate.reasoningLevel })), [
      { id: "cursor/cursor-grok-4.5-high", level: undefined },
    ]);
  });

	test("provider-qualified text selects the first duplicate and accepts the blank route", () => {
		const first = model("cursor", "duplicate");
		const second = { ...model("cursor", "duplicate"), name: "second" };
		const blank = model("cursor", "");
		const availableModels = [
			{ provider: "cursor", id: "duplicate", fullId: "cursor/duplicate", model: first },
			{ provider: "cursor", id: "duplicate", fullId: "cursor/duplicate", model: second },
			{ provider: "cursor", id: "", fullId: "cursor/", model: blank },
		];
		assert.equal(buildModelCandidates({ primaryModel: "cursor/duplicate", availableModels })[0]?.value, first);
		assert.equal(buildModelCandidates({ primaryModel: "cursor/", availableModels })[0]?.value, blank);
	});

  test("preserves every exact provider-qualified Cursor route shape byte-for-byte", () => {
    const ids = [" route ", "route:high", "route (1m)", "route/with/slashes", "CaseRoute"];
    const availableModels = ids.map((id) => ({ provider: "cursor", id, fullId: `cursor/${id}` }));
    for (const id of ids) {
      const [candidate] = buildModelCandidates({ primaryModel: `cursor/${id}`, availableModels });
      assert.equal(candidate?.id, `cursor/${id}`);
      assert.equal(candidate?.reasoningLevel, undefined);
      assert.equal(candidate?.contextWindow, undefined);
    }
  });

  test("normalized Cursor qualifier bytes remain ordinary non-Cursor pass-through", async () => {
    const references = ["CURSOR/route", "CuRsOr/route", " cursor/route", "cursor /route"];
    const availableModels = [{ provider: "cursor", id: "route", fullId: "cursor/route" }];
    for (const primaryModel of references) {
      let discoveries = 0;
      const [candidate] = await buildModelCandidatesFromCatalog({
        primaryModel,
        catalog: {
          discoverModels: async () => { discoveries += 1; },
          listModels: async () => availableModels,
        },
      });
      assert.equal(candidate?.id, primaryModel);
      assert.equal(candidate?.value, primaryModel);
      assert.equal(discoveries, 0, primaryModel);
    }
  });

	test("bare transformed text cannot rewrite into a Cursor route", () => {
		const availableModels = [{ provider: "cursor", id: "route", fullId: "cursor/route" }];
		for (const primaryModel of ["route:high", " route ", "route (1m)"]) {
			assert.throws(
				() => buildModelCandidates({ primaryModel, availableModels }),
				(err: Error) => {
					assert.ok(err instanceof WorkflowModelValidationError);
					assert.match(err.message, /not available/u);
					return true;
				},
			);
		}
	});

  test("preserves an exact Cursor fallback route without applying generic thinking metadata", () => {
    const [candidate] = buildModelCandidates({
      fallbackModels: ["cursor/ route:high (1m)/exact "],
      fallbackThinkingLevels: ["max"],
      availableModels: [{
        provider: "cursor", id: " route:high (1m)/exact ", fullId: "cursor/ route:high (1m)/exact ",
      }],
    });
    assert.equal(candidate?.id, "cursor/ route:high (1m)/exact ");
    assert.equal(candidate?.reasoningLevel, undefined);
    assert.equal(candidate?.contextWindow, undefined);
  });

  test("rejects nonexact Cursor route variants before fallback", () => {
    const availableModels = [
      { provider: "cursor", id: "CaseRoute", fullId: "cursor/CaseRoute" },
      { provider: "cursor", id: "route", fullId: "cursor/route" },
    ];
    for (const primaryModel of ["cursor/caseroute", "cursor/ route ", "cursor/route:high", "cursor/route (1m)"]) {
      assert.throws(
        () => buildModelCandidates({ primaryModel, fallbackModels: ["openai/gpt-5-mini"], availableModels }),
        (err: Error) => {
          assert.ok(err instanceof WorkflowModelValidationError);
          assert.match(err.message, /Cursor routes must match the authenticated catalog exactly/);
          return true;
        },
      );
    }
  });

  test("Cursor model objects resolve to the live catalog occurrence, never the caller object", () => {
    const supplied = model("cursor", "cursor-grok-4.5-high");
    const live = { ...supplied, name: "Live Catalog Row" };
    const [candidate] = buildModelCandidates({
      primaryModel: supplied,
      availableModels: [...models, {
        provider: "cursor", id: live.id, fullId: `cursor/${live.id}`, model: live,
      }],
    });
    assert.equal(candidate?.value, live);
    assert.notEqual(candidate?.value, supplied);
  });

  test("a caller Cursor object with a fabricated api/baseUrl cannot bypass the live catalog", () => {
    const supplied = {
      ...model("cursor", "route"),
      api: "anthropic-messages",
      baseUrl: "https://caller.invalid/v1",
    } as Model<Api>;
    const live = model("cursor", "route");
    const [candidate] = buildModelCandidates({
      primaryModel: supplied,
      availableModels: [{ provider: "cursor", id: "route", fullId: "cursor/route", model: live }],
    });
    assert.equal(candidate?.value, live);
    assert.equal(typeof candidate?.value === "string" ? undefined : candidate?.value.api, "cursor-agent");
    assert.equal(typeof candidate?.value === "string" ? undefined : candidate?.value.baseUrl, "https://example.invalid");
  });

  test("a selected later duplicate Cursor object uses its ordinal's current live metadata", () => {
    const supplied = {
      ...model("cursor", "dup"),
      compat: { cursorRouting: { dup: { modelId: "dup", maxMode: true, supportsImages: false, catalogOccurrence: 1 } } },
    } as Model<Api>;
    const liveOcc0 = { ...model("cursor", "dup"), name: "occ0", compat: { cursorRouting: { dup: { modelId: "dup", maxMode: true, supportsImages: false, catalogOccurrence: 0 } } } } as Model<Api>;
    const liveOcc1 = { ...model("cursor", "dup"), name: "occ1", compat: { cursorRouting: { dup: { modelId: "dup", maxMode: false, supportsImages: false, catalogOccurrence: 1 } } } } as Model<Api>;
    const [candidate] = buildModelCandidates({
      primaryModel: supplied,
      availableModels: [
        { provider: "cursor", id: "dup", fullId: "cursor/dup", model: liveOcc0 },
        { provider: "cursor", id: "dup", fullId: "cursor/dup", model: liveOcc1 },
      ],
    });
    assert.equal(candidate?.value, liveOcc1);
    assert.notEqual(candidate?.value, supplied);
  });

  test("a caller Cursor object with an out-of-range ordinal falls back to the first live occurrence", () => {
    const supplied = {
      ...model("cursor", "dup"),
      compat: { cursorRouting: { dup: { modelId: "dup", maxMode: false, supportsImages: false, catalogOccurrence: 5 } } },
    } as Model<Api>;
    const liveOcc0 = { ...model("cursor", "dup"), name: "occ0" } as Model<Api>;
    const liveOcc1 = { ...model("cursor", "dup"), name: "occ1" } as Model<Api>;
    const [candidate] = buildModelCandidates({
      primaryModel: supplied,
      availableModels: [
        { provider: "cursor", id: "dup", fullId: "cursor/dup", model: liveOcc0 },
        { provider: "cursor", id: "dup", fullId: "cursor/dup", model: liveOcc1 },
      ],
    });
    assert.equal(candidate?.value, liveOcc0);
  });

  test("a caller Cursor object with a malformed non-integer ordinal falls back to the first live occurrence", () => {
    const liveOcc0 = { ...model("cursor", "dup"), name: "occ0" } as Model<Api>;
    const liveOcc1 = { ...model("cursor", "dup"), name: "occ1" } as Model<Api>;
    const availableModels = [
      { provider: "cursor", id: "dup", fullId: "cursor/dup", model: liveOcc0 },
      { provider: "cursor", id: "dup", fullId: "cursor/dup", model: liveOcc1 },
    ];
    // Each malformed runtime ordinal must NOT index liveMatches[1]; it must be
    // treated as structurally invalid and fall back to the first live occurrence.
    for (const catalogOccurrence of ["1", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      const supplied = {
        ...model("cursor", "dup"),
        api: "anthropic-messages",
        baseUrl: "https://caller.invalid/v1",
        compat: { cursorRouting: { dup: { modelId: "dup", maxMode: false, supportsImages: false, catalogOccurrence } } },
      } as unknown as Model<Api>;
      const [candidate] = buildModelCandidates({ primaryModel: supplied, availableModels });
      assert.equal(candidate?.value, liveOcc0, `ordinal ${String(catalogOccurrence)}`);
      assert.equal(typeof candidate?.value === "string" ? undefined : candidate?.value.api, "cursor-agent");
      assert.equal(typeof candidate?.value === "string" ? undefined : candidate?.value.baseUrl, "https://example.invalid");
    }
  });

  test("stale Cursor model objects reject before configured or current fallback", async () => {
    await assert.rejects(buildModelCandidatesFromCatalog({
      primaryModel: model("cursor", "old-synthetic-high"),
      fallbackModels: ["openai/gpt-5-mini"],
      catalog: {
        currentModel: "anthropic/claude-sonnet-4",
        discoverModels: async () => undefined,
        listModels: async () => models,
      },
    }), /cursor\/old-synthetic-high.*reselect/s);
  });

  test("Cursor model objects propagate catalog failure without current-model fallback", async () => {
    await assert.rejects(buildModelCandidatesFromCatalog({
      primaryModel: model("cursor", "cursor-grok-4.5-high"),
      catalog: {
        currentModel: "anthropic/claude-sonnet-4",
        discoverModels: async () => undefined,
        listModels: async () => { throw new Error("catalog failed"); },
      },
    }), /catalog failed/);
  });

  test("non-Cursor model objects retain pass-through behavior", () => {
    const supplied = model("anthropic", "custom-object");
    const [candidate] = buildModelCandidates({ primaryModel: supplied });
    assert.equal(candidate?.value, supplied);
  });

  test("workflow model objects require an exact lowercase Cursor provider", async () => {
    for (const provider of ["Cursor", "CURSOR", " cursor", "cursor "]) {
      const supplied = model(provider, "route");
      let discoveries = 0;
      const [candidate] = await buildModelCandidatesFromCatalog({
        primaryModel: supplied,
        catalog: {
          discoverModels: async () => { discoveries += 1; },
          listModels: async () => [{ provider: "cursor", id: "route", fullId: "cursor/route" }],
        },
      });
      assert.equal(candidate?.id, `${provider}/route`);
      assert.equal(candidate?.value, supplied);
      assert.equal(discoveries, 0, provider);
    }

    const selected = model("cursor", "route");
    let discoveries = 0;
    const [candidate] = await buildModelCandidatesFromCatalog({
      primaryModel: selected,
      catalog: {
        discoverModels: async () => { discoveries += 1; },
        listModels: async () => [{ provider: "cursor", id: "route", fullId: "cursor/route" }],
      },
    });
    assert.equal(candidate?.id, "cursor/route");
    // No live catalog Model object is available on the info, so the candidate
    // carries the exact full-ID string for live registry resolution, not the
    // caller object.
    assert.equal(candidate?.value, "cursor/route");
    assert.equal(discoveries, 1);
  });

  test("nonexact reasoning-like suffixes reject even when the base route exists", () => {
    assert.throws(
      () => buildModelCandidates({
        primaryModel: "cursor/cursor-grok-4.5-high:high",
        availableModels: [
          { provider: "cursor", id: "cursor-grok-4.5-high", fullId: "cursor/cursor-grok-4.5-high" },
        ],
      }),
      (err: Error) => {
        assert.ok(err instanceof WorkflowModelValidationError);
        assert.match(err.message, /Cursor routes must match the authenticated catalog exactly/);
        return true;
      },
    );
  });

  test("awaits Cursor discovery before reading the workflow catalog", async () => {
    let discovered = false;
    const [candidate] = await buildModelCandidatesFromCatalog({
      primaryModel: "cursor/live-route",
      catalog: {
        discoverModels: async () => { discovered = true; },
        listModels: async () => {
          assert.equal(discovered, true);
          return [{ provider: "cursor", id: "live-route", fullId: "cursor/live-route" }];
        },
      },
    });
    assert.equal(candidate?.id, "cursor/live-route");
  });


  test("strict Cursor APIs reject a stale exact list when authenticated discovery is absent", async () => {
    let listed = 0;
    const staleModels = [{ provider: "cursor", id: "stale-exact", fullId: "cursor/stale-exact" }];
    for (const invoke of [
      () => buildModelCandidatesFromCatalog({
        primaryModel: "cursor/stale-exact",
        catalog: { listModels: async () => { listed += 1; return staleModels; } },
      }),
      () => validateWorkflowModels({
        requests: [{ model: "cursor/stale-exact" }],
        catalog: { listModels: async () => { listed += 1; return staleModels; } },
      }),
    ]) {
      await assert.rejects(invoke, /authenticated Cursor model discovery is unavailable/u);
      assert.equal(listed, 0);
    }
  });
  test("does not delay non-Cursor workflows for Cursor discovery", async () => {
    let discoveries = 0;
    const [candidate] = await buildModelCandidatesFromCatalog({
      primaryModel: "openai/gpt-5-mini",
      catalog: {
        discoverModels: async () => { discoveries += 1; },
        listModels: async () => models,
      },
    });
    assert.equal(candidate?.id, "openai/gpt-5-mini");
    assert.equal(discoveries, 0);
  });

  test("Cursor discovery cancellation rejects before catalog lookup or fallback", async () => {
    const controller = new AbortController();
    let listed = false;
    controller.abort(new Error("cancelled discovery"));
    await assert.rejects(buildModelCandidatesFromCatalog({
      primaryModel: "cursor/live-route", fallbackModels: ["openai/gpt-5-mini"], signal: controller.signal,
      catalog: {
        discoverModels: async (signal) => { throw signal?.reason ?? new Error("cancelled"); },
        listModels: async () => { listed = true; return models; },
      },
    }), /cancelled discovery/u);
    assert.equal(listed, false);
  });

  test("workflow preflight discovery failure stops validation before catalog and fallback", async () => {
    let listed = false;
    await assert.rejects(validateWorkflowModels({
      requests: [{ model: "cursor/live-route", fallbackModels: ["openai/gpt-5-mini"] }],
      catalog: {
        currentModel: "openai/gpt-5-mini",
        discoverModels: async () => { throw new Error("Cursor discovery failed"); },
        listModels: async () => { listed = true; return models; },
      },
    }), /Cursor discovery failed/u);
    assert.equal(listed, false);
  });

  test("a bare former-legacy id resolves as ordinary non-Cursor without reserving Cursor discovery", async () => {
    const otherComposer = { provider: "openai", id: "composer-2", fullId: "openai/composer-2" };
    let discoveries = 0;
    const [candidate] = await buildModelCandidatesFromCatalog({
      primaryModel: "composer-2",
      fallbackModels: ["openai/gpt-5-mini"],
      catalog: {
        currentModel: "openai/gpt-5-mini",
        discoverModels: async () => { discoveries += 1; },
        listModels: async () => [...models, otherComposer],
      },
    });
    // Bare ids are ordinary non-Cursor references in workflows; the openai row wins.
    assert.equal(candidate?.id, "openai/composer-2");
    assert.equal(discoveries, 0);
  });

  test("only an explicit cursor/<id> reference reserves Cursor discovery and resolves the live route", async () => {
    let discoveries = 0;
    const [candidate] = await buildModelCandidatesFromCatalog({
      primaryModel: "cursor/composer-2",
      catalog: {
        discoverModels: async () => { discoveries += 1; },
        listModels: async () => [...models, { provider: "cursor", id: "composer-2", fullId: "cursor/composer-2" }],
      },
    });
    assert.equal(candidate?.id, "cursor/composer-2");
    assert.equal(discoveries, 1);
  });

  test("explicit non-Cursor qualification resolves the ordinary provider row", async () => {
    const [candidate] = await buildModelCandidatesFromCatalog({
      primaryModel: "openai/composer-2",
      catalog: {
        listModels: async () => [
          ...models,
          { provider: "openai", id: "composer-2", fullId: "openai/composer-2" },
        ],
      },
    });
    assert.equal(candidate?.id, "openai/composer-2");
  });
});
