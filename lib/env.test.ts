import { describe, expect, it } from "vitest";
import { EnvError, deploymentOf, getEnv, isHosted, parseEnv, type EnvIssue } from "./env";

// Obviously fake values (spec 001).
const HOSTED_KEYS = {
  DATABASE_URL: "postgres://test",
  AUTH_SECRET: "x".repeat(32),
  APP_ORIGIN: "https://example.test",
};

const LOCAL = { APP_DEPLOYMENT: "local" };

function issuesOf(source: Record<string, string | undefined>): EnvIssue[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.issues;
    throw error;
  }
  throw new Error("expected parseEnv to throw EnvError");
}

describe("flags", () => {
  it('"1" is true', () => {
    expect(parseEnv({ ...LOCAL, AGENT_REPLAY: "1" }).AGENT_REPLAY).toBe(true);
  });

  it('"", unset and "0" are false', () => {
    expect(parseEnv({ ...LOCAL, AGENT_REPLAY: "" }).AGENT_REPLAY).toBe(false);
    expect(parseEnv({ ...LOCAL }).AGENT_REPLAY).toBe(false);
    expect(parseEnv({ ...LOCAL, AGENT_REPLAY: "0" }).AGENT_REPLAY).toBe(false);
  });

  it('"true" is invalid_flag, not silently live mode', () => {
    expect(issuesOf({ ...LOCAL, AGENT_REPLAY: "true" })).toEqual([
      { key: "AGENT_REPLAY", problem: "invalid_flag" },
    ]);
  });

  it('"yes" and " 1" are invalid_flag on every flag key', () => {
    expect(
      issuesOf({
        ...LOCAL,
        AGENT_RECORD: "yes",
        REPLAY_PRODUCTION_LABELED: " 1",
        SPEND_DEMO_RESERVE_UNLOCKED: "true",
        FREEFORM_UPLOAD_ENABLED: "on",
      }),
    ).toEqual([
      { key: "AGENT_RECORD", problem: "invalid_flag" },
      { key: "FREEFORM_UPLOAD_ENABLED", problem: "invalid_flag" },
      { key: "REPLAY_PRODUCTION_LABELED", problem: "invalid_flag" },
      { key: "SPEND_DEMO_RESERVE_UNLOCKED", problem: "invalid_flag" },
    ]);
  });

  it("replay and record may both be set (precedence is spec 004)", () => {
    const env = parseEnv({ ...LOCAL, AGENT_REPLAY: "1", AGENT_RECORD: "1" });
    expect([env.AGENT_REPLAY, env.AGENT_RECORD]).toEqual([true, true]);
  });
});

describe("DEMO_NOW", () => {
  it("an offset date-time parses to the exact instant", () => {
    const env = parseEnv({ ...LOCAL, DEMO_NOW: "2026-11-03T09:00:00-05:00" });
    expect(env.DEMO_NOW?.getTime()).toBe(Date.UTC(2026, 10, 3, 14, 0, 0));
  });

  it("unset is null", () => {
    expect(parseEnv({ ...LOCAL, DEMO_NOW: "" }).DEMO_NOW).toBeNull();
  });

  it("a bare date is invalid_datetime", () => {
    expect(issuesOf({ ...LOCAL, DEMO_NOW: "2026-11-03" })).toEqual([
      { key: "DEMO_NOW", problem: "invalid_datetime" },
    ]);
  });

  it("a zone-less date-time is invalid_datetime", () => {
    expect(issuesOf({ ...LOCAL, DEMO_NOW: "2026-11-03T09:00:00" })).toEqual([
      { key: "DEMO_NOW", problem: "invalid_datetime" },
    ]);
  });
});

