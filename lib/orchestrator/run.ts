import "server-only";
import { randomUUID } from "node:crypto";
import {and,desc,eq,inArray,lt,sql} from "drizzle-orm";
import type {Database,Db,Transaction} from "../db";
import * as s from "../db/schema";
import {getEnv,type Env,deploymentOf} from "../env";
import {businessNow,businessDate} from "../clock";
import {LIMITS} from "../config/limits";
import {HttpError} from "../http/errors";
import {takeRate} from "../http/rate-limit";
import {writeAudit} from "../audit/write";
import {withCaseLock} from "../cases/lock";
import {runAgent,type AgentRunRecord,type RunAgentOptions} from "../harness/run-agent";
import type {SourceDocument} from "../harness/documents";
import {clinicalDocumentationAgent,computeDateCoverage,type Fact} from "../agents/clinical-documentation";
import {caseAssemblyAgent,type CaseAssemblyInput} from "../agents/case-assembly";
import {independentQualityAgent} from "../agents/independent-quality";
import {acceptDraftClaims,findDuplicateIds,mergeChecks,acceptQualityIssues} from "./accept/accept";
import {scanAgentOutput} from "./accept/boundary";
import {verifyQuotes} from "../harness/verify-quotes";
import {getSpendLedger,checkSpendAdmission} from "../db/spend-ledger";
import {loadValidation,refreshPacketHash} from "../validation/snapshot";
import {recheckApproval} from "../cases/approval";
import {transition} from "../cases/transition";
class IdenticalPacket extends Error {}
class ExecutionAlreadyClaimed extends Error {}
const agents=["clinical_documentation","case_assembly_drafting","independent_quality"] as const;
export async function sweepStaleRuns(db:Db,caseId:string){
 const cutoff=new Date(Date.now()-LIMITS.STALE_RUN_MINUTES*60000);
 const stale=await db.update(s.runGroups).set({status:"failed",finishedAt:new Date()}).where(and(eq(s.runGroups.caseId,caseId),eq(s.runGroups.status,"running"),lt(s.runGroups.heartbeatAt,cutoff))).returning();
 for(const group of stale){
  await db.update(s.agentRuns).set({status:"failed",errorKind:"stale",error:"Run stopped before completing.",finishedAt:new Date()}).where(and(eq(s.agentRuns.runGroupId,group.id),inArray(s.agentRuns.status,["running","queued"])));
  await recheckApproval(db,caseId);
  await transition(db,caseId,"needs_review","system","stale_run");
  await writeAudit(db,{actor:"orchestrator",actorType:"system",caseId,action:"run_stale",objectType:"run_group",objectId:group.id,outcome:"failed",reasonCode:"stale_run"});
 }
}
export async function startGroup(db:Db,caseId:string,userId:string,env:Env=getEnv()){
 await sweepStaleRuns(db,caseId);
 const [active]=await db.select().from(s.runGroups).where(and(eq(s.runGroups.caseId,caseId),eq(s.runGroups.status,"running")));
 if(active)throw new HttpError(409,"active_run",{activeRunGroupId:active.id});
 if(!env.AGENT_REPLAY){
  if(!env.ANTHROPIC_API_KEY||!env.SPEND_LEDGER_URL)throw new HttpError(503,"ledger_unavailable");
  if(deploymentOf(env)==="preview")throw new HttpError(403,"live_preview_refused");
  const admission=await checkSpendAdmission(env);
  if(admission!=="ok")throw new HttpError(admission==="spend_stop"?429:503,admission);
 }
 for(const [key,limit,window] of [[`run:user:hour:${userId}`,LIMITS.USER_RUNS_PER_HOUR,3600000],[`run:user:day:${userId}`,LIMITS.USER_RUNS_PER_DAY,86400000],[`run:case:hour:${caseId}`,LIMITS.CASE_RUNS_PER_HOUR,3600000],[`run:case:day:${caseId}`,LIMITS.CASE_RUNS_PER_DAY,86400000]] as const){if(!await takeRate(db,key,limit,window))throw new HttpError(429,"rate_limited");}
 const id=randomUUID(),asOf=businessNow(env),now=new Date();
 await db.insert(s.runGroups).values({id,caseId,status:"running",startedBy:userId,asOf,startedAt:now,heartbeatAt:now,replayed:env.AGENT_REPLAY});
 await db.insert(s.agentRuns).values(agents.map(agent=>({id:randomUUID(),caseId,runGroupId:id,agent,agentVersion:"pending",model:env.MODEL_DEFAULT,inputHash:"pending",inputDocumentIds:[],status:"queued"})));
 await transition(db,caseId,"processing",userId);

 await writeAudit(db,{actor:userId,caseId,action:"run_started",objectType:"run_group",objectId:id});
 return {runGroupId:id};
}
export type ExecutionOptions=Pick<RunAgentOptions,"client"|"spend"|"env"|"replay">;
export async function executeGroup(db:Database,groupId:string,options:ExecutionOptions={}){
 const [group]=await db.select().from(s.runGroups).where(eq(s.runGroups.id,groupId));
 if(!group||group.status!=="running")return;
 const caseId=group.caseId,env=options.env??getEnv();
 let failure=false;
 try{
  const [caseRow]=await db.select().from(s.cases).where(eq(s.cases.id,caseId));
  const [period]=await db.select().from(s.reviewPeriods).where(eq(s.reviewPeriods.caseId,caseId)).orderBy(desc(s.reviewPeriods.version)).limit(1);
  const [auth]=await db.select().from(s.authorizations).where(eq(s.authorizations.caseId,caseId));
  if(!caseRow||!period||!auth)throw new Error("run_input_missing");
  const storedDocs=await db.select().from(s.documents).where(and(eq(s.documents.caseId,caseId),eq(s.documents.verificationState,"verified")));
  const documents:SourceDocument[]=storedDocs.filter(row=>["intake","treatment_plan","progress_note","authorization_record"].includes(row.type)).map(row=>({...row,author:row.author??undefined,serviceDate:row.serviceDate??undefined}));
  if(documents.length>LIMITS.CASE_MAX_DOCUMENTS||documents.reduce((sum,doc)=>sum+doc.content.length,0)>LIMITS.CASE_MAX_CHARS)throw new Error("run_input_limit");
  const records=await db.select().from(s.agentRuns).where(eq(s.agentRuns.runGroupId,groupId));
  const recordIds=new Map(records.map(row=>[row.agent,row.id]));
  const updateRecord=async(agent:string,record:AgentRunRecord)=>{
   await withCaseLock(db,caseId,async tx=>{
    const [current]=await tx.select().from(s.runGroups).where(eq(s.runGroups.id,groupId));
    if(current.status!=="running")throw new Error("stale_run");
    await tx.update(s.agentRuns).set({agentVersion:record.version,model:record.model,inputHash:record.inputHash,inputDocumentIds:documents.map(doc=>doc.id),output:record.output,quoteChecks:record.quoteChecks,status:record.status==="ok"?"succeeded":record.status==="needs_review"?"needs_review":record.errorKind==="timeout"?"timed_out":"failed",error:record.error??null,errorKind:record.errorKind??null,attempts:record.attempts,inputTokens:record.usage?.input_tokens,outputTokens:record.usage?.output_tokens,costUsd:record.costUsd.toFixed(6),startedAt:new Date(record.startedAt),finishedAt:new Date()}).where(eq(s.agentRuns.id,recordIds.get(agent)!));
    await tx.update(s.runGroups).set({callsUsed:sql`${s.runGroups.callsUsed}+${record.attempts}`,tokensUsed:sql`${s.runGroups.tokensUsed}+${(record.usage?.input_tokens??0)+(record.usage?.output_tokens??0)}`,costUsd:sql`${s.runGroups.costUsd}+${record.costUsd.toFixed(6)}`,heartbeatAt:new Date()}).where(eq(s.runGroups.id,groupId));
   });
  };
  const opts=(agent:string):RunAgentOptions=>({...options,env,spend:options.spend??{ledger:getSpendLedger(),environment:deploymentOf(env),agentRunRef:recordIds.get(agent)!},recordRun:record=>updateRecord(agent,record)});
  const clinicalInput={caseId,levelOfCare:caseRow.levelOfCare,reviewPeriod:{start:auth.approvedStart,end:auth.approvedEnd},asOf:businessDate(group.asOf),documents};
  const beginAgent=async(agent:string)=>withCaseLock(db,caseId,async tx=>{
   const [current]=await tx.select().from(s.runGroups).where(eq(s.runGroups.id,groupId));
   if(!current||current.status!=="running")throw new Error("stale_run");
   const claimed=await tx.update(s.agentRuns).set({status:"running",startedAt:new Date()}).where(and(eq(s.agentRuns.id,recordIds.get(agent)!),eq(s.agentRuns.status,"queued"))).returning({id:s.agentRuns.id});
   if(!claimed.length)throw new ExecutionAlreadyClaimed();
   await tx.update(s.runGroups).set({heartbeatAt:new Date()}).where(eq(s.runGroups.id,groupId));
  });
  await beginAgent(agents[0]);
  const clinical=await runAgent(clinicalDocumentationAgent,clinicalInput,opts(agents[0]));
  if(!clinical.output)throw new Error(clinical.errorKind??"agent_failed");
  const duplicateIds=findDuplicateIds(clinical.output.facts);
  if(duplicateIds.length){
   await db.update(s.agentRuns).set({status:"failed",errorKind:"schema",error:"The model output did not match the required format."}).where(eq(s.agentRuns.id,recordIds.get(agents[0])!));
   throw new Error("duplicate_fact_ids");
  }
  const verifiedFacts=new Set(clinical.output.facts.filter(fact=>!duplicateIds.includes(fact.id)&&fact.quotes.length>0&&verifyQuotes(fact.quotes,documents).every(q=>q.status==="verified")).map(fact=>fact.id));
  const verifiedQuotes=clinical.output.facts.filter(fact=>verifiedFacts.has(fact.id)).flatMap(fact=>fact.quotes.map(q=>q.text));
  const checks:CaseAssemblyInput["checks"]=[{name:"fact_ids",result:duplicateIds.length?"fail":"pass",detail:"Fact IDs must be unique.",affected:[]},{name:"quote_support",result:clinical.status==="needs_review"?"fail":"pass",detail:"Every extracted fact quote must verify.",affected:[]}];
  if(scanAgentOutput(clinical.output,verifiedQuotes).flagged)checks.push({name:"clinical_boundary",result:"fail",detail:"Clinical boundary language found.",affected:[]});
  const assemblyInput:CaseAssemblyInput={documents,facts:clinical.output.facts,gaps:clinical.output.gaps,requestedPeriod:{start:period.requestedStart,end:period.requestedEnd,sourceDocumentId:period.sourceDocumentId},authorizedPeriod:{start:auth.approvedStart,end:auth.approvedEnd,sourceDocumentId:auth.sourceDocumentId},checks};
  await beginAgent(agents[1]);
  const draft=await runAgent(caseAssemblyAgent,assemblyInput,opts(agents[1]));
  if(!draft.output)throw new Error(draft.errorKind??"agent_failed");
  const context={caseId,agentName:agents[1],agentRunId:recordIds.get(agents[1])!,verifiedFactIds:verifiedFacts,verifiedQuotes,runAgentNames:new Set<string>(agents)};
  const accepted=acceptDraftClaims(draft.output.sections,context).map(claim=>({...claim,id:randomUUID()}));
  let index=0;
  const qualityDraft={...draft.output,sections:draft.output.sections.map(section=>({...section,claims:section.claims.map(claim=>({...claim,id:accepted[index++].id}))}))};
  await beginAgent(agents[2]);
  const quality=await runAgent(independentQualityAgent,{...assemblyInput,draft:qualityDraft},opts(agents[2]));
  if(!quality.output)throw new Error(quality.errorKind??"agent_failed");
  if(scanAgentOutput(draft.output,verifiedQuotes).flagged||scanAgentOutput(quality.output,verifiedQuotes).flagged)checks.push({name:"output_boundary",result:"fail",detail:"Agent output crosses clinical boundary.",affected:[]});
  const merged=mergeChecks(checks.map(check=>({...check,origin:"code" as const})),quality.output.checks.map(check=>({...check,origin:"model" as const})));
  const report={checks:merged.map(check=>({...check,detail:"",affected:[]})),blockerCodes:[]};
  await withCaseLock(db,caseId,async tx=>{
   const [current]=await tx.select().from(s.runGroups).where(eq(s.runGroups.id,groupId));
   if(current.status!=="running")return;
   const currentDocs=await tx.select().from(s.documents).where(and(eq(s.documents.caseId,caseId),eq(s.documents.verificationState,"verified")));
   const [currentPeriod]=await tx.select().from(s.reviewPeriods).where(eq(s.reviewPeriods.caseId,caseId)).orderBy(desc(s.reviewPeriods.version)).limit(1);
   if(currentDocs.filter(doc=>documents.some(input=>input.id===doc.id)).length!==documents.length||currentDocs.filter(row=>["intake","treatment_plan","progress_note","authorization_record"].includes(row.type)).length!==documents.length||currentPeriod.requestedStart!==period.requestedStart||currentPeriod.requestedEnd!==period.requestedEnd)throw new Error("stale_inputs");
   // Code creates required-note issues; model outputs never close or weaken them.
   for(const date of computeDateCoverage(clinicalInput).filter(row=>!row.hasNote).map(row=>row.date))await tx.insert(s.issues).values({id:randomUUID(),caseId,type:"missing_document",severity:"critical",blocking:true,ownerId:caseRow.assignedTo,status:"open",source:"code",description:`Progress note for ${date} is missing`,dedupeKey:`missing_document:progress_note:${date}`,requiredDocumentType:"progress_note",requiredServiceDate:date}).onConflictDoNothing();
   for(const issue of acceptQualityIssues(quality.output!.issues,{...context,agentName:agents[2],agentRunId:recordIds.get(agents[2])!})){
    if(issue.type!=="missing_document"&&issue.type!=="date_conflict")continue;
    const {sendBackTo,...row}=issue;void sendBackTo;
    await tx.insert(s.issues).values({...row,id:randomUUID(),type:issue.type,blocking:true,ownerId:caseRow.assignedTo}).onConflictDoNothing();
   }
   const [previous]=await tx.select().from(s.packetVersions).where(eq(s.packetVersions.caseId,caseId)).orderBy(desc(s.packetVersions.version)).limit(1);
   await tx.update(s.runGroups).set({status:"complete",finishedAt:new Date(),heartbeatAt:new Date()}).where(eq(s.runGroups.id,groupId));
   const candidate=async(candidateTx:Transaction)=>{
   const packetId=randomUUID();
   const content={sections:qualityDraft.sections.map(section=>({heading:section.heading,claimIds:section.claims.map(claim=>claim.id)}))};
   await candidateTx.insert(s.packetVersions).values({id:packetId,caseId,version:(previous?.version??0)+1,kind:"review_packet",content,includedClaimIds:accepted.map(claim=>claim.id),contentHash:"pending",hashInput:{},validationReport:report,runGroupId:groupId});
   if(accepted.length)await candidateTx.insert(s.claims).values(accepted.map(claim=>({...claim,packetVersionId:packetId})));
   const facts=new Map<string,Fact>(clinical.output!.facts.map(fact=>[fact.id,fact]));
   for(const claim of accepted){
    for(const factId of claim.factIds){
     const fact=facts.get(factId);if(!fact||!verifiedFacts.has(factId))continue;
     for(const quote of verifyQuotes(fact.quotes,documents))if(quote.status==="verified"){
      const spanId=randomUUID();await candidateTx.insert(s.evidenceSpans).values({id:spanId,documentId:quote.documentId,startOffset:quote.start,endOffset:quote.end,excerpt:quote.excerpt,method:"verified_quote"});await candidateTx.insert(s.claimEvidence).values({claimId:claim.id,evidenceSpanId:spanId});
     }
    }
   }
   const fresh=await refreshPacketHash(candidateTx,caseId,packetId);
   if(previous&&fresh.hash===previous.contentHash)throw new IdenticalPacket();
   };
   try{await tx.transaction(candidate);}catch(error){
    if(!(error instanceof IdenticalPacket))throw error;
    // The savepoint discards candidate artifacts; IDs and history remain unchanged.
    await tx.update(s.packetVersions).set({runGroupId:groupId}).where(eq(s.packetVersions.id,previous!.id));
   }
   await recheckApproval(tx,caseId);
   const validation=await loadValidation(tx,caseId);
   const [validApproval]=validation.packet?await tx.select({id:s.approvals.id}).from(s.approvals).where(and(eq(s.approvals.packetVersionId,validation.packet.id),eq(s.approvals.status,"valid"))).limit(1):[];
   await transition(tx,caseId,validation.blockers.length?"needs_review":validApproval?"approved_for_submission":"ready_for_approval","system");
   await writeAudit(tx,{actor:"orchestrator",actorType:"system",caseId,action:"run_finished",objectType:"run_group",objectId:groupId});
  });
 }catch(error){
  if(error instanceof ExecutionAlreadyClaimed)return;
  failure=true;
 }finally{
  if(failure)await withCaseLock(db,caseId,async tx=>{
   const [current]=await tx.select().from(s.runGroups).where(eq(s.runGroups.id,groupId));
   if(!current||current.status!=="running")return;
   const rows=await tx.select().from(s.agentRuns).where(eq(s.agentRuns.runGroupId,groupId));
   const running=rows.find(row=>row.status==="running");
   const firstQueued=rows.find(row=>row.agent===agents[0]&&row.status==="queued");
   const finalAgent=rows.every(row=>row.status==="succeeded"||row.status==="needs_review")?rows.find(row=>row.agent===agents[2]):undefined;
   const unfinished=running??(rows.every(row=>row.status==="queued")?firstQueued:finalAgent);
   if(unfinished)await tx.update(s.agentRuns).set({status:"failed",errorKind:"api",error:"The agent run could not complete.",finishedAt:new Date()}).where(eq(s.agentRuns.id,unfinished.id));
   const spend=rows.some(row=>row.errorKind==="spend_stop"||row.errorKind==="budget");
   await tx.update(s.agentRuns).set({status:"skipped",error:"A required earlier agent did not complete.",finishedAt:new Date()}).where(and(eq(s.agentRuns.runGroupId,groupId),eq(s.agentRuns.status,"queued")));
   await tx.update(s.runGroups).set({status:spend?"budget_exceeded":rows.some(row=>row.status==="succeeded"||row.status==="needs_review")?"partial":"failed",finishedAt:new Date(),heartbeatAt:new Date()}).where(and(eq(s.runGroups.id,groupId),eq(s.runGroups.status,"running")));
   await recheckApproval(tx,caseId);
   await transition(tx,caseId,"needs_review","system","run_failed");
   await writeAudit(tx,{actor:"orchestrator",actorType:"system",caseId,action:"agent_failed",objectType:"run_group",objectId:groupId,outcome:"failed",reasonCode:"run_incomplete"});
  });
 }
}
