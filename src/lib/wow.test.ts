import { describe, it, expect } from 'vitest';
import { computeWoW, type TrendBucket } from './wow';

// Helper: build a trend of N consecutive days each with the same event count,
// starting at 2026-01-01. Index 0 is the oldest day.
function days(events: number[]): TrendBucket[] {
  return events.map((e, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { date: d.toISOString().slice(0, 10), events: e, fixes: 0 };
  });
}

describe('computeWoW', () => {
  it('returns null pct for empty/undefined trend', () => {
    expect(computeWoW(undefined)).toEqual({ thisWeek: 0, lastWeek: 0, pct: null });
    expect(computeWoW([])).toEqual({ thisWeek: 0, lastWeek: 0, pct: null });
  });

  it('returns null pct when there is no prior-week baseline', () => {
    // Only one week of data → prior week sums to 0 → pct null.
    const r = computeWoW(days([1, 2, 3, 4, 5, 6, 7]));
    expect(r.thisWeek).toBe(28);
    expect(r.lastWeek).toBe(0);
    expect(r.pct).toBeNull();
  });

  it('computes a positive week-over-week increase', () => {
    // prior 7 days = 1 each (7), last 7 days = 2 each (14) → +100%.
    const r = computeWoW(days([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2]));
    expect(r.lastWeek).toBe(7);
    expect(r.thisWeek).toBe(14);
    expect(r.pct).toBe(100);
  });

  it('computes a negative week-over-week decrease', () => {
    // prior = 10 each (70), last = 5 each (35) → -50%.
    const r = computeWoW(days([10, 10, 10, 10, 10, 10, 10, 5, 5, 5, 5, 5, 5, 5]));
    expect(r.lastWeek).toBe(70);
    expect(r.thisWeek).toBe(35);
    expect(r.pct).toBe(-50);
  });

  it('reports 0% when both weeks are equal', () => {
    const r = computeWoW(days([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]));
    expect(r.pct).toBe(0);
  });

  it('only uses the last 14 days even with a longer trend', () => {
    // 30 days of 1 event each: last 7 = 7, prior 7 = 7, older 16 ignored → 0%.
    const r = computeWoW(days(new Array(30).fill(1)));
    expect(r.thisWeek).toBe(7);
    expect(r.lastWeek).toBe(7);
    expect(r.pct).toBe(0);
  });

  it('sorts by date before slicing (order-independent)', () => {
    const ordered = days([1, 1, 1, 1, 1, 1, 1, 9, 9, 9, 9, 9, 9, 9]);
    const shuffled = [...ordered].reverse();
    expect(computeWoW(shuffled)).toEqual(computeWoW(ordered));
  });

  it('treats a missing events field as 0', () => {
    const trend = [
      { date: '2026-02-01', events: undefined as unknown as number, fixes: 0 },
      { date: '2026-02-02', events: 4, fixes: 0 },
    ];
    // Single week, no baseline → pct null, thisWeek counts only the 4.
    const r = computeWoW(trend);
    expect(r.thisWeek).toBe(4);
    expect(r.pct).toBeNull();
  });
});
