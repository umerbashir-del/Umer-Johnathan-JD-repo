import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import { auditEvents } from "../db/schema";
export async function writeAudit(db: Db, event: {
  actor: string; actorType?: "user"|"agent"|"system"; caseId?: string; action: string;
  objectType: string; objectId?: string; outcome?: "success"|"refused"|"failed"; reasonCode?: string;
}) {
  await db.insert(auditEvents).values({id:randomUUID(),actorType:"user",outcome:"success",...event});
}
