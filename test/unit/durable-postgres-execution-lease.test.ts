import { test } from "bun:test";
import assert from "node:assert/strict";
import { PostgresExecutionLeaseRegistry, type PostgresLeaseClient } from "../../packages/workflows/src/durable/postgres-execution-lease.js";

function fakePostgresFactory(): () => Promise<PostgresLeaseClient> {
  const locks = new Set<string>();
  return async () => {
    let held: string | undefined;
    return {
      async connect() {},
      async query<Row>(sql: string, values: readonly string[]) {
        const key = values.join(":");
        if (sql.includes("try_advisory_lock")) {
          const claimed = !locks.has(key);
          if (claimed) { locks.add(key); held = key; }
          return { rows: [{ claimed } as Row] };
        }
        if (sql.includes("advisory_unlock")) { locks.delete(key); held = undefined; }
        return { rows: [] };
      },
      async end() {
        if (held !== undefined) locks.delete(held);
        held = undefined;
      },
    };
  };
}

test("Postgres advisory leases exclude the same workflow across independent hosts", async () => {
  const factory = fakePostgresFactory();
  const first = new PostgresExecutionLeaseRegistry("postgres://host-a/db", factory);
  const second = new PostgresExecutionLeaseRegistry("postgres://host-b/db", factory);

  assert.equal(await first.claim("wf-shared"), true);
  assert.equal(await second.claim("wf-shared"), false);
  assert.equal(second.active("wf-shared"), true);

  await first.release("wf-shared");
  assert.equal(await second.claim("wf-shared"), true);
  await second.release("wf-shared");
});

test("a dropped Postgres connection releases lease ownership so another process can reclaim", async () => {
  const locks = new Set<string>();
  let dropOwner: (() => void) | undefined;
  const factory = async (): Promise<PostgresLeaseClient> => {
    let held: string | undefined;
    const handlers: Array<() => void> = [];
    return {
      async connect() {},
      async query<Row>(sql: string, values: readonly string[]) {
        const key = values.join(":");
        if (sql.includes("try_advisory_lock")) {
          const claimed = !locks.has(key);
          if (claimed) { locks.add(key); held = key; }
          return { rows: [{ claimed } as Row] };
        }
        if (sql.includes("advisory_unlock")) { locks.delete(key); held = undefined; }
        return { rows: [] };
      },
      async end() { if (held !== undefined) locks.delete(held); held = undefined; },
      on(_event, handler) {
        handlers.push(() => handler());
        // PostgreSQL frees the session advisory lock when the connection drops.
        dropOwner = () => { if (held !== undefined) locks.delete(held); held = undefined; for (const h of handlers) h(); };
      },
    };
  };
  const registry = new PostgresExecutionLeaseRegistry("postgres://host/db", factory);
  assert.equal(await registry.claim("wf-drop"), true);
  assert.equal(registry.active("wf-drop"), true);
  // Simulate the owning connection dropping (crash/failover).
  dropOwner?.();
  assert.equal(registry.active("wf-drop"), false);
  const contender = new PostgresExecutionLeaseRegistry("postgres://host/db", factory);
  assert.equal(await contender.claim("wf-drop"), true);
  await contender.release("wf-drop");
});
