import { createHash } from "node:crypto";

export function dbosLeaseNamespace(databaseUrl: string): string {
  let identity = databaseUrl;
  try {
    const parsed = new URL(databaseUrl);
    const port = parsed.port || "5432";
    identity = `postgres://${parsed.hostname.toLowerCase()}:${port}${parsed.pathname}`;
  } catch {
    // Non-URL SDK connection strings remain isolated by their exact value.
  }
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}
