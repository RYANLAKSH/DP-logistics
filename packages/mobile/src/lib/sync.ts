/**
 * Sync engine.
 *
 * Drains the outbound queue and refreshes the cached report. Runs on app open,
 * after every capture, and on a timer — never blocking the officer.
 */

import { uploadSessions, fetchReport } from './api.ts';
import {
  getPendingSessions,
  markSynced,
  markFailed,
  saveReport,
  pendingCount,
} from './store.ts';

export interface SyncOutcome {
  uploaded: number;
  failed: number;
  stillPending: number;
  reportRefreshed: boolean;
  /** Sessions where the server disagreed with the device's offline verdict. */
  disagreements: { sessionId: string; deviceOutcome?: string; serverOutcome?: string }[];
  offline: boolean;
}

let running = false;

/**
 * Uploads queued sessions, then refreshes the cache.
 *
 * Order matters: draining first means the report refresh already reflects our
 * own MATCHes, so loadedVins comes back consistent with what this device did.
 */
export async function runSync(locationId: string | null): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {
    uploaded: 0,
    failed: 0,
    stillPending: 0,
    reportRefreshed: false,
    disagreements: [],
    offline: false,
  };

  // A second concurrent run would double-submit; the server is idempotent, but
  // there is no reason to make it do the work.
  if (running) {
    outcome.stillPending = await pendingCount();
    return outcome;
  }
  running = true;

  try {
    const pending = await getPendingSessions();

    if (pending.length > 0) {
      const result = await uploadSessions(pending.map((session) => session.payload));

      if (result.ok) {
        const byId = new Map(result.data.sessions.map((entry) => [entry.id, entry]));

        for (const session of pending) {
          const server = byId.get(session.id);

          // 'duplicate' means the server already had it — that is success from
          // the queue's point of view, not a failure to retry forever.
          if (server && (server.status === 'accepted' || server.status === 'duplicate')) {
            await markSynced(session.id);
            outcome.uploaded++;

            if (server.outcomeDiffers) {
              outcome.disagreements.push({
                sessionId: session.id,
                deviceOutcome: session.deviceOutcome ?? undefined,
                serverOutcome: server.outcome,
              });
            }
          } else {
            await markFailed(session.id, server?.status ?? 'no server response');
            outcome.failed++;
          }
        }
      } else {
        outcome.offline = result.offline;
        for (const session of pending) await markFailed(session.id, result.message);
        outcome.failed = pending.length;
      }
    }

    if (locationId) {
      const report = await fetchReport(locationId);
      if (report.ok && report.data.report) {
        await saveReport(locationId, report.data.report, report.data.lines, report.data.loadedVins);
        outcome.reportRefreshed = true;
      } else if (!report.ok) {
        outcome.offline = outcome.offline || report.offline;
      }
    }

    outcome.stillPending = await pendingCount();
    return outcome;
  } finally {
    running = false;
  }
}

/**
 * Background loop. Deliberately unhurried — the officer is never waiting on
 * this, and aggressive polling on a weak connection just drains the battery.
 */
export function startSyncLoop(
  getLocationId: () => string | null,
  onResult: (outcome: SyncOutcome) => void,
  intervalMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    void runSync(getLocationId()).then(onResult).catch(() => {});
  }, intervalMs);

  return () => clearInterval(timer);
}
