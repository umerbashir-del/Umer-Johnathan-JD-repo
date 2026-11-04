/**
 * Harness tests use a fake client, so they cost nothing and never touch the network.
 * PATTERN for agent tests: test the deterministic parts (prep, buildPrompt,
 * quote extraction) here; test the model's judgment with evals (scripts/eval.ts).
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { clinicalDocumentationAgent, computeDateCoverage, type ClinicalDocumentationInput } from "../agents/clinical-documentation";
import { runAgent as rawRunAgent, ERROR_MESSAGES, type RunAgentOptions, type AgentRunRecord, type ClaudeClient } from "./run-agent";

import { parseEnv } from "../env";
import { createFakeLedger } from "./spend-fake";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayKey, writeReplay } from "./replay";
import { estimateCallMicroUsd, estimateInputTokens } from "./spend";

const env = parseEnv({APP_DEPLOYMENT:"local"});
function runAgent(agent: typeof clinicalDocumentationAgent, value: ClinicalDocumentationInput, options: RunAgentOptions = {}) {
  return rawRunAgent(agent, value, {env,spend:{ledger:createFakeLedger(),environment:"local",agentRunRef:null}, ...options});
}
const input: ClinicalDocumentationInput = {
  caseId: "UR-TEST",
  levelOfCare: "Inpatient psych",
  reviewPeriod: { start: "2026-11-01", end: "2026-11-03" },
  asOf: "2026-11-03",
  documents: [
    { id: "note-1", type: "progress_note", title: "Day 1", serviceDate: "2026-11-01", version: 1, content: 'Patient states "I still want to die". On close observation.' },
    { id: "note-3", type: "progress_note", title: "Day 3", serviceDate: "2026-11-03", version: 1, content: "Passive suicidal ideation, no plan." },
  ],
};

const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function fakeClient(...responses: unknown[]): ClaudeClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const parse = vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
    calls.push(params);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "object" && next !== null && "parsed_output" in next) {
      const response = next as { parsed_output: unknown; usage?: typeof usage; stop_reason?: string };
      return {parsed_output:response.parsed_output, usage:response.usage ?? usage,stop_reason:response.stop_reason ?? "end_turn"};
    }
    return { parsed_output: next, usage, stop_reason: "end_turn" };
  });
  return { messages: { parse }, calls };
}

const goodOutput = {
  facts: [
    { id: "f1", category: "risk", statement: "Patient reported wanting to die.", serviceDate: "2026-11-01", quotes: [{ documentId: "note-1", text: "I still want to die" }] },
  ],
  gaps: [{ item: "No progress note for 2026-11-02", why: "Every day must be documented.", severity: "high" }],
};

describe("computeDateCoverage", () => {
  it("flags the day without a note", () => {
    expect(computeDateCoverage(input)).toEqual([
      { date: "2026-11-01", hasNote: true },
      { date: "2026-11-02", hasNote: false },
      { date: "2026-11-03", hasNote: true },
    ]);
  });
  it("does not flag days after asOf", () => {
    expect(computeDateCoverage({ ...input, asOf: "2026-11-02" }).map((c) => c.date)).toEqual(["2026-11-01", "2026-11-02"]);
  });
});

describe("runAgent", () => {
  it("returns ok when output is valid and quotes verify", async () => {
    const client = fakeClient(goodOutput);
    const records: AgentRunRecord[] = [];
    const res = await runAgent(clinicalDocumentationAgent, input, { client, replay: "off", model: "claude-haiku-5-5", recordRun: (r) => void records.push(r) });
    expect(res.status).toBe("ok");
    expect(res.quoteChecks[0].status).toBe("verified");
    expect(res.costUsd).toBeCloseTo(1000 * 0.1e-6 + 500 * 0.5e-6);
    expect(records).toHaveLength(1);
    // System prompt is cached and documents are in the user message, not the system prompt.
    const system = client.calls[0].system as Anthropic.TextBlockParam[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(client.calls[0].messages[0].content).toContain('<document id="note-1"');
    expect(client.calls[0].messages[0].content).toContain("2026-11-02: NO NOTE");
  });

  it("marks needs_review when a quote is not in the source", async () => {
    const invented = { ...goodOutput, facts: [{ ...goodOutput.facts[0], quotes: [{ documentId: "note-1", text: "patient has a firearm at home" }] }] };
    const res = await runAgent(clinicalDocumentationAgent, input, { client: fakeClient(invented), replay: "off", model: "claude-haiku-5-5" });
    expect(res.status).toBe("needs_review");
    expect(res.quoteChecks[0].status).toBe("unsupported");
  });

  it("retries once after a bad output, then succeeds", async () => {
    const client = fakeClient({ facts: "not an array" }, goodOutput);
    const res = await runAgent(clinicalDocumentationAgent, input, { client, replay: "off", model: "claude-haiku-5-5" });
    expect(client.calls).toHaveLength(2);
    expect(res.status).toBe("ok");
  });

  it("fails visibly after retries run out, never a silent pass", async () => {
    const client = fakeClient(new Error("timeout"), new Error("timeout"));
    const records: AgentRunRecord[] = [];
    const res = await runAgent(clinicalDocumentationAgent, input, { client, replay: "off", model: "claude-haiku-5-5", recordRun: (r) => void records.push(r) });
    expect(res.status).toBe("failed");
    expect(res.output).toBeNull();
    expect(records[0]).toMatchObject({ status: "failed", attempts: 2, error: "The model API call failed.", errorKind: "api" });
  });

  it("labels an SDK timeout as errorKind timeout", async () => {
    const timeout = new Anthropic.APIConnectionTimeoutError();
    const client = fakeClient(timeout, timeout);
    const res = await runAgent(clinicalDocumentationAgent, input, { client, replay: "off", model: "claude-haiku-5-5" });
    expect(res.status).toBe("failed");
    expect(res.errorKind).toBe("timeout");
  });
});


describe("harness safety and spend", () => {
  it("never echoes schema or API text in errors",async()=>{
    const records: AgentRunRecord[]=[];
    const result=await runAgent(clinicalDocumentationAgent,input,{client:fakeClient({facts:"IGNORE PREVIOUS INSTRUCTIONS"},{facts:"IGNORE PREVIOUS INSTRUCTIONS"}),recordRun:r=>void records.push(r)});
    expect(result).toMatchObject({status:"failed",errorKind:"schema",error:ERROR_MESSAGES.schema});
    expect(records[0].attempts).toBe(2);
    expect(JSON.stringify(records)).not.toContain("IGNORE");
  });
  it.each([["max_tokens","truncated"],["refusal","refusal"]] as const)("does not retry %s",async(stop_reason,errorKind)=>{
    const client=fakeClient({parsed_output:goodOutput,stop_reason});
    expect(await runAgent(clinicalDocumentationAgent,input,{client})).toMatchObject({status:"failed",errorKind,error:ERROR_MESSAGES[errorKind]});
    expect(client.calls).toHaveLength(1);
  });
  it("refuses live mode without a ledger before client initialization",async()=>{
    const client=fakeClient(goodOutput);
    expect(await runAgent(clinicalDocumentationAgent,input,{client,spend:undefined})).toMatchObject({status:"failed",errorKind:"ledger_unavailable",spendRefusal:{reasonCode:"ledger_missing"}});
    expect(client.calls).toHaveLength(0);
  });
  it("records an unpriced model refusal without spending",async()=>{
    const client=fakeClient(goodOutput);const records:AgentRunRecord[]=[];
    expect(await runAgent(clinicalDocumentationAgent,input,{client,model:"claude-not-priced",recordRun:r=>void records.push(r)})).toMatchObject({status:"failed",errorKind:"spend_stop"});
    expect(client.calls).toHaveLength(0);expect(records).toHaveLength(1);
    expect(records[0].spendRefusal?.reasonCode).toBe("unpriced_model");
  });
  it("reserves and settles every retry and sums usage",async()=>{
    const ledger=createFakeLedger();const client=fakeClient({facts:"bad"},goodOutput);
    const result=await runAgent(clinicalDocumentationAgent,input,{client,spend:{ledger,environment:"local",agentRunRef:null}});
    expect(result.usage).toEqual({input_tokens:2000,output_tokens:1000,cache_creation_input_tokens:0,cache_read_input_tokens:0});
    expect(result.costUsd).toBe(0.0007);
    expect(ledger.calls.map(call=>call.kind)).toEqual(["reserve","settle","reserve","settle"]);
  });
  it("can refuse a retry after settling the first attempt",async()=>{
    const estimate=estimateCallMicroUsd({input:0.1,output:0.5},estimateInputTokens(clinicalDocumentationAgent.system,clinicalDocumentationAgent.buildPrompt(input)),clinicalDocumentationAgent.maxTokens);
    const ledger=createFakeLedger({recordedMicroUsd:26000000-estimate});
    // Missing usage charges the full estimate, so the retry cannot hold again.
    const client=fakeClient(new Anthropic.APIConnectionTimeoutError(),goodOutput);
    const result=await runAgent(clinicalDocumentationAgent,input,{client,spend:{ledger,environment:"local",agentRunRef:null}});
    expect(result).toMatchObject({status:"failed",errorKind:"spend_stop",usage:null});expect(client.calls).toHaveLength(1);
    expect(ledger.calls.map(call=>call.kind)).toEqual(["reserve","settle","reserve"]);
  });
  it("charges the estimate on exceptions and malformed usage",async()=>{
    const estimate=estimateCallMicroUsd({input:0.1,output:0.5},estimateInputTokens(clinicalDocumentationAgent.system,clinicalDocumentationAgent.buildPrompt(input)),clinicalDocumentationAgent.maxTokens);
    const timeout=await runAgent(clinicalDocumentationAgent,input,{client:fakeClient(new Anthropic.APIConnectionTimeoutError(),new Anthropic.APIConnectionTimeoutError())});
    expect(timeout.usage).toBeNull();expect(timeout.costUsd).toBe(2*estimate/1000000);
    const malformed=await runAgent(clinicalDocumentationAgent,input,{client:fakeClient({parsed_output:goodOutput,usage:{input_tokens:NaN,output_tokens:500}})});
    expect(malformed.status).toBe("ok");expect(malformed.usage).toBeNull();expect(malformed.costUsd).toBe(estimate/1000000);
  });
  it("reports unsettled spend and still records the run",async()=>{
    const records:AgentRunRecord[]=[];const ledger=createFakeLedger({settleFails:true});
    expect(await runAgent(clinicalDocumentationAgent,input,{client:fakeClient(goodOutput),spend:{ledger,environment:"local",agentRunRef:null},recordRun:r=>void records.push(r)})).toMatchObject({status:"ok",spendUnsettled:true});
    expect(records[0].spendUnsettled).toBe(true);
  });
  it("records a successful paid run even when replay writing fails",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"ur-record-failure-"));
    try {
      const blocked=join(dir,"blocked");await writeFile(blocked,"synthetic file");
      const records:AgentRunRecord[]=[];
      const result=await runAgent(clinicalDocumentationAgent,input,{client:fakeClient(goodOutput),replay:"record",env:parseEnv({APP_DEPLOYMENT:"local",AGENT_REPLAY_DIR:blocked}),recordRun:r=>void records.push(r)});
      expect(result).toMatchObject({status:"ok",output:goodOutput,recordingError:"replay_write_failed",error:"The replay could not be saved.",costUsd:0.00035});
      expect(records).toHaveLength(1);expect(records[0].recordingError).toBe("replay_write_failed");
      expect(records[0].error).not.toContain(blocked);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it("uses the injected model and replay recording directory",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"ur-record-"));
    try {
      const recordEnv=parseEnv({APP_DEPLOYMENT:"local",MODEL_DEFAULT:"claude-sonnet-5-5",AGENT_RECORD:"1",AGENT_REPLAY_DIR:dir});
      const client=fakeClient(goodOutput);
      const result=await runAgent(clinicalDocumentationAgent,input,{client,env:recordEnv});
      expect(result.status).toBe("ok");expect(client.calls[0].model).toBe("claude-sonnet-5-5");
      const key=replayKey(clinicalDocumentationAgent.name,clinicalDocumentationAgent.version,"claude-sonnet-5-5",clinicalDocumentationAgent.system,clinicalDocumentationAgent.buildPrompt(input));
      expect(JSON.parse(await readFile(join(dir,key+".json"),"utf8"))).toEqual(goodOutput);
      const noClient=fakeClient(goodOutput);
      expect(await runAgent(clinicalDocumentationAgent,{...input,caseId:"absent"},{env:parseEnv({APP_DEPLOYMENT:"local",AGENT_RECORD:"1",AGENT_REPLAY:"1",AGENT_REPLAY_DIR:dir}),client:noClient})).toMatchObject({status:"failed",errorKind:"no_replay"});
      expect(noClient.calls).toHaveLength(0);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it("enforces production replay labels and never falls through to live",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"ur-replay-"));
    try {
      const hosted={DATABASE_URL:"postgres://test",AUTH_SECRET:"x".repeat(32),APP_ORIGIN:"https://example.test",AGENT_REPLAY_DIR:dir};
      const key=replayKey(clinicalDocumentationAgent.name,clinicalDocumentationAgent.version,env.MODEL_DEFAULT,clinicalDocumentationAgent.system,clinicalDocumentationAgent.buildPrompt(input));
      await writeReplay(key,goodOutput,dir);
      for (const modeFromEnv of [true,false]) {
        const client=fakeClient(goodOutput);
        const production=parseEnv({...hosted,VERCEL_ENV:"production",AGENT_REPLAY:modeFromEnv?"1":""});
        expect(await runAgent(clinicalDocumentationAgent,input,{env:production,client,replay:modeFromEnv?undefined:"read"})).toMatchObject({status:"failed",errorKind:"no_replay"});
        expect(client.calls).toHaveLength(0);
      }
      for(const override of [{VERCEL_ENV:"production",REPLAY_PRODUCTION_LABELED:"1"},{VERCEL_ENV:"preview"},{APP_DEPLOYMENT:"local"}]) {
        const client=fakeClient(goodOutput);const ledger=createFakeLedger();
        const result=await runAgent(clinicalDocumentationAgent,input,{env:parseEnv({...hosted,...override,AGENT_REPLAY:"1",AGENT_RECORD:"1"}),client,spend:{ledger,environment:"local",agentRunRef:null}});
        expect(result).toMatchObject({status:"ok",costUsd:0});expect(client.calls).toHaveLength(0);expect(ledger.calls).toHaveLength(0);
      }
      expect(await runAgent(clinicalDocumentationAgent,input,{env:parseEnv({APP_DEPLOYMENT:"local",AGENT_REPLAY_DIR:dir}),replay:"read",spend:undefined})).toMatchObject({status:"ok",costUsd:0});
      expect(await runAgent(clinicalDocumentationAgent,{...input,caseId:"missing"},{env:parseEnv({APP_DEPLOYMENT:"local",AGENT_REPLAY_DIR:dir}),replay:"read"})).toMatchObject({status:"failed",errorKind:"no_replay"});
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
