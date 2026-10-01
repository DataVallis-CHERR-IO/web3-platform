import { createDb, type Database } from "@cherrio/db";

let dbInstance: Database | null = null;
let directDbInstance: Database | null = null;

/**
 * Returns the application database client (PgBouncer pooled in production).
 */
export function getDb(): Database {
  if (!dbInstance) {
    const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_DIRECT;
    if (!url) {
      throw new Error("DATABASE_URL is not set.");
    }
    dbInstance = createDb(url);
  }
  return dbInstance;
}

/**
 * Returns the direct database client (bypasses PgBouncer).
 * Used for session-critical transactions such as GDPR right-to-erasure (eraseUser).
 */
export function getDirectDb(): Database {
  if (!directDbInstance) {
    const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL_DIRECT is not set.");
    }
    directDbInstance = createDb(url);
  }
  return directDbInstance;
}
