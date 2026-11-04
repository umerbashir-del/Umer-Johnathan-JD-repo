import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import type { AgentDef } from "../agents/types";
import { formatDocuments, type SourceDocument } from "./documents";
import type { Usage } from "./pricing";
import { deploymentOf, getEnv, type Env } from "../env";
import { preflightAttempt, settleAttempt, type SpendControls, type SpendRefusal } from "./spend";
import { readReplay, replayKey, writeReplay } from "./replay";
import { verifyQuotes, type QuoteCheck } from "./verify-quotes";

/**
 * runAgent(): the ONLY place in the codebase that calls the Claude API.
 * Every agent goes through it. If you need a new capability (streaming,
 * a new model, a new log field), add it here once, not inside an agent.
 *
 * Steps: replay check -> build request -> messages.parse with a Zod schema
 * -> retry once on failure -> verify quotes in code -> cost -> record run.
 */

/** The slice of the Anthropic client we use. Lets tests pass a fake client. */
export interface ClaudeClient {
  messages: {
    parse: (
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number; maxRetries?: number },
    ) => PromiseLike<{
      parsed_output: unknown;
      usage: Usage;
      stop_reason: string | null;
    }>;
  };
}

export type RunStatus = "ok" | "needs_review" | "failed";

/** Why a run failed. "timeout" is shown separately in the UI so the clinician sees a timed-out agent, not a generic error. */
export type ErrorKind = "timeout" | "api" | "schema" | "truncated" | "refusal" | "no_replay" | "budget" | "spend_stop" | "ledger_unavailable";

export const ERROR_MESSAGES: Readonly<Record<ErrorKind, string>> = {
  timeout: "The model call timed out.", api: "The model API call failed.",
  schema: "The model output did not match the required format.",
  truncated: "The model output was cut off at the token limit.",
  refusal: "The model declined to answer.",
  no_replay: "No usable replay for this input; no live call was made.",
  budget: "The call is over its input limit; no call was made.",
  spend_stop: "The spend stop was reached; no call was made.",
  ledger_unavailable: "The spend ledger is unavailable; no live call was made.",
};

/** One row for the agent_runs table. The caller decides where to store it. */
export interface AgentRunRecord {
  agent: string;
  version: string;
  model: string;
  inputHash: string;
  status: RunStatus;
  attempts: number;
  output: unknown;
  quoteChecks: QuoteCheck[];
  usage: Usage | null;
  costUsd: number;
  replayed: boolean;
  error?: string;
  errorKind?: ErrorKind;
  recordingError?: "replay_write_failed";
  spendRefusal: SpendRefusal | null;
  spendUnsettled: boolean;
  startedAt: string;
  durationMs: number;
}

export interface AgentResult<O> {
  /** null only when status is "failed". */
  output: O | null;
  /** One entry per quote. "unsupported" quotes must be shown as unsupported in the UI, never hidden. */
  quoteChecks: QuoteCheck[];
  status: RunStatus;
  usage: Usage | null;
  costUsd: number;
  error?: string;
  errorKind?: ErrorKind;
  recordingError?: "replay_write_failed";
  spendRefusal: SpendRefusal | null;
  spendUnsettled: boolean;
}

export interface RunAgentOptions {
  env?: Env;
  spend?: SpendControls;
  client?: ClaudeClient;
  model?: string;
  /** Persist the run (db insert in the app, console in scripts). Required by convention; never skip logging. */
  recordRun?: (record: AgentRunRecord) => Promise<void> | void;
  /** Defaults from env: AGENT_REPLAY=1 -> "read", AGENT_RECORD=1 -> "record". */
  replay?: "off" | "read" | "record";
}

/** Every agent input carries the documents its quotes are checked against. */
export interface AgentInput {
  documents: SourceDocument[];
}

let defaultClient: Anthropic | undefined;
function getClient(env: Env): ClaudeClient {
  // Config owns the only environment read; never accept a browser-provided key.
  defaultClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" });
  return defaultClient;
}

/** Harness-raised errors carry their kind so the UI can say what happened. */
class AgentOutputError extends Error {
  constructor(
    readonly kind: ErrorKind,
  ) {
    super(ERROR_MESSAGES[kind]);
  }
}

function classifyError(err: unknown): ErrorKind {
  if (err instanceof AgentOutputError) return err.kind;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  return "api";
}

/** 400/401/403/404 will fail the same way again, so do not retry them. */
function isRetryable(err: unknown): boolean {
  if (err instanceof AgentOutputError && (err.kind === "truncated" || err.kind === "refusal")) return false;
  if (err instanceof Anthropic.APIError) {
    return err.status === undefined || err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500;
  }
  return true; // schema/parse errors and timeouts: one more try is worth it
}

