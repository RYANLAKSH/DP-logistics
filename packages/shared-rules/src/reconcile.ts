/**
 * The reconciliation engine.
 *
 * This module is the reason the monorepo exists: it runs unchanged on the
 * device (offline, advisory) and on the server (authoritative). Two
 * implementations would drift, and the day they drift is the day an offline
 * PASS stops agreeing with the audit record.
 *
 * Rules are evaluated in a fixed order and the first hit wins. That ordering is
 * part of the contract — see the table in docs/reconciliation-rules.md.
 */

import { normalizeContainerNo, normalizeVin, levenshtein } from './normalize.ts';
import type { PickupReportLine, ReconInput, ReconResult } from './types.ts';

const DEFAULT_FUZZY_THRESHOLD = 0.85;

/** Longest common suffix length. Door jamb labels are sometimes partly obscured. */
function suffixMatchLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

interface VinMatch {
  line: PickupReportLine;
  confidence: number;
}

/**
 * Finds the report line for a VIN, tolerating imperfect reads.
 *
 * Returns null when the best candidates are tied — an ambiguous fuzzy match
 * must never be auto-resolved. Guessing between two real vehicles is worse
 * than asking the officer to retype 17 characters.
 */
function findVinLine(vin: string, lines: PickupReportLine[], threshold: number): VinMatch | null {
  const exact = lines.find((line) => line.vin === vin);
  if (exact) return { line: exact, confidence: 1 };

  const scored: VinMatch[] = [];

  for (const line of lines) {
    // Prefer edit distance when it is decisive: a single-character misread on a
    // 17-character VIN is the overwhelmingly common OCR failure, and scores
    // above the default threshold so it can be accepted with confirmation.
    const distance = levenshtein(vin, line.vin, 3);
    if (distance === 1) {
      scored.push({ line, confidence: 0.9 });
      continue;
    }

    // A long shared suffix covers the other common case: the label's leading
    // characters lost to glare or a door seal.
    const suffix = suffixMatchLength(vin, line.vin);
    if (suffix >= 12 && vin.length === line.vin.length) {
      scored.push({ line, confidence: 0.85 });
      continue;
    }

    // Two characters off is plausible but weak. Below the default threshold —
    // available only when a caller deliberately lowers it.
    if (distance === 2) scored.push({ line, confidence: 0.7 });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.confidence - a.confidence);
  const best = scored[0]!;
  if (best.confidence < threshold) return null;

  // Ambiguous: two lines fit equally well. Force manual entry.
  if (scored.length > 1 && scored[1]!.confidence === best.confidence) return null;

  return best;
}

function progressFor(
  containerNo: string,
  lines: PickupReportLine[],
  loaded: Set<string>,
  justLoaded?: string,
) {
  const forContainer = lines.filter((line) => line.containerNo === containerNo);
  const done = new Set(loaded);
  if (justLoaded) done.add(justLoaded);

  const remainingVins = forContainer.filter((line) => !done.has(line.vin)).map((line) => line.vin);

  return {
    loaded: forContainer.length - remainingVins.length,
    expected: forContainer.length,
    remainingVins,
  };
}

function describe(line: PickupReportLine): string {
  const parts = [line.make, line.model, line.variant, line.colour].filter(Boolean);
  return parts.length ? parts.join(' ') : 'vehicle';
}

/**
 * Evaluates one container/VIN pairing.
 *
 * Pure and synchronous by design — no I/O, no clock reads beyond `now`. That is
 * what makes it testable exhaustively and safe to run inside a camera frame
 * callback.
 */
