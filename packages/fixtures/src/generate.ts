/**
 * Deterministic fixture generator for a car-export pickup report.
 *
 * Every container number carries a computed ISO 6346 check digit and every VIN
 * a computed ISO 3779 check digit, so the fixtures exercise the real validation
 * paths rather than sliding past them. Deterministic by design — a seeded PRNG,
 * no Date.now() — so test expectations stay stable.
 */

import {
  completeContainerNo,
  withValidVinCheckDigit,
  isValidContainerNo,
  isValidVin,
} from '@dp/shared-rules';

/* ------------------------------------------------------------------ *
 * Deterministic PRNG (mulberry32)
 * ------------------------------------------------------------------ */

function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!;

/* ------------------------------------------------------------------ *
 * Reference data
 * ------------------------------------------------------------------ */

/** Container owner prefixes actually issued to major lines. */
const OWNER_CODES = ['MSKU', 'TGHU', 'HLXU', 'CMAU', 'OOLU', 'SEGU', 'TRHU', 'FCIU'] as const;

/**
 * World Manufacturer Identifiers for Indian passenger-vehicle plants, which is
 * where the export volume in this scenario originates.
 */
const MODELS = [
  { wmi: 'MA3', make: 'Maruti Suzuki', model: 'Swift',   variant: 'ZXI Plus' },
  { wmi: 'MA3', make: 'Maruti Suzuki', model: 'Baleno',  variant: 'Alpha' },
  { wmi: 'MA3', make: 'Maruti Suzuki', model: 'Dzire',   variant: 'VXI' },
  { wmi: 'MAL', make: 'Hyundai',       model: 'Creta',   variant: 'SX(O)' },
  { wmi: 'MAL', make: 'Hyundai',       model: 'i20',     variant: 'Asta' },
  { wmi: 'MAT', make: 'Tata Motors',   model: 'Nexon',   variant: 'Fearless' },
  { wmi: 'MAT', make: 'Tata Motors',   model: 'Punch',   variant: 'Creative' },
  { wmi: 'MA1', make: 'Mahindra',      model: 'XUV 3XO', variant: 'AX7L' },
] as const;

const COLOURS = [
  'Pearl Arctic White',
  'Midnight Black',
  'Nexa Blue',
  'Magma Grey',
  'Fire Red',
  'Silky Silver',
] as const;

const PORTS = [
  { code: 'INMUN', name: 'Mundra' },
  { code: 'INNSA', name: 'Nhava Sheva' },
  { code: 'INCCU', name: 'Kolkata' },
] as const;

const DESTINATIONS = [
  { code: 'ZADUR', name: 'Durban' },
  { code: 'CLVAP', name: 'Valparaiso' },
  { code: 'MXVER', name: 'Veracruz' },
  { code: 'IDJKT', name: 'Jakarta' },
] as const;

/** VIN character alphabet — I, O and Q are excluded by ISO 3779. */
const VIN_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface FixtureLine {
  lineNo: number;
  containerNo: string;
  vin: string;
  make: string;
  model: string;
  variant: string;
  colour: string;
  loadPosition: number;
  bookingRef: string;
  destinationPort: string;
}

export interface FixtureReport {
  referenceNo: string;
  version: number;
  deliveryOrder: string;
  loadPort: string;
  loadPortName: string;
  validFrom: string;
  validTo: string;
  lines: FixtureLine[];
}

export interface GenerateOptions {
  seed?: number;
  /** Number of containers on the report. */
  containers?: number;
  /** Vehicles per container — a 40ft with racking takes four to six. */
  vehiclesPerContainer?: number;
  validFrom?: string;
  validTo?: string;
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

function makeContainerNo(rng: () => number, used: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const owner = pick(rng, OWNER_CODES);
    const serial = String(Math.floor(rng() * 1_000_000)).padStart(6, '0');
    const full = completeContainerNo(owner + serial);
    if (full && !used.has(full)) {
      used.add(full);
      return full;
    }
  }
  throw new Error('exhausted container number space');
}