describe("defaults and plain strings", () => {
  it('MODEL_DEFAULT unset is "claude-haiku-5-5"', () => {
    expect(parseEnv({ ...LOCAL }).MODEL_DEFAULT).toBe("claude-haiku-5-5");
  });

  it('AGENT_REPLAY_DIR unset is ".agent-replay"', () => {
    expect(parseEnv({ ...LOCAL, AGENT_REPLAY_DIR: "" }).AGENT_REPLAY_DIR).toBe(".agent-replay");
  });

  it("unset string keys are null, and empty means unset", () => {
    const env = parseEnv({ ...LOCAL, ANTHROPIC_API_KEY: "", SPEND_LEDGER_URL: "" });
    expect([env.ANTHROPIC_API_KEY, env.SPEND_LEDGER_URL, env.DATABASE_URL, env.VERCEL_ENV]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("APP_ORIGIN and AUTH_SECRET", () => {
  it("an origin with a trailing slash only is accepted", () => {
    expect(parseEnv({ ...LOCAL, APP_ORIGIN: "https://example.test/" }).APP_ORIGIN).toBe(
      "https://example.test/",
    );
  });

  it("a path, a non-http scheme or garbage is invalid_url", () => {
    for (const APP_ORIGIN of ["https://example.test/app", "ftp://example.test", "not a url"]) {
      expect(issuesOf({ ...LOCAL, APP_ORIGIN })).toEqual([{ key: "APP_ORIGIN", problem: "invalid_url" }]);
    }
  });

  it("AUTH_SECRET at 32 is accepted, at 31 is too_short", () => {
    expect(parseEnv({ ...LOCAL, AUTH_SECRET: "s".repeat(32) }).AUTH_SECRET).toBe("s".repeat(32));
    expect(issuesOf({ ...LOCAL, AUTH_SECRET: "s".repeat(31) })).toEqual([
      { key: "AUTH_SECRET", problem: "too_short" },
    ]);
  });
});

describe("demo credentials", () => {
  it("a 20-character value is accepted under the lower-cased suffix", () => {
    const value = "c".repeat(20);
    expect(parseEnv({ ...LOCAL, DEMO_CREDENTIAL_CLINICIAN_A: value }).demoCredentials).toEqual({
      clinician_a: value,
    });
  });

  it("a 19-character value is too_short on its key", () => {
    expect(issuesOf({ ...LOCAL, DEMO_CREDENTIAL_X: "c".repeat(19) })).toEqual([
      { key: "DEMO_CREDENTIAL_X", problem: "too_short" },
    ]);
  });

  it("a missing or empty credential means no entry (no default)", () => {
    expect(parseEnv({ ...LOCAL }).demoCredentials).toEqual({});
    expect(parseEnv({ ...LOCAL, DEMO_CREDENTIAL_CLINICIAN_A: "" }).demoCredentials).toEqual({});
  });

  it("DEMO_CREDENTIAL_ with an empty suffix is ignored", () => {
    expect(parseEnv({ ...LOCAL, DEMO_CREDENTIAL_: "c".repeat(25) }).demoCredentials).toEqual({});
    expect(parseEnv({ ...LOCAL, DEMO_CREDENTIAL_: "short" }).demoCredentials).toEqual({});
  });
});

describe("hosted with required keys missing", () => {
  const MISSING = [
    { key: "APP_ORIGIN", problem: "required_when_hosted" },
    { key: "AUTH_SECRET", problem: "required_when_hosted" },
    { key: "DATABASE_URL", problem: "required_when_hosted" },
  ];

  it("parseEnv({}) throws one EnvError with all three, sorted", () => {
    expect(issuesOf({})).toEqual(MISSING);
  });

  it('a mistyped APP_DEPLOYMENT ("Local", " local") counts as hosted', () => {
    expect(issuesOf({ APP_DEPLOYMENT: "Local" })).toEqual(MISSING);
    expect(issuesOf({ APP_DEPLOYMENT: " local" })).toEqual(MISSING);
  });

  it("APP_DEPLOYMENT=local with VERCEL present counts as hosted", () => {
    expect(issuesOf({ APP_DEPLOYMENT: "local", VERCEL: "1" })).toEqual(MISSING);
  });

  it("empty strings count as missing", () => {
    expect(issuesOf({ DATABASE_URL: "", AUTH_SECRET: "", APP_ORIGIN: "" })).toEqual(MISSING);
  });

  it("every failing key is reported at once, sorted by key", () => {
    expect(
      issuesOf({ AGENT_REPLAY: "yes", DEMO_NOW: "2026-11-03", DEMO_CREDENTIAL_A: "short" }),
    ).toEqual([
      { key: "AGENT_REPLAY", problem: "invalid_flag" },
      { key: "APP_ORIGIN", problem: "required_when_hosted" },
      { key: "AUTH_SECRET", problem: "required_when_hosted" },
      { key: "DATABASE_URL", problem: "required_when_hosted" },
      { key: "DEMO_CREDENTIAL_A", problem: "too_short" },
      { key: "DEMO_NOW", problem: "invalid_datetime" },
    ]);
  });
});

describe("errors name keys, never values", () => {
  it("a secret value appears in neither message, issues nor String(error)", () => {
    const secret = "sk-secret-VALUE-9f8e7d";
    let caught: unknown;
    try {
      parseEnv({ ...LOCAL, AUTH_SECRET: secret, DEMO_CREDENTIAL_A: secret.slice(0, 10), APP_ORIGIN: secret });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvError);
    const error = caught as EnvError;
    expect(error.issues).toEqual([
      { key: "APP_ORIGIN", problem: "invalid_url" },
      { key: "AUTH_SECRET", problem: "too_short" },
      { key: "DEMO_CREDENTIAL_A", problem: "too_short" },
    ]);
    expect(error.message).toBe(
      "Invalid environment: APP_ORIGIN: invalid_url, AUTH_SECRET: too_short, DEMO_CREDENTIAL_A: too_short",
    );
    for (const text of [error.message, JSON.stringify(error.issues), String(error)]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(0, 10));
    }
  });
});

describe("deployment table", () => {
  const rows: [string, Record<string, string>, boolean, string][] = [
    ["local", { APP_DEPLOYMENT: "local" }, false, "local"],
    ["no APP_DEPLOYMENT", { ...HOSTED_KEYS }, true, "production"],
    ["local plus VERCEL", { ...HOSTED_KEYS, APP_DEPLOYMENT: "local", VERCEL: "1" }, true, "production"],
    ["local plus VERCEL_URL", { ...HOSTED_KEYS, APP_DEPLOYMENT: "local", VERCEL_URL: "x.vercel.app" }, true, "production"],
    ["VERCEL_ENV preview", { ...HOSTED_KEYS, VERCEL_ENV: "preview" }, true, "preview"],
    ["VERCEL_ENV development", { ...HOSTED_KEYS, VERCEL_ENV: "development" }, true, "preview"],
    ["VERCEL_ENV production", { ...HOSTED_KEYS, VERCEL_ENV: "production" }, true, "production"],
    ["VERCEL_ENV weird", { ...HOSTED_KEYS, VERCEL_ENV: "weird" }, true, "production"],
    ["APP_DEPLOYMENT Local", { ...HOSTED_KEYS, APP_DEPLOYMENT: "Local" }, true, "production"],
  ];

  for (const [name, source, hosted, deployment] of rows) {
    it(`${name}: isHosted ${hosted}, deploymentOf ${deployment}`, () => {
      const env = parseEnv(source);
      expect(isHosted(env)).toBe(hosted);
      expect(deploymentOf(env)).toBe(deployment);
    });
  }
});

describe("getEnv", () => {
  it("is memoized: two calls return the same object", () => {
    expect(getEnv()).toBe(getEnv());
  });

  it("under the test config it is local with spend keys blanked", () => {
    const env = getEnv();
    expect([isHosted(), env.ANTHROPIC_API_KEY, env.SPEND_LEDGER_URL, env.AGENT_REPLAY, env.AGENT_RECORD]).toEqual([
      false,
      null,
      null,
      false,
      false,
    ]);
  });
});
