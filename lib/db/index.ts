import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getEnv } from "../env";
import * as schema from "./schema";
export function connectDatabase(url: string) {
  const pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  return { db: drizzle(pool, { schema }), pool };
}
export type Database = ReturnType<typeof connectDatabase>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Db = Database | Transaction;
let connection: ReturnType<typeof connectDatabase> | undefined;
export function getDb(): Database {
  const url = getEnv().DATABASE_URL;
  if (!url) throw new Error("database_unavailable");
  connection ??= connectDatabase(url);
  return connection.db;
}
