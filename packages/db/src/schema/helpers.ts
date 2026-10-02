import { customType, uuid } from "drizzle-orm/pg-core";
import { v7 } from "uuid";

/**
 * Drizzle custom type: Postgres bytea ↔ TypeScript Buffer.
 * Used for raw binary columns (hashes, IDs).
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value: Buffer): Buffer {
    return value;
  },
  toDriver(value: Buffer): Buffer {
    return value;
  },
});

/**
 * UUID v7 primary key — generated in application, sortable by time.
 * Postgres 16 has no native uuidv7(); we generate in TS via the `uuid` package.
 */
export function uuidPk() {
  return uuid("id")
    .primaryKey()
    .$defaultFn(() => v7());
}

/** A new UUID v7, for rows whose id must be known before the insert (e.g. a storage key). */
export function newId(): string {
  return v7();
}

/**
 * UUID v7 column (non-PK).
 * Usage: uuidV7Col("col_name")
 */
export function uuidV7Col(name: string) {
  return uuid(name).$defaultFn(() => v7());
}

/**
 * Drizzle custom type: Postgres numeric(78,0) ↔ TypeScript bigint.
 * Covers the full uint256 range (max 2^256-1, 78 decimal digits).
 * Never use a JS `number` or float for USDC amounts.
 */
export const numeric78 = customType<{ data: bigint; driverData: string }>({
  dataType() {
    return "numeric(78,0)";
  },
  fromDriver(value: string): bigint {
    return BigInt(value);
  },
  toDriver(value: bigint): string {
    return value.toString();
  },
});
