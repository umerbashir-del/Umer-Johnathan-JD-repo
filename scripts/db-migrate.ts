import "./load-env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connectDatabase } from "../lib/db";
import { getEnv } from "../lib/env";
import { installSecurity } from "../lib/db/security";
const url=getEnv().DATABASE_URL;
if(!url)throw new Error("DATABASE_URL required");
const {db,pool}=connectDatabase(url);
async function main(){await migrate(db,{migrationsFolder:"migrations"});await installSecurity(db);console.log("Backend migrations and grants applied");}
main().finally(()=>pool.end());
