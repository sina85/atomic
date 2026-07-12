import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { TransitiveUsageAggregator } from "../../packages/coding-agent/src/core/transitive-usage.ts";

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

describe("transitive usage reconciliation ordering", () => {
	test("settled descendant reports cannot be downgraded by delayed interim updates", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(100, 10), settled: true });
		aggregator.attributeDescendantUsage({ rootSessionId: "root", childRunId: "live", kind: "subagent", usage: usage(10, 1), settled: false });
		const result = aggregator.getTransitiveUsage();
		assert.equal(result.descendants.input, 100);
		assert.equal(result.descendants.cost.total, 10);
		assert.equal(result.complete, true);
	});

	test("older reconciliation results cannot overwrite newer completeness", () => {
		const aggregator = new TransitiveUsageAggregator("root", () => usage(0, 0));
		const olderReconciliation = aggregator.beginReconciliation();
		const newerReconciliation = aggregator.beginReconciliation();
		aggregator.reconcile([], false, { reconciliationId: newerReconciliation });
		aggregator.reconcile([], true, { reconciliationId: olderReconciliation });
		assert.equal(aggregator.getTransitiveUsage().complete, false);
	});
});
