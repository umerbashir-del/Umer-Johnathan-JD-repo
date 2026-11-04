import { describe, expect, it } from "vitest";
import { parseEnv } from "../env";
import { LIMITS } from "../config/limits";
import { createFakeLedger } from "./spend-fake";
import { estimateCallMicroUsd, estimateInputTokens, preflightAttempt, priceFor, settleAttempt, spendStopMicroUsd, toMicroCeil, usageMicroUsd, withinStop } from "./spend";
const env = parseEnv({APP_DEPLOYMENT:'local'});
const price = {input:0.1,output:0.5};
const base = {model:'claude-haiku-5-5',systemText:'x'.repeat(3000),promptText:'x'.repeat(9000),maxTokens:8000,env};
const controls = (ledger: ReturnType<typeof createFakeLedger> | null) => ({ledger,environment:'local' as const,agentRunRef:null});
describe('spend arithmetic',()=>{
  it('estimates input and reserves cache-write pricing',()=>{
    expect(estimateInputTokens(base.systemText,base.promptText)).toBe(4000);
    expect(estimateCallMicroUsd(price,4000,8000)).toBe(4500);
    expect(usageMicroUsd(price,{input_tokens:1000,output_tokens:500})).toBe(350);
    expect(usageMicroUsd(price,{input_tokens:1000,output_tokens:500,cache_creation_input_tokens:1000,cache_read_input_tokens:1000})).toBe(485);
  });
  it.each([[3.0000000000000004,3],[3.000001,4],[0,0]])('rounds %s to %s',(value,expected)=>expect(toMicroCeil(value)).toBe(expected));
  it.each([NaN,-1,1.5,Infinity])('rejects malformed count %s',value=>expect(usageMicroUsd(price,{input_tokens:value,output_tokens:500})).toBeNull());
  it('rejects malformed cache counts',()=>expect(usageMicroUsd(price,{input_tokens:1000,output_tokens:500,cache_read_input_tokens:-5})).toBeNull());
  it.each(['constructor','__proto__','toString','claude-unknown'])('rejects unpriced model %s',model=>expect(priceFor(model)).toBeNull());
  it('uses exact stop levels',()=>{
    expect(priceFor(base.model)).toEqual(price);
    expect(spendStopMicroUsd(env)).toBe(26000000);
    expect(spendStopMicroUsd({...env,SPEND_DEMO_RESERVE_UNLOCKED:true})).toBe(36000000);
    expect(LIMITS.SPEND_ORDINARY_STOP_MICRO_USD+LIMITS.SPEND_DEMO_RESERVE_MICRO_USD).toBe(LIMITS.SPEND_HARD_STOP_MICRO_USD);
    expect(withinStop({recordedMicroUsd:25995500,reservedMicroUsd:0},4500,26000000)).toBe(true);
    expect(withinStop({recordedMicroUsd:25995501,reservedMicroUsd:0},4500,26000000)).toBe(false);
  });
});
describe('spend preflight and settlement',()=>{
  it.each([[25999000,false,false],[25999000,true,true],[35999000,true,false],[25995500,false,true],[25995501,false,false]])('checks recorded %s reserve %s',async(recorded,unlock,held)=>{
    const ledger=createFakeLedger({recordedMicroUsd:recorded});
    const result=await preflightAttempt({...base,env:{...env,SPEND_DEMO_RESERVE_UNLOCKED:unlock},controls:controls(ledger)});
    expect(result.ok).toBe(held);
  });
  it('counts existing reservations',async()=>expect((await preflightAttempt({...base,controls:controls(createFakeLedger({recordedMicroUsd:20000000,reservedMicroUsd:5998000}))})).ok).toBe(false));
  it('checks price before input before ledger',async()=>{
    const ledger=createFakeLedger();
    expect(await preflightAttempt({...base,model:'unpriced',controls:controls(ledger)})).toMatchObject({ok:false,refusal:{reasonCode:'unpriced_model'}});
    expect(await preflightAttempt({...base,systemText:'',promptText:'x'.repeat(120003),controls:controls(ledger)})).toMatchObject({ok:false,refusal:{reasonCode:'call_input_cap'}});
    expect(ledger.calls).toHaveLength(0);
    expect((await preflightAttempt({...base,systemText:'',promptText:'x'.repeat(120000),controls:controls(ledger)})).ok).toBe(true);
    expect(await preflightAttempt({...base,controls:controls(null)})).toMatchObject({ok:false,refusal:{reasonCode:'ledger_missing'}});
    expect(await preflightAttempt({...base,controls:controls(createFakeLedger({unavailable:true}))})).toMatchObject({ok:false,refusal:{reasonCode:'ledger_error'}});
  });
  it.each([null,{input_tokens:NaN,output_tokens:500},{input_tokens:-1,output_tokens:500},{input_tokens:1000,output_tokens:500}])('settles each hold once with safe usage',async usage=>{
    const ledger=createFakeLedger();const control=controls(ledger);const hold=await preflightAttempt({...base,controls:control});
    if(!hold.ok) throw new Error('expected hold');
    const result=await settleAttempt({...hold,controls:control,usage});
    const trusted=usage!==null && usage.input_tokens===1000;
    expect(result).toEqual({actualMicroUsd:trusted?350:4500,usageTrusted:trusted,settled:true});
    expect(ledger.state).toEqual({recordedMicroUsd:trusted?350:4500,reservedMicroUsd:0});
    await expect(ledger.settle(hold.reservationId,1)).rejects.toThrow('unknown or settled');
  });
  it('makes a settlement failure visible',async()=>{
    const ledger=createFakeLedger({settleFails:true});const control=controls(ledger);const hold=await preflightAttempt({...base,controls:control});
    if(!hold.ok) throw new Error('expected hold');
    expect(await settleAttempt({...hold,controls:control,usage:null})).toEqual({actualMicroUsd:4500,usageTrusted:false,settled:false});
  });
  it('atomically refuses one of two reservations near stop',async()=>{
    const ledger=createFakeLedger({recordedMicroUsd:25991001});
    const results=await Promise.all([preflightAttempt({...base,controls:controls(ledger)}),preflightAttempt({...base,controls:controls(ledger)})]);
    expect(results.map(result=>result.ok)).toEqual([true,false]);
  });
});
