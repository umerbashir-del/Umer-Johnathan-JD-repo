import { defineConfig } from "drizzle-kit";
export default defineConfig({schema:"./lib/db/schema.ts",out:"./migrations",dialect:"postgresql"});
