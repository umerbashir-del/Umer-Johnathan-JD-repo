import "server-only";
import {and,asc,desc,eq,inArray} from "drizzle-orm";
import {z} from "zod";
import type {Database} from "../db";
import * as s from "../db/schema";
import type {SessionUser} from "../auth/access";
import {executeRoute,type RouteDefinition} from "./with-route";
import {HttpError} from "./errors";
import {businessNow,isDemoClock} from "../clock";
import {getEnv,type Env} from "../env";
import {uploadSchema,uploadDocument,verifySchema,verifyDocument} from "../cases/documents";
import {editSchema,flagSchema,editClaim} from "../cases/claims";
import {resolveSchema,resolveIssue} from "../cases/issues";
import {loadValidation} from "../validation/snapshot";
import {approve} from "../cases/approval";
import {startGroup} from "../orchestrator/run";
import {LIMITS} from "../config/limits";
import {writeAudit} from "../audit/write";
const approveSchema=z.object({packetVersionId:z.uuid(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),acknowledgement:z.string().trim().min(1).max(LIMITS.FREE_TEXT_MAX_CHARS)}).strict();
export type ApiDependencies={db:Database;session:()=>Promise<SessionUser|null>;schedule:(runGroupId:string)=>void;env?:Env};
export async function handleApi(request:Request,path:string[],deps:ApiDependencies):Promise<Response>{
 const [kind,id,operation]=path,method=request.method;
 let definition:RouteDefinition|undefined;
 const caseResource={kind:"case" as const,id};
 const caseRead=(handler:RouteDefinition["handler"]):RouteDefinition=>({action:"read_case",resource:caseResource,handler});
 if(kind==="cases"&&path.length===1&&method==="GET")definition={action:"list_cases",handler:async({db,user})=>{
  const status=new URL(request.url).searchParams.get("status");
  if(status&&!s.caseStatusEnum.enumValues.includes(status as typeof s.caseStatusEnum.enumValues[number]))throw new HttpError(400,"invalid_status");
  const rows=await db.select().from(s.cases).where(and(eq(s.cases.assignedTo,user.userId),status?eq(s.cases.status,status as typeof s.caseStatusEnum.enumValues[number]):undefined)).orderBy(asc(s.cases.dueAt),asc(s.cases.id));
  const issueRows=rows.length?await db.select().from(s.issues).where(and(inArray(s.issues.caseId,rows.map(row=>row.id)),eq(s.issues.status,"open"))):[];
  return rows.map(row=>({id:row.id,patientLabel:row.patientLabel,type:row.type,levelOfCare:row.levelOfCare,dueAt:row.dueAt,status:row.status,issueCount:issueRows.filter(issue=>issue.caseId===row.id).length,blockingIssueCount:issueRows.filter(issue=>issue.caseId===row.id&&issue.blocking).length,lastUpdatedAt:row.updatedAt,overdue:row.dueAt!==null&&row.dueAt<businessNow(deps.env??getEnv()),synthetic:true}));
 }};
 if(kind==="cases"&&id&&path.length===2&&method==="GET")definition=caseRead(async({db,caseId})=>{
  const [row]=await db.select().from(s.cases).where(eq(s.cases.id,caseId!));
  const [reviewPeriod]=await db.select().from(s.reviewPeriods).where(eq(s.reviewPeriods.caseId,caseId!)).orderBy(desc(s.reviewPeriods.version)).limit(1);
  const [authorization]=await db.select().from(s.authorizations).where(eq(s.authorizations.caseId,caseId!));
  const [latestPacketVersion]=await db.select().from(s.packetVersions).where(eq(s.packetVersions.caseId,caseId!)).orderBy(desc(s.packetVersions.version)).limit(1);
  const [group]=await db.select().from(s.runGroups).where(eq(s.runGroups.caseId,caseId!)).orderBy(desc(s.runGroups.startedAt)).limit(1);
  const env=deps.env??getEnv();return {case:row,reviewPeriod,authorization,latestPacketVersion:latestPacketVersion??null,latestRunGroupId:group?.id??null,demoClock:{enabled:isDemoClock(env),now:businessNow(env),timeZone:"America/New_York"},prototype:true};
 });
 if(kind==="cases"&&id&&path.length===3){
  if(operation==="documents"&&method==="GET")definition=caseRead(async({db,caseId})=>db.select({id:s.documents.id,type:s.documents.type,title:s.documents.title,author:s.documents.author,serviceDate:s.documents.serviceDate,version:s.documents.version,verificationState:s.documents.verificationState,receivedAt:s.documents.receivedAt}).from(s.documents).where(eq(s.documents.caseId,caseId!)).orderBy(asc(s.documents.receivedAt)));
  if(operation==="documents"&&method==="POST")definition={action:"upload_document",write:true,upload:true,schema:uploadSchema,resource:caseResource,handler:uploadDocument};
  if(operation==="runs"&&method==="POST")definition={action:"start_run",write:true,schema:z.object({}).strict(),resource:caseResource,handler:async({db,user,caseId})=>startGroup(db,caseId!,user.userId,deps.env)};
  if(operation==="claims"&&method==="GET")definition=caseRead(async({db,caseId})=>{
   const version=new URL(request.url).searchParams.get("packetVersion");
   if(version&&!z.uuid().safeParse(version).success)throw new HttpError(400,"invalid_packet_version");
   const [packet]=await db.select().from(s.packetVersions).where(and(eq(s.packetVersions.caseId,caseId!),version?eq(s.packetVersions.id,version):undefined)).orderBy(desc(s.packetVersions.version)).limit(1);
   if(version&&!packet)throw new HttpError(404,"not_found");if(!packet)return [];
   const rows=await db.select().from(s.claims).where(and(eq(s.claims.caseId,caseId!),eq(s.claims.packetVersionId,packet.id))).orderBy(asc(s.claims.position));
   const links=rows.length?await db.select({claimId:s.claimEvidence.claimId,span:s.evidenceSpans}).from(s.claimEvidence).innerJoin(s.evidenceSpans,eq(s.claimEvidence.evidenceSpanId,s.evidenceSpans.id)).where(inArray(s.claimEvidence.claimId,rows.map(row=>row.id))):[];
   const [approval]=await db.select().from(s.approvals).where(and(eq(s.approvals.packetVersionId,packet.id),eq(s.approvals.status,"valid")));
   return rows.map(row=>({...row,displayStatus:approval&&row.status!=="rejected"?"clinician_approved":row.status,evidence:links.filter(link=>link.claimId===row.id).map(link=>link.span)}));
  });
  if(operation==="issues"&&method==="GET")definition=caseRead(async({db,caseId})=>(await db.select().from(s.issues).where(eq(s.issues.caseId,caseId!))).map(issue=>({...issue,allowedResolutions:issue.type==="missing_document"?["attach_document"]:["verify_period"]})));
  if(operation==="validation"&&method==="GET")definition=caseRead(async({db,caseId})=>{const value=await loadValidation(db,caseId!);return {packetVersionId:value.packet?.id??null,contentHash:value.hash,report:value.report,blockers:value.blockers};});
  if(operation==="approve"&&method==="POST")definition={action:"approve",write:true,schema:approveSchema,resource:caseResource,handler:({db,user,caseId,body})=>approve(db,caseId!,user,approveSchema.parse(body))};
 }
 if(kind==="documents"&&id){
  if(path.length===2&&method==="GET")definition={action:"read_case",resource:{kind:"document",id},handler:async({db,caseId})=>{const [row]=await db.select().from(s.documents).where(and(eq(s.documents.id,id),eq(s.documents.caseId,caseId!)));return row;}};
  if(path.length===3&&operation==="verify"&&method==="POST")definition={action:"verify_document",write:true,schema:verifySchema,resource:{kind:"document",id},handler:async context=>{
   const document=await verifyDocument(context,id);
   let rerun:"started"|"refused"|"none"="none",runGroupId:string|undefined;
   if(document.verificationState==="verified"&&["intake","treatment_plan","progress_note"].includes(document.type)){
    try{const run=await startGroup(context.db,context.caseId!,context.user.userId,deps.env);runGroupId=run.runGroupId;rerun="started";}catch(error){if(!(error instanceof HttpError))throw error;rerun="refused";await writeAudit(context.db,{actor:context.user.userId,caseId:context.caseId!,action:"run_refused",objectType:"document",objectId:id,outcome:"refused",reasonCode:error.code});}
   }
   return {...document,rerun,...(runGroupId?{runGroupId}:{})};
  }};
 }
 if(kind==="claims"&&id){
  if(path.length===2&&method==="PATCH")definition={action:"edit_claim",write:true,schema:editSchema,resource:{kind:"claim",id},handler:context=>editClaim(context,id)};
  if(path.length===3&&operation==="flags"&&method==="POST")definition={action:"edit_claim",write:true,schema:flagSchema,resource:{kind:"claim",id},handler:context=>editClaim(context,id,true)};
 }
 if(kind==="issues"&&id&&path.length===3&&operation==="resolve"&&method==="POST")definition={action:"resolve_issue",write:true,schema:resolveSchema,resource:{kind:"issue",id},handler:context=>resolveIssue(context,id)};
 if(kind==="runs"&&id&&path.length===2&&method==="GET")definition={action:"read_case",resource:{kind:"run",id},handler:async({db})=>{
  const [group]=await db.select().from(s.runGroups).where(eq(s.runGroups.id,id));
  const rows=await db.select().from(s.agentRuns).where(eq(s.agentRuns.runGroupId,id)).orderBy(asc(s.agentRuns.createdAt));
  return {...group,costUsd:Number(group.costUsd),agents:rows.map(row=>({agent:row.agent,status:row.status,errorKind:row.errorKind,message:row.error,attempts:row.attempts,costUsd:Number(row.costUsd),startedAt:row.startedAt,finishedAt:row.finishedAt}))};
 }};
 if(!definition)return Response.json({error:{code:"not_found"}},{status:404});
 const response=await executeRoute(request,definition,deps);
 if(response.ok&&definition.write){
  const result:unknown=await response.clone().json();
  if(result&&typeof result==="object"&&"runGroupId" in result&&typeof result.runGroupId==="string")deps.schedule(result.runGroupId);
 }
 return response;
}
