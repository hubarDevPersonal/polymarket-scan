import { describe, it, expect } from "vitest";
import { getMonthRange, getWeekRange } from "../binance";

describe("getMonthRange", () => {
  it("returns correct range for January 2026", () => {
    const range = getMonthRange(2026, 1);
    expect(range.startTime).toBe(Date.UTC(2026, 0, 1)); // Jan 1
    expect(range.endTime).toBe(Date.UTC(2026, 1, 1) - 1); // Jan 31 23:59:59.999
  });

  it("returns correct range for February in a non-leap year", () => {
    const range = getMonthRange(2025, 2);
    const start = new Date(range.startTime);
    const end = new Date(range.endTime);
    expect(start.getUTCMonth()).toBe(1); // Feb
    expect(start.getUTCDate()).toBe(1);
    expect(end.getUTCMonth()).toBe(1); // Still Feb
    expect(end.getUTCDate()).toBe(28);
  });

  it("returns correct range for December", () => {
    const range = getMonthRange(2025, 12);
    const start = new Date(range.startTime);
    const end = new Date(range.endTime);
    expect(start.getUTCMonth()).toBe(11);
    expect(start.getUTCDate()).toBe(1);
    expect(end.getUTCMonth()).toBe(11);
    expect(end.getUTCDate()).toBe(31);
  });

  it("startTime is always before endTime", () => {
    for (let m = 1; m <= 12; m++) {
      const range = getMonthRange(2026, m);
      expect(range.startTime).toBeLessThan(range.endTime);
    }
  });
});

describe("getWeekRange", () => {
  it("returns Monday-Sunday for a mid-week date", () => {
    // Wednesday, Jan 15, 2025
    const range = getWeekRange(new Date("2025-01-15T12:00:00Z"));
    const start = new Date(range.startTime);
    const end = new Date(range.endTime);
    expect(start.getUTCDay()).toBe(1); // Monday
    expect(start.getUTCDate()).toBe(13); // Mon Jan 13
    expect(end.getUTCDay()).toBe(0); // Sunday
    expect(end.getUTCDate()).toBe(19); // Sun Jan 19
  });

  it("returns correct range when date is already Monday", () => {
    // Monday, Jan 13, 2025
    const range = getWeekRange(new Date("2025-01-13T00:00:00Z"));
    const start = new Date(range.startTime);
    expect(start.getUTCDay()).toBe(1);
    expect(start.getUTCDate()).toBe(13);
  });

  it("returns correct range when date is Sunday", () => {
    // Sunday, Jan 19, 2025
    const range = getWeekRange(new Date("2025-01-19T23:59:59Z"));
    const start = new Date(range.startTime);
    expect(start.getUTCDay()).toBe(1);
    expect(start.getUTCDate()).toBe(13);
  });

  it("span is exactly 7 days minus 1ms", () => {
    const range = getWeekRange(new Date("2025-06-10"));
    const span = range.endTime - range.startTime;
    expect(span).toBe(7 * 24 * 60 * 60 * 1000 - 1);
  });
});
