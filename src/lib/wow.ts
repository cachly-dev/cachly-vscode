// Pure week-over-week helpers, extracted from extension.ts so they can be unit
// tested without importing the `vscode` module.

/** One day of activity, from the insights endpoint's 30-day trend array. */
export interface TrendBucket {
  date: string; // YYYY-MM-DD
  events: number; // mcp_events rows for that day
  fixes: number;
}

export interface WeekOverWeek {
  thisWeek: number;
  lastWeek: number;
  /** null when there's no prior-week baseline to compare against. */
  pct: number | null;
}

/**
 * Week-over-week change from the trend array: last 7 days vs the prior 7.
 * `pct` is null when the prior week has no activity (no baseline), so callers
 * can show "no baseline yet" instead of a misleading percentage.
 */
export function computeWoW(trend: TrendBucket[] | undefined): WeekOverWeek {
  if (!trend || trend.length === 0) return { thisWeek: 0, lastWeek: 0, pct: null };
  const sorted = [...trend].sort((a, b) => a.date.localeCompare(b.date));
  const last7 = sorted.slice(-7);
  const prior7 = sorted.slice(-14, -7);
  const sum = (b: TrendBucket[]) => b.reduce((s, d) => s + (d.events ?? 0), 0);
  const thisWeek = sum(last7);
  const lastWeek = sum(prior7);
  const pct = lastWeek > 0 ? ((thisWeek - lastWeek) / lastWeek) * 100 : null;
  return { thisWeek, lastWeek, pct };
}
