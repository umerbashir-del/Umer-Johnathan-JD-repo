import { describe, expect, it } from "vitest";
import { businessDate, businessNow, isDemoClock, systemNow } from "./clock";

describe("business and system clocks", () => {
  const demo = { DEMO_NOW: new Date("2026-11-03T14:00:00Z") };
  const real = () => new Date("2030-01-01T00:00:00Z");

  it("freezes business time while system time remains real", () => {
    expect(businessNow(demo, real).toISOString()).toBe("2026-11-03T14:00:00.000Z");
    expect(businessNow({ DEMO_NOW: null }, real).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(systemNow(real).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(isDemoClock(demo)).toBe(true);
    expect(isDemoClock({ DEMO_NOW: null })).toBe(false);
  });

  it("returns fresh instances so callers cannot mutate the clock", () => {
    businessNow(demo, real).setFullYear(1990);
    expect(businessNow(demo, real).toISOString()).toBe("2026-11-03T14:00:00.000Z");
    const source = real();
    systemNow(() => source).setFullYear(1990);
    expect(source.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it.each([
    ["2026-11-03T03:30:00Z", "2026-11-02"],
    ["2026-11-03T05:00:00Z", "2026-11-03"],
    ["2026-11-01T05:30:00Z", "2026-11-01"],
    ["2026-11-02T04:59:00Z", "2026-11-01"],
  ])("computes New York business date at %s", (instant, expected) => {
    expect(businessDate(new Date(instant))).toBe(expected);
  });
});