function makeVin(
  rng: () => number,
  wmi: string,
  used: Set<string>,
): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    // Positions 4-8 describe the vehicle, 9 is the check digit, 10 the model
    // year, 11 the plant, 12-17 the serial.
    let vds = '';
    for (let i = 0; i < 5; i++) vds += pick(rng, VIN_ALPHABET.split(''));

    const modelYear = 'S'; // 2025 under the ISO year code cycle
    const plant = pick(rng, ['A', 'B', 'C', 'G', 'M']);
    const serial = String(Math.floor(rng() * 1_000_000)).padStart(6, '0');

    const provisional = `${wmi}${vds}0${modelYear}${plant}${serial}`;
    const vin = withValidVinCheckDigit(provisional);
    if (vin && !used.has(vin)) {
      used.add(vin);
      return vin;
    }
  }
  throw new Error('exhausted VIN space');
}

export function generateReport(options: GenerateOptions = {}): FixtureReport {
  const {
    seed = 20260816,
    containers = 6,
    vehiclesPerContainer = 4,
    validFrom = '2026-08-14',
    validTo = '2026-08-20',
  } = options;

  const rng = makeRng(seed);
  const usedContainers = new Set<string>();
  const usedVins = new Set<string>();
  const port = pick(rng, PORTS);

  const lines: FixtureLine[] = [];
  let lineNo = 0;

  for (let c = 0; c < containers; c++) {
    const containerNo = makeContainerNo(rng, usedContainers);
    const destination = pick(rng, DESTINATIONS);
    const bookingRef = `BK${String(240000 + Math.floor(rng() * 9999)).padStart(6, '0')}`;

    for (let v = 0; v < vehiclesPerContainer; v++) {
      const spec = pick(rng, MODELS);
      lines.push({
        lineNo: ++lineNo,
        containerNo,
        vin: makeVin(rng, spec.wmi, usedVins),
        make: spec.make,
        model: spec.model,
        variant: spec.variant,
        colour: pick(rng, COLOURS),
        loadPosition: v + 1,
        bookingRef,
        destinationPort: destination.code,
      });
    }
  }

  return {
    referenceNo: `PUR/${validFrom.replace(/-/g, '')}/${port.code}/001`,
    version: 1,
    deliveryOrder: 'DO-2026-08-4471',
    loadPort: port.code,
    loadPortName: port.name,
    validFrom,
    validTo,
    lines,
  };
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

const CSV_COLUMNS = [
  ['lineNo', 'Sr No'],
  ['containerNo', 'Container No'],
  ['vin', 'Chassis No'],
  ['make', 'Make'],
  ['model', 'Model'],
  ['variant', 'Variant'],
  ['colour', 'Colour'],
  ['loadPosition', 'Position'],
  ['bookingRef', 'Booking Ref'],
  ['destinationPort', 'Destination'],
] as const;

/**
 * Renders the report the way a DO actually sends it: header preamble, then the
 * table. The ingest pipeline has to cope with the preamble, which is exactly
 * why the fixture includes one.
 */
export function toCsv(report: FixtureReport): string {
  const rows: string[] = [
    `Pickup Report,${report.referenceNo}`,
    `Delivery Order,${report.deliveryOrder}`,
    `Load Port,${report.loadPortName} (${report.loadPort})`,
    `Valid From,${report.validFrom},Valid To,${report.validTo}`,
    '',
    CSV_COLUMNS.map(([, header]) => header).join(','),
  ];

  for (const line of report.lines) {
    rows.push(
      CSV_COLUMNS.map(([key]) => {
        const value = String(line[key as keyof FixtureLine] ?? '');
        return value.includes(',') ? `"${value}"` : value;
      }).join(','),
    );
  }

  return rows.join('\n') + '\n';
}

/** Self-check: every generated identifier must satisfy its own check digit. */
export function assertFixtureIntegrity(report: FixtureReport): void {
  for (const line of report.lines) {
    if (!isValidContainerNo(line.containerNo)) {
      throw new Error(`fixture container ${line.containerNo} fails ISO 6346`);
    }
    if (!isValidVin(line.vin)) {
      throw new Error(`fixture VIN ${line.vin} fails ISO 3779`);
    }
  }
}
