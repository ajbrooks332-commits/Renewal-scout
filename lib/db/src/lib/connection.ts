/**
 * Singleton pool and drizzle instance.
 * Kept in its own file so both index.ts and migrate.ts can import from here
 * without creating circular dependencies.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
