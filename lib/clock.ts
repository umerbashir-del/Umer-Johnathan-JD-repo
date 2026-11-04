import { getEnv, type Env } from "./env";

export const BUSINESS_TIME_ZONE = "America/New_York";

export function businessNow(
  env: Pick<Env, "DEMO_NOW"> = getEnv(),
  realNow: () => Date = () => new Date(),
): Date {
  return new Date((env.DEMO_NOW ?? realNow()).getTime());
}

export function systemNow(realNow: () => Date = () => new Date()): Date {
  return new Date(realNow().getTime());
}

export function isDemoClock(env: Pick<Env, "DEMO_NOW"> = getEnv()): boolean {
  return env.DEMO_NOW !== null;
}

export function businessDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
