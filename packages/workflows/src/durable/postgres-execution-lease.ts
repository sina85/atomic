interface QueryResult<Row> { readonly rows: readonly Row[] }
export interface PostgresLeaseClient {
  connect(): Promise<void>;
  query<Row>(sql: string, values: readonly string[]): Promise<QueryResult<Row>>;
  end(): Promise<void>;
}
interface PgModule { readonly Client: new (config: { readonly connectionString: string }) => PostgresLeaseClient }

const LOCK_KEY = "atomic-workflow-execution";
const CLAIM_SQL = "SELECT pg_try_advisory_lock(hashtextextended($1 || ':' || $2, 0)) AS claimed";
const RELEASE_SQL = "SELECT pg_advisory_unlock(hashtextextended($1 || ':' || $2, 0))";

export class PostgresExecutionLeaseRegistry {
  private readonly owners = new Map<string, PostgresLeaseClient>();
  private readonly externallyActive = new Set<string>();

  constructor(private readonly databaseUrl: string, private readonly clientFactory?: () => Promise<PostgresLeaseClient>) {}

  async claim(workflowId: string): Promise<boolean> {
    if (this.owners.has(workflowId)) return false;
    const client = await this.createClient();
    try {
      const result = await client.query<{ readonly claimed: boolean }>(CLAIM_SQL, [LOCK_KEY, workflowId]);
      if (result.rows[0]?.claimed !== true) {
        await client.end();
        this.externallyActive.add(workflowId);
        return false;
      }
      this.externallyActive.delete(workflowId);
      this.owners.set(workflowId, client);
      return true;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  async release(workflowId: string): Promise<void> {
    const client = this.owners.get(workflowId);
    if (client === undefined) return;
    this.owners.delete(workflowId);
    try {
      await client.query(RELEASE_SQL, [LOCK_KEY, workflowId]);
    } finally {
      await client.end();
    }
  }

  active(workflowId: string): boolean {
    return this.owners.has(workflowId) || this.externallyActive.has(workflowId);
  }

  async refresh(workflowIds: readonly string[]): Promise<void> {
    for (const workflowId of workflowIds) {
      if (this.owners.has(workflowId)) continue;
      const claimed = await this.claim(workflowId);
      if (claimed) await this.release(workflowId);
    }
  }

  async reset(): Promise<void> {
    await Promise.all([...this.owners].map(([workflowId]) => this.release(workflowId)));
    this.externallyActive.clear();
  }

  private async createClient(): Promise<PostgresLeaseClient> {
    if (this.clientFactory !== undefined) return await this.clientFactory();
    const specifier = "pg";
    const module = await import(specifier) as PgModule;
    const client = new module.Client({ connectionString: this.databaseUrl });
    await client.connect();
    return client;
  }
}
