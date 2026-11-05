import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database, Db } from "../db";
import * as s from "../db/schema";
import { getEnv, type Env } from "../env";
import { LIMITS } from "../config/limits";
import { ACCESS_RULES, checkRole, checkCaseAccess, type Action, type SessionUser } from "../auth/access";
import { withCaseLock } from "../cases/lock";
import { writeAudit } from "../audit/write";
import { HttpError } from "./errors";
import { caseAccessRecord } from "../auth/case-scope";
export type RouteContext={db:Db;user:SessionUser;caseId:string|null;body:unknown;request:Request};
type RouteResource={kind:"case"|"document"|"claim"|"issue"|"run";id:string};
type RouteOptions={write?:boolean;upload?:boolean;schema?:z.ZodType;handler:(context:RouteContext)=>Promise<unknown>};
export type RouteDefinition=RouteOptions & (
 {action:"list_cases";resource?:never} |
 {action:Exclude<Action,"list_cases">;resource:RouteResource}
);
export async function readBody(request:Request,cap:number):Promise<unknown> {
 const length=request.headers.get("content-length");
 if(length!==null && (!/^\d+$/.test(length)||Number(length)>cap)) throw new HttpError(413,"body_too_large");
 if(!request.body) return {};
 const reader=request.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>cap){await reader.cancel();throw new HttpError(413,"body_too_large");}chunks.push(value);}
 const data=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(data)||"{}");}catch{throw new HttpError(400,"invalid_json");}
}
async function resolveCase(db:Db,resource:NonNullable<RouteDefinition["resource"]>):Promise<string|null>{
 if(resource.kind==="case")return resource.id;
 const table={document:s.documents,claim:s.claims,issue:s.issues,run:s.runGroups}[resource.kind];
 const [row]=await db.select({caseId:table.caseId}).from(table).where(eq(table.id,resource.id));
 return row?.caseId??null;
}
export async function executeRoute(request:Request,definition:RouteDefinition,deps:{db:Database;session:()=>Promise<SessionUser|null>;env?:Env}):Promise<Response>{
 let actor="anonymous",caseId:string|null=null,safeObjectId:string|undefined;
 const db=deps.db;
 try{
  const env=deps.env??getEnv();
  if(definition.write){
   const origin=request.headers.get("origin");
   if(!env.APP_ORIGIN||origin!==new URL(env.APP_ORIGIN).origin) throw new HttpError(403,"origin_refused");
  }
  const user=await deps.session();
  actor=user?.userId??"anonymous";
  const decision=checkRole(user,definition.action);
  if(!decision.allowed)throw new HttpError(decision.status,decision.status===401?"unauthorized":"forbidden");
  if(ACCESS_RULES[definition.action].caseScoped&&!definition.resource)throw new HttpError(403,"resource_required");
  let body:unknown={};
  if(definition.write){
   if(request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/json")throw new HttpError(400,"json_required");
   body=await readBody(request,definition.upload?LIMITS.BODY_CAP_UPLOAD_BYTES:LIMITS.BODY_CAP_DEFAULT_BYTES);
   const parsed=(definition.schema??z.object({}).strict()).safeParse(body);
   if(!parsed.success)throw new HttpError(400,"invalid_body");
   body=parsed.data;
  }
  if(definition.resource){
   if(definition.resource.kind!=="case"&&!z.uuid().safeParse(definition.resource.id).success)throw new HttpError(404,"not_found");
   if(definition.resource.kind!=="case")safeObjectId=definition.resource.id;
   const resolvedCaseId=await resolveCase(db,definition.resource);
   if(!resolvedCaseId)throw new HttpError(404,"not_found");
   const row=await caseAccessRecord(db,resolvedCaseId,user!);
   if(row){caseId=resolvedCaseId;if(definition.resource.kind==="case")safeObjectId=caseId;}
   const access=checkCaseAccess(user,definition.action,row??null);
   if(!access.allowed)throw new HttpError(access.status,"not_found");
  }
  const context:RouteContext={db,user:user!,caseId,body,request};
  const invoke=async(tx:Db)=>{
   // A request can wait on the case lock after its session was read. Re-read
   // and hold the identity row so revoked roles cannot complete queued writes.
   const [identity]=await tx.select({id:s.users.id,role:s.users.role}).from(s.users).where(eq(s.users.id,user!.userId)).for("share");
   if(!identity)throw new HttpError(401,"unauthorized");
   const currentUser:SessionUser={userId:identity.id,role:identity.role};
   if(!checkRole(currentUser,definition.action).allowed)throw new HttpError(403,"forbidden");
   if(caseId){
    const row=await caseAccessRecord(tx,caseId,currentUser);
    if(!checkCaseAccess(currentUser,definition.action,row).allowed)throw new HttpError(404,"not_found");
   }
   return definition.handler({...context,user:currentUser,db:tx});
  };
  const result=(definition.write||definition.action==="read_packet")&&caseId?await withCaseLock(db,caseId,invoke):await invoke(db);
  if(result && typeof result==="object" && "error" in result && result.error instanceof HttpError)throw result.error;
  return Response.json(result,{headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
 }catch(error){
  const known=error instanceof HttpError;
  const status=known?error.status:503,code=known?error.code:"service_unavailable";
  // Never return SQL, credential, document or model text in errors.
  if(definition.write){
   try{await writeAudit(db,{actor,caseId:caseId??undefined,action:"action_refused",objectType:definition.resource?.kind??"request",objectId:safeObjectId,outcome:"refused",reasonCode:code});}catch{return Response.json({error:{code:"audit_unavailable"}},{status:503});}
  }
  return Response.json({error:{code,...(known?error.details:{})}},{status,headers:{"Cache-Control":"no-store"}});
 }
}
