import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { RouteContext } from "../http/with-route";
import * as s from "../db/schema";
import { getEnv, isHosted } from "../env";
import { LIMITS } from "../config/limits";
import { HttpError } from "../http/errors";
import { contentHash } from "../fixtures/ids";
import { takeRate } from "../http/rate-limit";
import { writeAudit } from "../audit/write";
import { recheckApproval } from "./approval";
export const uploadSchema=z.object({type:z.enum(["intake","treatment_plan","progress_note","authorization_record","policy","criteria_summary"]),title:z.string().trim().min(1).max(200),serviceDate:z.iso.date().nullable().optional(),author:z.string().trim().max(200).optional(),content:z.string().max(LIMITS.DOCUMENT_MAX_CHARS)}).strict();
export const verifySchema=z.object({decision:z.enum(["verified","rejected"]),reason:z.string().trim().min(1).max(LIMITS.FREE_TEXT_MAX_CHARS).optional()}).strict();
export async function uploadDocument({db,user,caseId,body}:RouteContext){
 const input=uploadSchema.parse(body),env=getEnv();
 if(input.type==="policy"||input.type==="criteria_summary")throw new HttpError(422,"seed_only_type");
 if(!input.content.trim())throw new HttpError(422,"empty_document");
 if(!await takeRate(db,`upload:user:${user.userId}`,LIMITS.USER_UPLOADS_PER_HOUR,3600000))throw new HttpError(429,"rate_limited");
 const hash=contentHash(input.content);
 const [allow]=await db.select().from(s.uploadAllowlist).where(and(eq(s.uploadAllowlist.caseId,caseId!),eq(s.uploadAllowlist.contentHash,hash)));
 const allowlisted=allow&&allow.type===input.type;
 if(!allowlisted&&(isHosted(env)||!env.FREEFORM_UPLOAD_ENABLED))throw new HttpError(422,"not_allowlisted");
 const [count]=await db.select({count:sql<number>`count(*)::int`,chars:sql<number>`coalesce(sum(length(${s.documents.content})),0)::int`}).from(s.documents).where(eq(s.documents.caseId,caseId!));
 if(count.count>=LIMITS.CASE_MAX_DOCUMENTS||count.chars+input.content.length>LIMITS.CASE_MAX_CHARS)throw new HttpError(413,"case_document_limit");
 const [document]=await db.insert(s.documents).values({id:randomUUID(),caseId,type:input.type,title:allowlisted?allow.title:input.title,author:allowlisted?allow.author:input.author??null,serviceDate:allowlisted?allow.serviceDate:input.serviceDate??null,content:input.content,contentHash:hash,version:1,verificationState:"unverified",origin:allowlisted?"allowlisted_upload":"local_freeform",uploadedBy:user.userId}).returning();
 await writeAudit(db,{actor:user.userId,caseId:caseId!,action:"document_uploaded",objectType:"document",objectId:document.id});
 await recheckApproval(db,caseId!,user.userId);
 return document;
}
export async function verifyDocument(context:RouteContext,documentId:string){
 const {db,user,caseId}=context,input=verifySchema.parse(context.body);
 const [document]=await db.select().from(s.documents).where(and(eq(s.documents.id,documentId),eq(s.documents.caseId,caseId!)));
 if(!document)throw new HttpError(404,"not_found");
 if(document.verificationState!=="unverified")throw new HttpError(409,"already_decided");
 if(input.decision==="rejected"&&!input.reason)throw new HttpError(400,"reason_required");
 const [updated]=await db.update(s.documents).set({verificationState:input.decision,verifiedBy:user.userId,verifiedAt:new Date(),verificationSource:"user",rejectionReason:input.decision==="rejected"?input.reason:null}).where(eq(s.documents.id,documentId)).returning();
 await writeAudit(db,{actor:user.userId,caseId:caseId!,action:"document_verified",objectType:"document",objectId:documentId});
 await recheckApproval(db,caseId!,user.userId,input.decision==="verified"&&["intake","treatment_plan","progress_note","authorization_record"].includes(document.type)?"verified_source_added":undefined);
 return updated;
}
