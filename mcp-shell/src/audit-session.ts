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

/**
 * One position in a session's trail *request order*, handed out by
 * {@link EvidenceAuditSession.claimTrailTurn}. `release` is idempotent.
 */
export interface TrailTurn {
  /** Wait until every turn claimed before this one has released. */
  acquire(): Promise<void>;
  /** Hand the trail on: this turn is done with it, or never will be. */
  release(): void;
}

/** A claimed position whose holder has not released yet. */
interface TrailGate {
  settled: Promise<void>;
  settle: () => void;
}

function openTrailGate(): TrailGate {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = () => resolve(undefined);
  });
  return { settled, settle };
}

export class EvidenceAuditSession {
  private ids: string[] = [];

  /**
   * Turns claimed but not released. This, not a "latest gate", is what a new
   * claim waits for: a turn that abandons the trail (its engine call failed
   * before any mutation) releases *out of order*, and a chain that only looked
   * at the immediately preceding turn would let everything behind it run while
   * an older, still-outstanding act had not written yet — the exact completion
   * order the turn machinery exists to remove.
   */
  private openGates = new Set<TrailGate>();

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

  /**
   * Clear the trail (called after a successful attach).
   *
   * Deliberately does *not* touch {@link openGates}: outstanding turns are not
   * outstanding mutations, and forgetting them would let a later read overtake
   * an act that is still going to write.
   */
  reset(): void {
    this.ids = [];
  }

  /** The most recent `limit` recorded operationIds, oldest first. */
  recentIds(limit: number): string[] {
    return this.ids.slice(-limit);
  }

  /**
   * Claim the next position in this session's trail request order, so that
   * overlapping calls mutate and read `ids` in the order they were admitted
   * rather than in the order the daemon answered.
   *
   * Synchronous on purpose — a claim made after an `await` would itself be
   * ordered by completion. Callers hold a turn only across a `record()` /
   * `reset()` / `recentIds()`, never across an engine round trip, so the queue
   * can delay the moment a reply is built but never a request at the daemon.
   */
  claimTrailTurn(): TrailTurn {
    const ahead = [...this.openGates];
    const mine = openTrailGate();
    this.openGates.add(mine);
    let released = false;
    return {
      acquire: async () => {
        await Promise.all(ahead.map((gate) => gate.settled));
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.openGates.delete(mine);
        mine.settle();
      },
    };
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