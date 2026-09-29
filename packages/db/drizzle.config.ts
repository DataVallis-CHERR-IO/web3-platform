import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["app"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://cherrio:cherrio@localhost:5432/cherrio_dev",
  },
});
