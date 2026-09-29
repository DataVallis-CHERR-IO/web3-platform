import { onchainTable } from "ponder";

// Schema placeholder for Ponder chain tables (implemented in TASK-006)
export const placeholder = onchainTable("placeholder", (p) => ({
  id: p.text().primaryKey(),
}));
