/**
 * Shared vocabulary. These types cross the device/server boundary, so treat
 * them as a wire contract: additive changes only, no field repurposing.
 */

/**
 * One vehicle's assignment, as issued by the DO.
 *
 * The report is keyed by VIN, not by container: a 40ft container carries four
 * to six cars, so many lines share a containerNo.
 */
export interface PickupReportLine {
  id: string;
  reportId: string;
  lineNo: number;

  /** Normalized, ISO 6346 validated at ingest. */
  containerNo: string;
  /** Normalized, 17 characters. */
  vin: string;

  /** Position within the container (1 = nose). Advisory; not enforced. */
  loadPosition?: number;

  make?: string;
  model?: string;
  variant?: string;
  colour?: string;

  bookingRef?: string;
  destinationPort?: string;
}

export type ReconOutcome =
  /** VIN is assigned to the scanned container. Load it. */
  | 'MATCH'
  /** VIN is on the report but belongs in a different container. The core failure. */
  | 'WRONG_CONTAINER'
  /** Container is on the report, this VIN is not. */
  | 'VIN_NOT_IN_REPORT'
  /** Scanned container appears nowhere on the active report. */
  | 'CONTAINER_NOT_IN_REPORT'
  /** This VIN already has an active MATCH — it cannot be loaded twice. */
  | 'DUPLICATE_VIN'
  /** Container already holds its full expected complement. */
  | 'CONTAINER_FULL'
  /** Report validity window has passed. */
  | 'EXPIRED_REPORT'
  /** Awaiting the second scan of the pair. */
  | 'PENDING';

export type ReasonCode =
  | 'EXACT'
  | 'FUZZY_VIN'
  | 'REPORT_EXPIRED'
  | 'VIN_ALREADY_LOADED'
  | 'VEHICLE_UNKNOWN'
  | 'CONTAINER_UNKNOWN'
  | 'WRONG_VEHICLE'
  | 'OVER_CAPACITY'
  | 'AWAITING_SCAN';

export type Severity = 'pass' | 'block' | 'warn';

export interface ReconResult {
  outcome: ReconOutcome;
  reasonCode: ReasonCode;
  severity: Severity;

  /** Confidence in the VIN match itself: 1.0 exact, lower when fuzzy. */
  matchConfidence: number;

  /** The line this scan satisfied, when outcome is MATCH. */
  matchedLine?: PickupReportLine;
  /** Where the vehicle actually belongs, when outcome is WRONG_CONTAINER. */
  expectedLine?: PickupReportLine;

  /** Loading progress for the scanned container. */
  progress?: {
    loaded: number;
    expected: number;
    remainingVins: string[];
  };

  /** Officer-facing message. Written to be read on a phone, in a yard, quickly. */
  message: string;
  /** Supporting detail for the verdict screen. */
  detail?: string;
}

export interface ReconInput {
  /** Raw or normalized — reconcile() normalizes defensively. */
  containerNo: string;
  vin: string;

  /** Active report lines for this location and date window. */
  lines: PickupReportLine[];

  /** VINs that already carry an active MATCH, from cache or server. */
  loadedVins?: Iterable<string>;

  /** Report validity end. Omit to skip the expiry check. */
  reportValidTo?: Date;
  now?: Date;

  /**
   * Accept a fuzzy VIN match at or above this confidence. The officer must
   * still confirm explicitly — this only controls what gets proposed.
   */
  fuzzyThreshold?: number;
}
