import "server-only";
import { eq } from "drizzle-orm";
import type { Database, Transaction } from "../db";
import { cases } from "../db/schema";
import { HttpError } from "../http/errors";
export function withCaseLock<T>(db:Database,caseId:string,fn:(tx:Transaction)=>Promise<T>):Promise<T> {
  return db.transaction(async tx=>{
    const [row]=await tx.select().from(cases).where(eq(cases.id,caseId)).for("update");
    if(!row) throw new HttpError(404,"not_found");
    return fn(tx);
  });
}
