export type Turn = { id: string; status: string; error?: { codexErrorInfo?: unknown } | null };
export const quotaFailure = (t: Turn) => t.status === 'failed' && t.error?.codexErrorInfo === 'usageLimitExceeded';
export const CONTINUE = 'The previous turn stopped because the usage allowance was exhausted and has now been verified available. Inspect the actual conversation, working tree, files, tests, and any recorded progress first. Identify what is already complete; do not duplicate or undo completed work. Continue only the unfinished part of the original task in this same session. Preserve all existing instructions, sandbox and approval policies. If the task is already complete, report completion and stop. If you need user input or permission, ask and stop; do not assume approval.';
export type Usage = { ordinaryUsageAllowed?: boolean | null; accountId?: string | null; rateLimits: any; rateLimitsByLimitId?: Record<string, any> | null };
export function allowance(u: Usage, limit: string, now: number): { ready: boolean; next?: number; reason: string } {
  const b = u.rateLimitsByLimitId ? u.rateLimitsByLimitId[limit] : u.rateLimits;
  if (!b || b.limitId !== limit) return {ready:false, reason:'Unknown quota bucket'};
  if (b.spendControlReached || b.individualLimit || (b.rateLimitReachedType && b.rateLimitReachedType !== 'rate_limit_reached')) return {ready:false, reason:'Non-window limit requires attention'};
  const windows = [b.primary, b.secondary].filter(x => x != null);
  if (!b.primary || windows.some(w => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) return {ready:false, reason:'Incomplete usage data'};
  const exhausted = windows.filter(w => w.usedPercent >= 100);
  const times = exhausted.map(w => w.resetsAt * 1000).filter(t => Number.isFinite(t) && t > now);
  if (exhausted.length) return {ready:false, next:times.length === exhausted.length ? Math.max(...times) + 15000 : undefined, reason:'Window exhausted'};
  // This installed protocol explicitly forbids inferring recovery from percentages alone.
  if (u.ordinaryUsageAllowed !== true) return {ready:false, reason:'Ordinary usage not explicitly allowed'};
  if (b.rateLimitReachedType || windows.some(w => !Number.isFinite(w.resetsAt) || w.resetsAt * 1000 <= now)) return {ready:false, reason:'Stale or contradictory usage snapshot'};
  return {ready:true, reason:'Backend verified allowance'};
}
