import "./load-env";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {and,eq,sql} from "drizzle-orm";
import {connectDatabase} from "../lib/db";
import * as s from "../lib/db/schema";
import {seed,DEMO_USER_ID} from "../lib/db/seed";
import {getEnv} from "../lib/env";
import {handleApi} from "../lib/http/api";
import {executeGroup} from "../lib/orchestrator/run";
import {parseFrontMatter} from "../lib/fixtures/load-fixture";
import type {ClaudeClient} from "../lib/harness/run-agent";
import {testSpendLedger} from "./spend-integration";
import {testApproval} from "./approval-integration";
import {testAuth} from "./auth-integration";
import {createSpendLedger} from "../lib/db/spend-ledger";
const env=getEnv();
const url=env.DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith("_test"))throw new Error("Integration requires an isolated DATABASE_URL ending _test");
const {db,pool}=connectDatabase(url);
let actor:{userId:string;role:string}|null={userId:DEMO_USER_ID,role:"clinician"};
const scheduled:string[]=[];
const integrationEnv={...env,AGENT_REPLAY:true,APP_ORIGIN:"http://localhost:3000"};
async function api(method:string,path:string,body?:unknown){
 return handleApi(new Request(`http://localhost:3000/api/${path}`,{method,headers:{"Content-Type":"application/json",Origin:"http://localhost:3000"},...(body===undefined?{}:{body:JSON.stringify(body)})}),path.split("/"),{db,session:async()=>actor,schedule:id=>scheduled.push(id),env:integrationEnv});
}
async function okay(method:string,path:string,body?:unknown){const response=await api(method,path,body);const data=await response.json();assert.equal(response.status,200,`${method} ${path}: ${JSON.stringify(data)}`);return data;}
function fakeClient(fail=false,counter={calls:0}):ClaudeClient{
 return {messages:{parse:async params=>{
  counter.calls++;
  if(fail)throw new Error("synthetic_failure_no_live_call");
  const system=JSON.stringify(params.system);
  // Select a stable literal source without asserting model prose.
  const rows=await db.select().from(s.documents).where(and(eq(s.documents.caseId,"UR-1042"),eq(s.documents.type,"progress_note")));
  const note=rows.find(row=>row.serviceDate==="2026-11-03")!;
  const quote=note.content.split("\n").find(line=>line.trim().length>30)!;
  let output:unknown;
  if(system.includes("Clinical Documentation agent"))output={facts:[{id:"f1",category:"symptoms",statement:quote,serviceDate:note.serviceDate,quotes:[{documentId:note.id,text:quote}]}],gaps:[]};
  else if(system.includes("Case Assembly and Drafting agent"))output={mode:"review_packet",sections:[{heading:"Current documentation",claims:[{text:quote,sourceKind:"extracted_fact",factIds:["f1"]}]}],openQuestions:[]};
  else output={checks:[{name:"support",result:"pass",detail:"Fixture source verified",affected:[]}],issues:[]};
  return {parsed_output:output,usage:{input_tokens:100,output_tokens:50},stop_reason:"end_turn"};
 }}};
}
async function runScheduled(fail=false){
 while(scheduled.length){
  const id=scheduled.shift()!,counter={calls:0};
  const options={client:fakeClient(fail,counter),env:{...integrationEnv,AGENT_REPLAY:false},replay:"off" as const,spend:{ledger:createSpendLedger(db),environment:"local" as const,agentRunRef:id}};
  if(fail){
   await executeGroup(db,id,options);
   assert.equal(counter.calls,2,"failed clinical call retries once before dependents are skipped");
  }else{
   await Promise.all([executeGroup(db,id,options),executeGroup(db,id,options)]);
   assert.equal(counter.calls,3,"duplicate execution must make one model call per agent only");
  }
 }
}
async function main(){
 await seed(db);await seed(db);
 const [initial]=await db.select({count:sql<number>`count(*)::int`}).from(s.documents).where(eq(s.documents.caseId,"UR-1042"));assert.equal(initial.count,7,"fresh test database required");
 assert.equal((await okay("GET","cases")).length,1);
 actor=null;assert.equal((await api("GET","cases")).status,401);actor={userId:DEMO_USER_ID,role:"clinician"};
 const first=await okay("POST","cases/UR-1042/runs",{});
 assert.equal((await api("POST","cases/UR-1042/runs",{})).status,409);
 await runScheduled();
 let status=await okay("GET",`runs/${first.runGroupId}`);assert.equal(status.status,"complete",JSON.stringify(status));assert.equal(status.agents.length,3);
 let validation=await okay("GET","cases/UR-1042/validation");assert(validation.blockers.some((b:{code:string})=>b.code==="date_coverage_gap"));
 assert.equal((await api("POST","cases/UR-1042/approve",{packetVersionId:validation.packetVersionId,contentHash:validation.contentHash,acknowledgement:"Reviewed synthetic record"})).status,409);
 const raw=await readFile("fixtures/ur-1042/late-arrival/note-2026-11-02.md","utf8"),note=parseFrontMatter(raw);
 assert.equal((await api("POST","cases/UR-1042/documents",{type:"policy",title:"attempt",content:note.body})).status,422);
 const uploaded=await okay("POST","cases/UR-1042/documents",{type:"progress_note",title:"Caller title ignored",author:"Caller ignored",serviceDate:"2026-11-01",content:note.body});
 assert.equal(uploaded.verificationState,"unverified");assert.equal(uploaded.serviceDate,"2026-11-02");
 const issues=await okay("GET","cases/UR-1042/issues");
 const missing=issues.find((issue:{type:string})=>issue.type==="missing_document"),dates=issues.find((issue:{type:string})=>issue.type==="date_conflict");
 assert.equal((await api("POST",`issues/${missing.id}/resolve`,{resolution:"attach_document",reason:"Source checked",evidenceDocumentId:uploaded.id})).status,422);
 const verified=await okay("POST",`documents/${uploaded.id}/verify`,{decision:"verified"});assert.equal(verified.rerun,"started");
 await runScheduled();
 await okay("POST",`issues/${missing.id}/resolve`,{resolution:"attach_document",reason:"Verified late note covers missing day",evidenceDocumentId:uploaded.id});
 const caseView=await okay("GET","cases/UR-1042");
 await okay("POST",`issues/${dates.id}/resolve`,{resolution:"verify_period",reason:"Request is for Nov4–6; current authorization remains Nov1–3",evidenceDocumentId:caseView.reviewPeriod.sourceDocumentId,verifiedPeriod:{start:"2026-11-04",end:"2026-11-06"}});
 validation=await okay("GET","cases/UR-1042/validation");assert.deepEqual(validation.blockers,[],JSON.stringify(validation));
 const approvalBody={packetVersionId:validation.packetVersionId,contentHash:validation.contentHash,acknowledgement:"Reviewed all sources in synthetic demo"};
 const approvals=await Promise.all([okay("POST","cases/UR-1042/approve",approvalBody),okay("POST","cases/UR-1042/approve",approvalBody)]);assert.equal(approvals[0].id,approvals[1].id);
 const before=(await okay("GET","cases/UR-1042")).latestPacketVersion;
 await okay("POST","cases/UR-1042/runs",{});await runScheduled();
 const after=(await okay("GET","cases/UR-1042")).latestPacketVersion;assert.equal(after.id,before.id,"identical rerun must reuse packet");
 const [approvalRow]=await db.select().from(s.approvals).where(eq(s.approvals.id,approvals[0].id));assert.equal(approvalRow.status,"valid","identical rerun must preserve approval");
 const claimRows=await okay("GET","cases/UR-1042/claims");
 await okay("PATCH",`claims/${claimRows[0].id}`,{text:"Clinician reviewed the documented symptoms."});
 const changed=(await okay("GET","cases/UR-1042")).latestPacketVersion;assert.notEqual(changed.id,before.id);
 const [invalidated]=await db.select().from(s.approvals).where(eq(s.approvals.id,approvals[0].id));assert.equal(invalidated.status,"invalidated");
 const foreign=randomUUID();await db.insert(s.users).values({id:foreign,accountKey:`test-${foreign}`,email:`${foreign}@example.test`,name:"Test Clinician",role:"clinician"});actor={userId:foreign,role:"clinician"};
 for(const [method,path,body] of [["GET","cases/UR-1042"],["GET","cases/UR-1042/documents"],["GET","cases/UR-1042/claims"],["GET","cases/UR-1042/issues"],["GET","cases/UR-1042/validation"],["GET",`documents/${uploaded.id}`],["GET",`runs/${first.runGroupId}`],["POST",`documents/${uploaded.id}/verify`,{decision:"verified"}],["PATCH",`claims/${claimRows[0].id}`,{text:"probe"}],["POST",`issues/${missing.id}/resolve`,{resolution:"attach_document",reason:"probe",evidenceDocumentId:uploaded.id}],["POST","cases/UR-1042/runs",{}],["POST","cases/UR-1042/approve",approvalBody]] as const){const response=await api(method,path,body);assert.equal(response.status,404,`${method} ${path}`);}
 assert.deepEqual(await okay("GET","cases"),[]);actor={userId:DEMO_USER_ID,role:"clinician"};
 await okay("POST","cases/UR-1042/runs",{});await runScheduled(true);
 const [failedGroup]=await db.select().from(s.runGroups).where(eq(s.runGroups.caseId,"UR-1042")).orderBy(sql`${s.runGroups.startedAt} desc`).limit(1);
 status=await okay("GET",`runs/${failedGroup.id}`);assert.equal(status.status,"failed");assert.deepEqual(status.agents.map((row:{status:string})=>row.status).sort(),["failed","skipped","skipped"]);
 validation=await okay("GET","cases/UR-1042/validation");assert(validation.blockers.some((b:{code:string})=>b.code==="run_incomplete"));
 await assert.rejects(db.update(s.auditEvents).set({action:"tamper"}),/Failed query/);
 await db.transaction(async tx=>{await tx.execute(sql`SET LOCAL ROLE app_rw`);await tx.select().from(s.documents).limit(1);});
 await assert.rejects(db.transaction(async tx=>{await tx.execute(sql`SET LOCAL ROLE app_rw`);await tx.update(s.documents).set({content:"tamper"}).where(eq(s.documents.id,uploaded.id));}));
 await assert.rejects(db.transaction(async tx=>{await tx.execute(sql`SET LOCAL ROLE app_rw`);await tx.delete(s.auditEvents);}));
 await testSpendLedger(db);await testApproval(db);await testAuth(db);
 console.log(JSON.stringify({status:"passed",mode:"fake-client + real PostgreSQL",liveModelCalls:0,checks:["idempotent seed","full UR-1042 flow","source-linked approval","concurrent approval","identical rerun","duplicate execution","immutable history","cross-case routes","failed run skips","audit trigger","document grants","spend concurrency","auth throttle"]},null,2));
}
main().finally(()=>pool.end());
