import "server-only";
import { sql, and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { rateLimitCounters } from "../db/schema";
export async function takeRate(db:Db,key:string,limit:number,windowMs:number):Promise<boolean> {
  const now=Date.now();
  const windowStart=new Date(Math.floor(now/windowMs)*windowMs);
  const [row]=await db.insert(rateLimitCounters).values({key,windowStart,count:1}).onConflictDoUpdate({
    target:[rateLimitCounters.key,rateLimitCounters.windowStart],
    set:{count:sql`${rateLimitCounters.count}+1`},
    setWhere:sql`${rateLimitCounters.count}<${limit}`,
  }).returning({count:rateLimitCounters.count});
  return Boolean(row);
}
export async function rateCount(db:Db,key:string,windowMs:number) {
  const windowStart=new Date(Math.floor(Date.now()/windowMs)*windowMs);
  const [row]=await db.select().from(rateLimitCounters).where(and(eq(rateLimitCounters.key,key),eq(rateLimitCounters.windowStart,windowStart)));
  return row?.count??0;
}
