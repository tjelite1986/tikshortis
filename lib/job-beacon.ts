// The detached scripts (duplicate scan, title fetch, caption backfill) report
// through a single-row beacon table. A 'running' row older than this is stale:
// the script was killed (container restart, SIGKILL) without writing a final
// status, and without the check its button could never be pressed again.
const STALE_MS = 60 * 60 * 1000;

export function staleRunning(startedAt: string | null | undefined): boolean {
  if (!startedAt) return true;
  const t = new Date(startedAt.replace(" ", "T") + "Z").getTime();
  return !Number.isFinite(t) || Date.now() - t > STALE_MS;
}
