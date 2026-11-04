import "server-only";
import type { Env } from "../env";
import { LIMITS } from "../config/limits";
import { PRICES, type Usage } from "./pricing";

export type SpendEnvironment = "local" | "preview" | "production" | "eval";
export interface SpendLedger {
  reserve(request: { estimateMicroUsd: number; stopMicroUsd: number; environment: SpendEnvironment; agentRunRef: string | null }): Promise<{ status: "held"; reservationId: string } | { status: "refused" }>;
  settle(reservationId: string, actualMicroUsd: number): Promise<void>;
}
export interface SpendControls { ledger: SpendLedger | null; environment: SpendEnvironment; agentRunRef: string | null }
export type SpendReasonCode = "unpriced_model" | "call_input_cap" | "ledger_missing" | "ledger_error" | "spend_stop";
export type SpendRefusal = { errorKind: "spend_stop" | "budget" | "ledger_unavailable"; reasonCode: SpendReasonCode };
type Price = { input: number; output: number };
export function priceFor(model: string): Price | null {
  return Object.hasOwn(PRICES, model) ? PRICES[model] : null;
}
export function estimateInputTokens(systemText: string, promptText: string): number {
  return Math.ceil((systemText.length + promptText.length) / LIMITS.CHARS_PER_TOKEN_ESTIMATE);
}
export function toMicroCeil(rawMicroUsd: number): number { return Math.ceil(Number(rawMicroUsd.toFixed(6))); }
export function estimateCallMicroUsd(price: Price, inputTokens: number, maxTokens: number): number {
  return toMicroCeil(inputTokens * price.input * LIMITS.CACHE_WRITE_MULTIPLIER + maxTokens * price.output);
}
export function usageMicroUsd(price: Price, usage: Usage): number | null {
  const counts = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  return toMicroCeil(counts[0] * price.input + counts[1] * price.output + counts[2] * price.input * 1.25 + counts[3] * price.input * 0.1);
}
export function spendStopMicroUsd(env: Pick<Env, "SPEND_DEMO_RESERVE_UNLOCKED">): number {
  return env.SPEND_DEMO_RESERVE_UNLOCKED ? LIMITS.SPEND_HARD_STOP_MICRO_USD : LIMITS.SPEND_ORDINARY_STOP_MICRO_USD;
}
export function withinStop(state: { recordedMicroUsd: number; reservedMicroUsd: number }, estimateMicroUsd: number, stopMicroUsd: number): boolean {
  return state.recordedMicroUsd + state.reservedMicroUsd + estimateMicroUsd <= stopMicroUsd;
}
export async function preflightAttempt(args: { model: string; systemText: string; promptText: string; maxTokens: number; controls: SpendControls | undefined; env: Env }): Promise<{ ok: true; price: Price; reservationId: string; estimateMicroUsd: number } | { ok: false; refusal: SpendRefusal }> {
  const price = priceFor(args.model);
  if (!price) return { ok: false, refusal: { errorKind: "spend_stop", reasonCode: "unpriced_model" } };
  const inputTokens = estimateInputTokens(args.systemText, args.promptText);
  if (inputTokens > LIMITS.CALL_MAX_INPUT_TOKENS_ESTIMATE) return { ok: false, refusal: { errorKind: "budget", reasonCode: "call_input_cap" } };
  const ledger = args.controls?.ledger;
  if (!ledger) return { ok: false, refusal: { errorKind: "ledger_unavailable", reasonCode: "ledger_missing" } };
  const estimateMicroUsd = estimateCallMicroUsd(price, inputTokens, args.maxTokens);
  try {
    const held = await ledger.reserve({ estimateMicroUsd, stopMicroUsd: spendStopMicroUsd(args.env), environment: args.controls!.environment, agentRunRef: args.controls!.agentRunRef });
    if (held.status === "refused") return { ok: false, refusal: { errorKind: "spend_stop", reasonCode: "spend_stop" } };
    return { ok: true, price, estimateMicroUsd, reservationId: held.reservationId };
  } catch {
    return { ok: false, refusal: { errorKind: "ledger_unavailable", reasonCode: "ledger_error" } };
  }
}
export async function settleAttempt(args: { controls: SpendControls; reservationId: string; estimateMicroUsd: number; price: Price; usage: Usage | null }): Promise<{ actualMicroUsd: number; usageTrusted: boolean; settled: boolean }> {
  const actual = args.usage === null ? null : usageMicroUsd(args.price, args.usage);
  const actualMicroUsd = actual ?? args.estimateMicroUsd;
  try {
    if (!args.controls.ledger) return { actualMicroUsd, usageTrusted: actual !== null, settled: false };
    await args.controls.ledger.settle(args.reservationId, actualMicroUsd);
    return { actualMicroUsd, usageTrusted: actual !== null, settled: true };
  } catch {
    return { actualMicroUsd, usageTrusted: actual !== null, settled: false };
  }
}
