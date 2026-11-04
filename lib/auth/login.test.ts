import { describe, expect, it } from "vitest";
import { attemptLogin, credentialMatches, loginKey, recordLoginFailure, type LoginAttemptStore, type LoginUser, type ThrottleState } from "./login";

const goodCredential = "synthetic-test-credential-123";
const user: LoginUser = { id: "u-a", name: "Synthetic Clinician", email: "clinician@example.test", role: "clinician" };
const env = { demoCredentials: { clinician_a: goodCredential } };
const now = new Date("2030-01-01T12:00:00Z");

class FakeLoginStore implements LoginAttemptStore {
  states = new Map<string, ThrottleState>();
  events: { outcome: string; reasonCode: string; userId?: string }[] = [];
  users = new Map([['clinician_a', user]]);
  async getState(key: string) { return this.states.get(key) ?? { failureTimes: [], blockedUntil: null }; }
  async putState(key: string, state: ThrottleState) { this.states.set(key, state); }
  async findUser(account: string) { return this.users.get(account) ?? null; }
  async audit(outcome: "success" | "refused", reasonCode: string, userId?: string) { this.events.push({ outcome, reasonCode, userId }); }
}

describe("demo credential authorization", () => {
  it("accepts only an env credential and a matching clinician DB account", async () => {
    const store = new FakeLoginStore();
    expect(await attemptLogin(store, { account: "clinician_a", credential: goodCredential }, "127.0.0.1", env, now)).toEqual({ status: "ok", user });
    expect(store.events).toEqual([{ outcome: "success", reasonCode: "login_succeeded", userId: "u-a" }]);
    expect(store.states.get(loginKey("account", "clinician_a"))).toEqual({ failureTimes: [], blockedUntil: null });
  });

  it("has no default credential or local role switch", async () => {
    const scenarios: { credentials: Record<string, string>; account: string; role: string }[] = [
      { credentials: {}, account: "clinician_a", role: "clinician" },
      { credentials: { clinician_a: goodCredential }, account: "unknown", role: "clinician" },
      { credentials: { clinician_a: goodCredential }, account: "clinician_a", role: "supervisor" },
      { credentials: { clinician_a: goodCredential }, account: "clinician_a", role: "coordinator" },
    ];
    for (const scenario of scenarios) {
      const store = new FakeLoginStore();
      store.users.set("clinician_a", { ...user, role: scenario.role });
      expect(await attemptLogin(store, { account: scenario.account, credential: goodCredential, role: "clinician", userId: "u-a" }, "ip", { demoCredentials: scenario.credentials }, now)).toEqual({ status: "invalid" });
      expect(store.events).toEqual([{ outcome: "refused", reasonCode: "invalid_credentials", userId: undefined }]);
    }
  });

  it.each([undefined, "", "short", `${goodCredential}x`])("rejects absent, short and mismatched configured credentials", (expected) => {
    expect(credentialMatches(goodCredential, expected)).toBe(false);
    expect(credentialMatches(goodCredential, goodCredential)).toBe(true);
  });

  it("never accepts two absent credentials or matching short credentials", () => {
    expect(credentialMatches("", undefined)).toBe(false);
    expect(credentialMatches("", "")).toBe(false);
    expect(credentialMatches("short", "short")).toBe(false);
  });

  it("blocks exactly on the fifth failure for fifteen minutes", async () => {
    const store = new FakeLoginStore();
    for (let i = 0; i < 4; i++) {
      expect(await attemptLogin(store, { account: "clinician_a", credential: "wrong" }, "ip", env, now)).toEqual({ status: "invalid" });
    }
    expect(await attemptLogin(store, { account: "clinician_a", credential: "wrong" }, "ip", env, now)).toEqual({ status: "throttled", retryAfterSeconds: 900 });
    expect(await attemptLogin(store, { account: "clinician_a", credential: goodCredential }, "different-ip", env, new Date(now.getTime() + 899_000))).toEqual({ status: "throttled", retryAfterSeconds: 1 });
    expect(await attemptLogin(store, { account: "clinician_a", credential: goodCredential }, "ip", env, new Date(now.getTime() + 900_000))).toEqual({ status: "ok", user });
    expect(store.events.at(-2)?.reasonCode).toBe("login_throttled");
  });

  it("blocks accounts independently of IP changes and IP independently of account changes", async () => {
    const accountStore = new FakeLoginStore();
    for (let i = 0; i < 5; i++) await attemptLogin(accountStore, { account: "clinician_a", credential: "bad" }, `ip-${i}`, env, now);
    expect(await attemptLogin(accountStore, { account: "clinician_a", credential: goodCredential }, "new-ip", env, now)).toEqual({ status: "throttled", retryAfterSeconds: 900 });
    const ipStore = new FakeLoginStore();
    for (let i = 0; i < 5; i++) await attemptLogin(ipStore, { account: `unknown_${i}`, credential: "bad" }, "same-ip", env, now);
    expect(await attemptLogin(ipStore, { account: "clinician_a", credential: goodCredential }, "same-ip", env, now)).toEqual({ status: "throttled", retryAfterSeconds: 900 });
  });

  it("uses a rolling window and starts the block from the fifth failure", () => {
    const state = { failureTimes: [0, 1, 2, 3].map((minutes) => new Date(now.getTime() - minutes * 60_000)), blockedUntil: null };
    expect(recordLoginFailure(state, now).blockedUntil?.toISOString()).toBe("2030-01-01T12:15:00.000Z");
    const expired = { failureTimes: [new Date(now.getTime() - 900_000)], blockedUntil: null };
    expect(recordLoginFailure(expired, now)).toEqual({ failureTimes: [now], blockedUntil: null });
    expect(state.failureTimes).toHaveLength(4);
  });

  it("hashes identifiers and never writes raw input in audits", async () => {
    const store = new FakeLoginStore();
    const raw = { account: "unknown", credential: "do-not-log-this" };
    expect(await attemptLogin(store, raw, "192.0.2.40", env, now)).toEqual({ status: "invalid" });
    const stored = JSON.stringify({ states: [...store.states.entries()], events: store.events });
    expect(stored).not.toContain(raw.credential);
    expect(stored).not.toContain(raw.account);
    expect(stored).not.toContain("192.0.2.40");
    expect(loginKey("account", "a")).not.toBe(loginKey("ip", "a"));
  });

  it.each([null, {}, { account: "clinician_a", credential: 5 }, { account: "clinician_a", credential: "x".repeat(1001) }])("rejects malformed credentials %j", async (raw) => {
    expect(await attemptLogin(new FakeLoginStore(), raw, "ip", env, now)).toEqual({ status: "invalid" });
  });

  it("fails closed when the persistent state cannot be loaded", async () => {
    const store = new FakeLoginStore();
    store.getState = async () => { throw new Error("database_unavailable"); };
    await expect(attemptLogin(store, { account: "clinician_a", credential: goodCredential }, "ip", env, now)).rejects.toThrow("database_unavailable");
    expect(store.events).toEqual([]);
  });
});
