import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.NEON_DATABASE_URL_DIRECT ?? "",
  },
  strict: true,
  verbose: true,
});
