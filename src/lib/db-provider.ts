// Centralized database provider detection.
// Used to branch raw SQL / JSON handling across the three supported backends:
//   - PostgreSQL (Supabase prod)
//   - MySQL / TiDB (migration target)
//   - SQLite (local dev)
// Keeping this in one place avoids scattered DATABASE_URL string checks
// that can drift (e.g. branching on "postgresql" alone misclassifies TiDB).

export type DbProvider = "postgresql" | "mysql" | "sqlite";

export function getDatabaseProvider(): DbProvider {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("postgresql")) return "postgresql";
  if (url.startsWith("mysql")) return "mysql";
  return "sqlite";
}

// SQLite stores notificationPrefs as a plain String? (no native JSON type);
// PostgreSQL and TiDB/MySQL declare it as Json? and accept an object.
// Use this to decide whether to JSON.stringify before writing.
export function storesJsonAsString(): boolean {
  return getDatabaseProvider() === "sqlite";
}
