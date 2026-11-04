import "server-only";
import { randomUUID } from "node:crypto";
import { and,desc,eq } from "drizzle-orm";
import { z } from "zod";
import type { RouteContext } from "../http/with-route";
import * as s from "../db/schema";
import { LIMITS } from "../config/limits";
import { HttpError } from "../http/errors";
import { writeAudit } from "../audit/write";
import { recheckApproval } from "./approval";
import { refreshPacketHash } from "../validation/snapshot";
export const resolveSchema=z.object({resolution:z.enum(["attach_document","verify_period"]),reason:z.string().trim().min(1).max(LIMITS.FREE_TEXT_MAX_CHARS),evidenceDocumentId:z.uuid(),verifiedPeriod:z.object({start:z.iso.date(),end:z.iso.date()}).strict().optional()}).strict();
export async function resolveIssue({db,user,caseId,body}:RouteContext,issueId:string){
 const input=resolveSchema.parse(body);
 const [issue]=await db.select().from(s.issues).where(and(eq(s.issues.id,issueId),eq(s.issues.caseId,caseId!)));
 if(!issue)throw new HttpError(404,"not_found");
 if(issue.status==="resolved")throw new HttpError(409,"already_resolved");
 const [document]=await db.select().from(s.documents).where(and(eq(s.documents.id,input.evidenceDocumentId),eq(s.documents.caseId,caseId!)));
 if(!document)throw new HttpError(404,"not_found");
 if(document.verificationState!=="verified")throw new HttpError(422,"closure_refused",{rule:"verified_source_required"});
 if(issue.type==="missing_document"){
  const qualityFinding=issue.source==="independent_quality"&&issue.requiredDocumentType===null&&issue.requiredServiceDate===null;
  const matchesRequirement=qualityFinding?["intake","treatment_plan","progress_note","authorization_record"].includes(document.type):document.type===issue.requiredDocumentType&&document.serviceDate===issue.requiredServiceDate;
  if(input.resolution!=="attach_document"||!matchesRequirement||!document.author?.trim()||!document.content.trim())throw new HttpError(422,"closure_refused",{rule:"valid_document_required"});
 }else if(issue.type==="date_conflict"){
  if(input.resolution!=="verify_period"||!input.verifiedPeriod||input.verifiedPeriod.start>input.verifiedPeriod.end)throw new HttpError(422,"closure_refused",{rule:"verified_period_required"});
  const [period]=await db.select().from(s.reviewPeriods).where(eq(s.reviewPeriods.caseId,caseId!)).orderBy(desc(s.reviewPeriods.version)).limit(1);
  // The cited request supports its exact dates; this action never edits an authorization.
  if(!period||period.sourceDocumentId!==document.id||input.verifiedPeriod.start!==period.requestedStart||input.verifiedPeriod.end!==period.requestedEnd)throw new HttpError(422,"closure_refused",{rule:"period_source_mismatch"});
  await db.insert(s.reviewPeriods).values({id:randomUUID(),caseId:caseId!,requestedStart:input.verifiedPeriod.start,requestedEnd:input.verifiedPeriod.end,reviewPoint:period.reviewPoint,version:period.version+1,sourceDocumentId:document.id,verifiedBy:user.userId,verifiedAt:new Date(),verificationReason:input.reason});
 }else throw new HttpError(422,"closure_refused");
 const [updated]=await db.update(s.issues).set({status:"resolved",resolution:input.resolution,resolutionReason:input.reason,resolutionEvidenceId:document.id,resolvedBy:user.userId,resolvedAt:new Date()}).where(eq(s.issues.id,issueId)).returning();
 await writeAudit(db,{actor:user.userId,caseId:caseId!,action:"issue_resolved",objectType:"issue",objectId:issueId});
 await recheckApproval(db,caseId!,user.userId);
 const [packet]=await db.select().from(s.packetVersions).where(eq(s.packetVersions.caseId,caseId!)).orderBy(desc(s.packetVersions.version)).limit(1);
 if(packet)await refreshPacketHash(db,caseId!,packet.id);
 return updated;
}
