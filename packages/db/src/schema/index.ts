import { pgSchema } from "drizzle-orm/pg-core";

// App schema definition (Ponder owns "chain" schema)
export const appSchema = pgSchema("app");
