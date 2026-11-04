import "./load-env";
import { connectDatabase } from "../lib/db";
import { getEnv } from "../lib/env";
import { seed } from "../lib/db/seed";
const url=getEnv().DATABASE_URL;
if(!url) throw new Error("DATABASE_URL required");
const {db,pool}=connectDatabase(url);
seed(db).then(()=>console.log("Synthetic UR-1042 seed complete")).finally(()=>pool.end());