function sumUsage(previous: Usage | null, next: Usage): Usage {
  return {
    input_tokens: (previous?.input_tokens ?? 0) + next.input_tokens,
    output_tokens: (previous?.output_tokens ?? 0) + next.output_tokens,
    cache_creation_input_tokens: (previous?.cache_creation_input_tokens ?? 0) + (next.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (previous?.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0),
  };
}

export async function runAgent<I extends AgentInput, O>(
  agent: AgentDef<I, O>,
  input: I,
  opts: RunAgentOptions = {},
): Promise<AgentResult<O>> {
  const env = opts.env ?? getEnv();
  const model = opts.model ?? agent.model ?? env.MODEL_DEFAULT;
  const prompt = agent.buildPrompt(input);
  const mode = opts.replay ?? (env.AGENT_REPLAY ? "read" : env.AGENT_RECORD ? "record" : "off");
  const key = replayKey(agent.name, agent.version, model, agent.system, prompt);
  const startedAt = new Date();

  let output: O | null = null;
  let usage: Usage | null = null;
  let attempts = 0;
  let replayed = false;
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;

  let recordingError: "replay_write_failed" | undefined;
  let spendRefusal: SpendRefusal | null = null;
  let spendUnsettled = false;
  let totalMicroUsd = 0;
  if (mode === "read") {
    const allowed = deploymentOf(env) !== "production" || env.REPLAY_PRODUCTION_LABELED;
    const saved = allowed ? await readReplay(key, env.AGENT_REPLAY_DIR) : undefined;
    const parsed = agent.output.safeParse(saved);
    if (allowed && parsed.success) {
      output = parsed.data;
      replayed = true;
    } else {
      errorKind = "no_replay";
      error = ERROR_MESSAGES.no_replay;
    }
  } else {
    while (attempts <= Math.min(agent.maxRetries, 1) && output === null) {
      const hold = await preflightAttempt({ model, systemText: agent.system, promptText: prompt, maxTokens: agent.maxTokens, controls: opts.spend, env });
      if (!hold.ok) {
        spendRefusal = hold.refusal;
        errorKind = hold.refusal.errorKind;
        error = ERROR_MESSAGES[errorKind];
        break;
      }
      attempts++;
      let attemptUsage: Usage | null = null;
      let retry = true;
      try {
        const client = opts.client ?? getClient(env);
        const res = await client.messages.parse(
          {
            model, max_tokens: agent.maxTokens,
            system: [{ type: "text", text: agent.system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: prompt }],
            output_config: { format: zodOutputFormat(agent.output) },
          },
          { timeout: agent.timeoutMs, maxRetries: 0 },
        );
        attemptUsage = res.usage ?? null;
        if (res.stop_reason === "max_tokens") throw new AgentOutputError("truncated");
        if (res.stop_reason === "refusal") throw new AgentOutputError("refusal");
        const checked = agent.output.safeParse(res.parsed_output);
        if (!checked.success) throw new AgentOutputError("schema");
        output = checked.data;
        error = undefined;
        errorKind = undefined;
      } catch (err) {
        errorKind = classifyError(err);
        error = ERROR_MESSAGES[errorKind];
        retry = isRetryable(err);
      } finally {
        const settled = await settleAttempt({ controls: opts.spend!, reservationId: hold.reservationId, estimateMicroUsd: hold.estimateMicroUsd, price: hold.price, usage: attemptUsage });
        totalMicroUsd += settled.actualMicroUsd;
        spendUnsettled ||= !settled.settled;
        if (settled.usageTrusted && attemptUsage) {
          usage = sumUsage(usage, attemptUsage);
        }
      }
      if (!retry) break;
    }
    if (output !== null && mode === "record") {
      try { await writeReplay(key, output, env.AGENT_REPLAY_DIR); }
      catch {
        // Recording failure must not erase an already paid, validated run.
        recordingError = "replay_write_failed";
        error = "The replay could not be saved.";
      }
    }
  }

  const quoteChecks = output !== null && agent.extractQuotes ? verifyQuotes(agent.extractQuotes(output), input.documents) : [];
  const status: RunStatus =
    output === null ? "failed" : quoteChecks.some((q) => q.status === "unsupported") ? "needs_review" : "ok";
  const cost = totalMicroUsd / 1_000_000;

  await opts.recordRun?.({
    agent: agent.name,
    version: agent.version,
    model,
    inputHash: createHash("sha256").update(prompt).digest("hex"),
    status,
    attempts,
    output,
    quoteChecks,
    usage,
    costUsd: cost,
    replayed,
    error,
    errorKind,
    recordingError,
    spendRefusal,
    spendUnsettled,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  });

  return { output, quoteChecks, status, usage, costUsd: cost, error, errorKind, recordingError, spendRefusal, spendUnsettled };
}

/** Re-exported so agents and scripts import document helpers from one place. */
export { formatDocuments };
export type { SourceDocument };
