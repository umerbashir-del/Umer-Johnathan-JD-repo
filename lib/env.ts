import "server-only";
import { z } from "zod";

// The only reader of process.env (TRD M8). Parse once, fail closed.

export type EnvProblem =
  | "required_when_hosted"
  | "invalid_flag"
  | "invalid_datetime"
  | "invalid_url"
  | "too_short";

export type EnvIssue = { key: string; problem: EnvProblem };

export class EnvError extends Error {
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    // Keys and problem codes only. Never a value.
    super(`Invalid environment: ${issues.map((i) => `${i.key}: ${i.problem}`).join(", ")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

const MODEL_DEFAULT = "claude-haiku-5-5";
const AGENT_REPLAY_DIR = ".agent-replay";
const AUTH_SECRET_MIN = 32;
const DEMO_CREDENTIAL_MIN = 20;
const DEMO_CREDENTIAL_PREFIX = "DEMO_CREDENTIAL_";
const HOSTED_REQUIRED = ["APP_ORIGIN", "AUTH_SECRET", "DATABASE_URL"] as const;

// Each schema's error message is its EnvProblem code, so issues map 1:1.
const text = z
  .string()
  .optional()
  .transform((v) => v ?? null);

const flag = z
  .enum(["0", "1"], { error: "invalid_flag" })
  .optional()
  .transform((v) => v === "1");

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

const schema = z.object({
  DATABASE_URL: text,
  SPEND_LEDGER_URL: text,
  ANTHROPIC_API_KEY: text,
  MODEL_DEFAULT: z.string().default(MODEL_DEFAULT),
  AGENT_REPLAY: flag,
  AGENT_RECORD: flag,
  AGENT_REPLAY_DIR: z.string().default(AGENT_REPLAY_DIR),
  REPLAY_PRODUCTION_LABELED: flag,
  AUTH_SECRET: z
    .string()
    .min(AUTH_SECRET_MIN, { error: "too_short" })
    .optional()
    .transform((v) => v ?? null),
  APP_ORIGIN: z
    .string()
    .refine(isOrigin, { error: "invalid_url" })
    .optional()
    .transform((v) => v ?? null),
  APP_DEPLOYMENT: text,
  SPEND_DEMO_RESERVE_UNLOCKED: flag,
  FREEFORM_UPLOAD_ENABLED: flag,
  DEMO_NOW: z.iso
    .datetime({ offset: true, error: "invalid_datetime" })
    .optional()
    .transform((v) => (v === undefined ? null : new Date(v))),
  VERCEL: text,
  VERCEL_ENV: text,
  VERCEL_URL: text,
});

export type Env = z.output<typeof schema> & { demoCredentials: Record<string, string> };

export type Deployment = "local" | "preview" | "production";

type DeploymentInputs = Pick<Env, "APP_DEPLOYMENT" | "VERCEL" | "VERCEL_ENV" | "VERCEL_URL">;

// TRD §5.4: hosted unless explicitly local with no Vercel variable present.
// Case-sensitive on purpose: "Local" or " local" means hosted.
function hostedFrom(env: DeploymentInputs): boolean {
  const vercelPresent = Boolean(env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL);
  return !(env.APP_DEPLOYMENT === "local" && !vercelPresent);
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  // An empty string means unset, for every key.
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    raw[key] = value === "" ? undefined : value;
  }

  const issues: EnvIssue[] = [];
  const demoCredentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith(DEMO_CREDENTIAL_PREFIX) || value === undefined) continue;
    const account = key.slice(DEMO_CREDENTIAL_PREFIX.length);
    if (account === "") continue;
    if (value.length < DEMO_CREDENTIAL_MIN) issues.push({ key, problem: "too_short" });
    else demoCredentials[account.toLowerCase()] = value;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({ key: String(issue.path[0]), problem: issue.message as EnvProblem });
    }
  }

  const hosted = hostedFrom({
    APP_DEPLOYMENT: raw.APP_DEPLOYMENT ?? null,
    VERCEL: raw.VERCEL ?? null,
    VERCEL_ENV: raw.VERCEL_ENV ?? null,
    VERCEL_URL: raw.VERCEL_URL ?? null,
  });
  if (hosted) {
    for (const key of HOSTED_REQUIRED) {
      if (raw[key] === undefined) issues.push({ key, problem: "required_when_hosted" });
    }
  }

  if (issues.length > 0 || !result.success) {
    issues.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    throw new EnvError(issues);
  }
  return { ...result.data, demoCredentials };
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

export function isHosted(env: Env = getEnv()): boolean {
  return hostedFrom(env);
}

export function deploymentOf(env: Env): Deployment {
  if (!hostedFrom(env)) return "local";
  if (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development") return "preview";
  return "production";
}
