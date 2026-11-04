import "server-only";
import {randomUUID} from "node:crypto";
import {and,eq,desc,inArray} from "drizzle-orm";
import {z} from "zod";
import type {RouteContext} from "../http/with-route";
import * as s from "../db/schema";
import {LIMITS} from "../config/limits";
import {HttpError} from "../http/errors";
import {writeAudit} from "../audit/write";
import {scanText} from "../orchestrator/accept/boundary";
import {refreshPacketHash} from "../validation/snapshot";
import {transition} from "./transition";
import {recheckApproval} from "./approval";
export const editSchema=z.union([z.object({text:z.string().trim().min(1).max(LIMITS.CLAIM_TEXT_MAX_CHARS)}).strict(),z.object({status:z.literal("rejected")}).strict()]);
export const flagSchema=z.object({reason:z.string().trim().min(1).max(LIMITS.FREE_TEXT_MAX_CHARS)}).strict();
const contentSchema=z.object({sections:z.array(z.object({heading:z.string(),claimIds:z.array(z.uuid())}))});
export async function editClaim(context:RouteContext,claimId:string,flag=false){
 const {db,user,caseId}=context;
 const input=flag?flagSchema.parse(context.body):editSchema.parse(context.body);
 let [claim]=await db.select().from(s.claims).where(and(eq(s.claims.id,claimId),eq(s.claims.caseId,caseId!)));
 if(!claim)throw new HttpError(404,"not_found");
 const [latest]=await db.select().from(s.packetVersions).where(eq(s.packetVersions.caseId,caseId!)).orderBy(desc(s.packetVersions.version)).limit(1);
 if(!latest||claim.packetVersionId!==latest.id)throw new HttpError(409,"stale_packet");
 if(claim.status==="rejected")throw new HttpError(409,"claim_rejected");
 if(!flag&&"text" in input&&input.text===claim.text)return claim;
 const [history]=await db.select().from(s.approvals).where(eq(s.approvals.packetVersionId,latest.id)).limit(1);
 let packetId=latest.id;
 if(history){
  packetId=randomUUID();
  const oldClaims=await db.select().from(s.claims).where(eq(s.claims.packetVersionId,latest.id));
  const ids=new Map(oldClaims.map(row=>[row.id,randomUUID()]));
  const content=contentSchema.parse(latest.content);
  await db.insert(s.packetVersions).values({...latest,id:packetId,version:latest.version+1,content:{sections:content.sections.map(section=>({...section,claimIds:section.claimIds.map(id=>ids.get(id)!)}))},includedClaimIds:latest.includedClaimIds.map(id=>ids.get(id)!),createdAt:new Date()});
  await db.insert(s.claims).values(oldClaims.map(row=>({...row,id:ids.get(row.id)!,packetVersionId:packetId,createdAt:new Date()})));
  const links=oldClaims.length?await db.select().from(s.claimEvidence).where(inArray(s.claimEvidence.claimId,oldClaims.map(row=>row.id))):[];
  if(links.length)await db.insert(s.claimEvidence).values(links.map(link=>({...link,claimId:ids.get(link.claimId)!,createdAt:new Date()})));
  claim={...claim,id:ids.get(claim.id)!,packetVersionId:packetId};
 }
 const change=flag?{status:"unsupported" as const}:"text" in input?{text:input.text,status:"clinician_edited" as const,sourceKind:"clinician_text" as const,originalText:claim.originalText??claim.text,boundaryFlagged:scanText(input.text,[]).length>0}:{status:"rejected" as const};
 const [updated]=await db.update(s.claims).set(change).where(eq(s.claims.id,claim.id)).returning();
 if(updated.status==="rejected"){
  const [packet]=await db.select().from(s.packetVersions).where(eq(s.packetVersions.id,packetId));
  const content=contentSchema.parse(packet.content);
  await db.update(s.packetVersions).set({includedClaimIds:packet.includedClaimIds.filter(id=>id!==updated.id),content:{sections:content.sections.map(section=>({...section,claimIds:section.claimIds.filter(id=>id!==updated.id)}))}}).where(eq(s.packetVersions.id,packetId));
 }
 await writeAudit(db,{actor:user.userId,caseId:caseId!,action:flag?"citation_flagged":"claim_edited",objectType:"claim",objectId:updated.id});
 // A new version must invalidate history even before its new hash is stored.
 if(history&&history.status==="valid"){
  await db.update(s.approvals).set({status:"invalidated",invalidatedAt:new Date(),invalidatedReason:"claim_changed"}).where(eq(s.approvals.id,history.id));
  await writeAudit(db,{actor:user.userId,caseId:caseId!,action:"approval_invalidated",objectType:"approval",objectId:history.id});
 }
 await transition(db,caseId!,"needs_review",user.userId,flag?"citation_flagged":"claim_edited");
 await recheckApproval(db,caseId!,user.userId);
 await refreshPacketHash(db,caseId!,packetId);
 return updated;
}
