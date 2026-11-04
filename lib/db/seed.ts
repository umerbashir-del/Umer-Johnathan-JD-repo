import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Database } from ".";
import * as s from "./schema";
import { parseFrontMatter } from "../fixtures/load-fixture";
import { fixtureId, contentHash } from "../fixtures/ids";
const fixtureSchema=z.object({synthetic:z.literal(true),case:z.object({id:z.literal("UR-1042"),type:z.literal("concurrent_review"),patient_label:z.string(),service:z.string(),level_of_care:z.string(),facility:z.string(),payer:z.string(),plan:z.string(),due_at:z.string()}),documents:z.array(z.string()),late_arrival:z.array(z.string()),authorization:z.object({auth_number:z.string(),status:z.string(),approved_start:z.string(),approved_end:z.string(),units:z.number(),source_document:z.string()}),review_period:z.object({requested_start:z.string(),requested_end:z.string(),review_point:z.string(),source_document:z.string()})});
export const DEMO_USER_ID=fixtureId("users","clinician_a");
export async function seed(db:Database,root=process.cwd()) {
 const directory=path.join(root,"fixtures/ur-1042");
 const fixture=fixtureSchema.parse(JSON.parse(await readFile(path.join(directory,"case.json"),"utf8")));
 await db.transaction(async tx=>{
  await tx.insert(s.users).values({id:DEMO_USER_ID,accountKey:"clinician_a",email:"clinician_a@example.test",name:"Demo Clinician (fictional)",role:"clinician"}).onConflictDoNothing();
  const c=fixture.case;
  await tx.insert(s.cases).values({id:c.id,type:c.type,patientLabel:c.patient_label,service:c.service,levelOfCare:c.level_of_care,facility:c.facility,payer:c.payer,plan:c.plan,assignedTo:DEMO_USER_ID,dueAt:new Date(c.due_at),status:"needs_review",synthetic:true}).onConflictDoNothing();
  for(const file of [...fixture.documents,...fixture.late_arrival]) {
   const {meta,body}=parseFrontMatter(await readFile(path.join(directory,file),"utf8"));
   const type=z.enum(["intake","treatment_plan","progress_note","authorization_record","policy"]).parse(meta.type);
   if(fixture.late_arrival.includes(file)) {
    await tx.insert(s.uploadAllowlist).values({caseId:c.id,contentHash:contentHash(body),type,title:meta.title??file,author:meta.author??"",serviceDate:meta.service_date??null,fixturePath:`ur-1042/${file}`}).onConflictDoNothing();
   } else {
    await tx.insert(s.documents).values({id:fixtureId(c.id,file),caseId:c.id,type,title:meta.title??file,author:meta.author??null,serviceDate:meta.service_date??null,receivedAt:new Date("2026-11-03T14:00:00Z"),version:1,content:body,contentHash:contentHash(body),verificationState:"verified",verificationSource:"seed",origin:"seed"}).onConflictDoNothing();
   }
  }
  const period=fixture.review_period,auth=fixture.authorization;
  await tx.insert(s.reviewPeriods).values({id:fixtureId(c.id,"review-period:1"),caseId:c.id,requestedStart:period.requested_start,requestedEnd:period.requested_end,reviewPoint:period.review_point,version:1,sourceDocumentId:fixtureId(c.id,period.source_document)}).onConflictDoNothing();
  await tx.insert(s.authorizations).values({id:fixtureId(c.id,"authorization:1"),caseId:c.id,authNumber:auth.auth_number,status:auth.status,approvedStart:auth.approved_start,approvedEnd:auth.approved_end,units:auth.units,sourceDocumentId:fixtureId(c.id,auth.source_document)}).onConflictDoNothing();
  await tx.insert(s.issues).values([
   {id:fixtureId(c.id,"missing-note:2026-11-02"),caseId:c.id,type:"missing_document",severity:"critical",blocking:true,ownerId:DEMO_USER_ID,status:"open",source:"code",description:"Progress note for 2026-11-02 is missing",dedupeKey:"missing_document:progress_note:2026-11-02",requiredDocumentType:"progress_note",requiredServiceDate:"2026-11-02"},
   {id:fixtureId(c.id,"date-conflict"),caseId:c.id,type:"date_conflict",severity:"major",blocking:true,ownerId:DEMO_USER_ID,status:"open",source:"code",description:"Requested Nov 4–6 extends past authorized Nov 1–3; verify the intended period",dedupeKey:"date_conflict:review_period"},
  ]).onConflictDoNothing();
  await tx.insert(s.spendLedger).values({id:"global"}).onConflictDoNothing();
  const [provenance]=await tx.insert(s.auditEvents).values({id:fixtureId(c.id,"seed-provenance"),actor:"seed",actorType:"system",caseId:c.id,action:"seed_loaded",objectType:"case",objectId:c.id,outcome:"success"}).onConflictDoNothing().returning();
  void provenance;
 });
}
