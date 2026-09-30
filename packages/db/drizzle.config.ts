import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["app"],
  migrations: {
    // Store the Drizzle migrations journal in schema `app`, not `public`
    schema: "app",
    table: "__drizzle_migrations",
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://cherrio:cherrio@localhost:5432/cherrio_dev",
  },
});
