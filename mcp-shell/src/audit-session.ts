/**
 * In-memory session trail of operationIds seen by this MCP server process.
 * The daemon's method table is frozen (P1 spec v1.3 §10.3), so `gp_recent_reports`
 * cannot ask the daemon to enumerate its history — this shell tracks the
 * operationIds returned by act/assert/diagnose/restore/last_evidence itself,
 * mirroring the daemon's bounded-memory semantics.
 *
 * Lifecycle: cleared on every successful `gp_attach` (the daemon invalidates
 * its evidence history when the attached app changes; re-attach is idempotent
 * and simply restarts the trail). Does not persist across process restarts.
 */
export const AUDIT_HISTORY_LIMIT = 20;

export class EvidenceAuditSession {
  private ids: string[] = [];

  /** Record every operationId/evidenceId found in an engine result frame. */
  record(result: unknown): void {
    for (const id of collectOperationIds(result)) {
      if (!this.ids.includes(id)) {
        this.ids.push(id);
        if (this.ids.length > AUDIT_HISTORY_LIMIT) {
          this.ids.splice(0, this.ids.length - AUDIT_HISTORY_LIMIT);
        }
      }
    }
  }

  /** Clear the trail (called after a successful attach). */
  reset(): void {
    this.ids = [];
  }

  /** The most recent `limit` recorded operationIds, oldest first. */
  recentIds(limit: number): string[] {
    return this.ids.slice(-limit);
  }
}

/**
 * Bounded recursive walk (depth ≤ 3) that collects string-valued
 * `operationId` / `evidenceId` fields — from act/assert/diagnose/restore
 * results and from nested `evidencePack` frames. Depth is capped so an
 * adversarial frame cannot force an unbounded descent.
 */
function collectOperationIds(value: unknown, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 3 || value === null || typeof value !== "object") {
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      out.push(...collectOperationIds(item, depth + 1));
    }
    return out;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if ((key === "operationId" || key === "evidenceId") && typeof entry === "string") {
      out.push(entry);
    } else {
      out.push(...collectOperationIds(entry, depth + 1));
    }
  }
  return out;
}