export function reconcile(input: ReconInput): ReconResult {
  const containerNo = normalizeContainerNo(input.containerNo);
  const vin = normalizeVin(input.vin);
  const now = input.now ?? new Date();
  const threshold = input.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const loaded = new Set(input.loadedVins ?? []);
  const lines = input.lines;

  // 0. Incomplete pair.
  if (!containerNo || !vin) {
    return {
      outcome: 'PENDING',
      reasonCode: 'AWAITING_SCAN',
      severity: 'warn',
      matchConfidence: 0,
      message: !containerNo ? 'Scan the container number' : 'Scan the vehicle VIN',
    };
  }

  // 1. Expired report. Checked first: an expired report makes every other
  //    verdict below it meaningless.
  if (input.reportValidTo && now > input.reportValidTo) {
    return {
      outcome: 'EXPIRED_REPORT',
      reasonCode: 'REPORT_EXPIRED',
      severity: 'block',
      matchConfidence: 0,
      message: 'Pickup report has expired',
      detail: `Validity ended ${input.reportValidTo.toISOString().slice(0, 10)}. Contact operations for a current report.`,
    };
  }

  // 2. VIN already loaded. A vehicle cannot be in two containers.
  if (loaded.has(vin)) {
    return {
      outcome: 'DUPLICATE_VIN',
      reasonCode: 'VIN_ALREADY_LOADED',
      severity: 'block',
      matchConfidence: 1,
      message: 'This vehicle is already loaded',
      detail: `VIN ${vin} has already been reconciled into a container. Verify you are not scanning the same vehicle twice.`,
    };
  }

  const containerLines = lines.filter((line) => line.containerNo === containerNo);

  // 3. Container unknown to the report.
  if (containerLines.length === 0) {
    return {
      outcome: 'CONTAINER_NOT_IN_REPORT',
      reasonCode: 'CONTAINER_UNKNOWN',
      severity: 'block',
      matchConfidence: 0,
      message: 'Container not on the pickup report',
      detail: `${containerNo} does not appear on the active report. Do not load. Confirm the container number with operations.`,
    };
  }

  // 4/5. Does the VIN belong to this container?
  const inContainer = findVinLine(vin, containerLines, threshold);
  if (inContainer) {
    const progress = progressFor(containerNo, lines, loaded, inContainer.line.vin);
    const fuzzy = inContainer.confidence < 1;

    return {
      outcome: 'MATCH',
      reasonCode: fuzzy ? 'FUZZY_VIN' : 'EXACT',
      severity: 'pass',
      matchConfidence: inContainer.confidence,
      matchedLine: inContainer.line,
      progress,
      message: `Load into ${containerNo}`,
      detail:
        `${describe(inContainer.line)} — position ${inContainer.line.loadPosition ?? '?'}. ` +
        `${progress.loaded} of ${progress.expected} loaded.` +
        (fuzzy ? ' VIN matched with correction — confirm the label before loading.' : ''),
    };
  }

  // 5. The case this system exists to catch: right vehicle, wrong container.
  const elsewhere = findVinLine(vin, lines, threshold);
  if (elsewhere) {
    return {
      outcome: 'WRONG_CONTAINER',
      reasonCode: 'WRONG_VEHICLE',
      severity: 'block',
      matchConfidence: elsewhere.confidence,
      expectedLine: elsewhere.line,
      progress: progressFor(containerNo, lines, loaded),
      message: 'DO NOT LOAD — wrong container',
      detail:
        `${describe(elsewhere.line)} (VIN ${vin}) is assigned to container ` +
        `${elsewhere.line.containerNo}, not ${containerNo}. Supervisor has been notified.`,
    };
  }

  // 6. Container is already at its expected complement, and this VIN is not on
  //    the report at all. Reported separately because the operational fix
  //    differs: over-capacity means a loading error, unknown VIN means a data
  //    or vehicle-identity problem.
  const progress = progressFor(containerNo, lines, loaded);
  if (progress.remainingVins.length === 0) {
    return {
      outcome: 'CONTAINER_FULL',
      reasonCode: 'OVER_CAPACITY',
      severity: 'block',
      matchConfidence: 0,
      progress,
      message: 'Container is already complete',
      detail: `All ${progress.expected} vehicles for ${containerNo} are loaded. This vehicle does not belong here.`,
    };
  }

  // 7. VIN appears nowhere on the report.
  return {
    outcome: 'VIN_NOT_IN_REPORT',
    reasonCode: 'VEHICLE_UNKNOWN',
    severity: 'block',
    matchConfidence: 0,
    progress,
    message: 'Vehicle not on the pickup report',
    detail:
      `VIN ${vin} does not appear on the active report. Do not load. ` +
      `${containerNo} still expects: ${progress.remainingVins.join(', ')}.`,
  };
}

/** Convenience for the admin board: is every vehicle for this container aboard? */
export function isContainerComplete(
  containerNo: string,
  lines: PickupReportLine[],
  loadedVins: Iterable<string>,
): boolean {
  const normalized = normalizeContainerNo(containerNo);
  const loaded = new Set(loadedVins);
  const forContainer = lines.filter((line) => line.containerNo === normalized);
  return forContainer.length > 0 && forContainer.every((line) => loaded.has(line.vin));
}
