/**
 * Simulates a loading shift against the generated pickup report.
 *
 * Runs the same reconcile() the phone and the server run, and walks through
 * every outcome the officer can hit — including the wrong-container case the
 * system exists to catch.
 *
 * Run: npm run demo -w @dp/fixtures
 */

import { reconcile, isContainerComplete, type PickupReportLine } from '@dp/shared-rules';
import { generateReport, assertFixtureIntegrity } from './generate.ts';

const report = generateReport({ containers: 4, vehiclesPerContainer: 4 });
assertFixtureIntegrity(report);

const lines: PickupReportLine[] = report.lines.map((line) => ({
  id: `line-${line.lineNo}`,
  reportId: report.referenceNo,
  lineNo: line.lineNo,
  containerNo: line.containerNo,
  vin: line.vin,
  make: line.make,
  model: line.model,
  variant: line.variant,
  colour: line.colour,
  loadPosition: line.loadPosition,
  bookingRef: line.bookingRef,
  destinationPort: line.destinationPort,
}));

const NOW = new Date('2026-08-16T09:00:00Z');
const validTo = new Date(`${report.validTo}T23:59:59Z`);
const loadedVins = new Set<string>();

const containers = [...new Set(lines.map((line) => line.containerNo))];
const [containerA, containerB] = containers;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function scan(label: string, containerNo: string, vin: string) {
  const result = reconcile({
    containerNo,
    vin,
    lines,
    loadedVins,
    reportValidTo: validTo,
    now: NOW,
  });

  const colour =
    result.severity === 'pass' ? GREEN : result.severity === 'block' ? RED : YELLOW;
  const badge = result.severity === 'pass' ? ' PASS ' : result.severity === 'block' ? ' FAIL ' : ' WAIT ';

  console.log(`${DIM}${label}${RESET}`);
  console.log(`  ${DIM}container${RESET} ${containerNo}   ${DIM}vin${RESET} ${vin}`);
  console.log(`  ${colour}${BOLD}${badge}${RESET} ${colour}${result.message}${RESET}`);
  console.log(`  ${DIM}${result.outcome} · ${result.reasonCode} · confidence ${result.matchConfidence.toFixed(2)}${RESET}`);
  if (result.detail) console.log(`  ${DIM}${result.detail}${RESET}`);
  console.log();

  if (result.outcome === 'MATCH') loadedVins.add(result.matchedLine!.vin);
  return result;
}

console.log(`\n${BOLD}Pickup report ${report.referenceNo}${RESET}`);
console.log(`${DIM}${report.deliveryOrder} · ${report.loadPortName} · valid ${report.validFrom} to ${report.validTo}`);
console.log(`${containers.length} containers · ${lines.length} vehicles${RESET}\n`);
console.log('─'.repeat(76) + '\n');

/* 1 — the happy path: load container A correctly, vehicle by vehicle. */
console.log(`${BOLD}1. Loading ${containerA} as booked${RESET}\n`);
for (const line of lines.filter((l) => l.containerNo === containerA)) {
  scan(`scan · ${line.make} ${line.model} ${line.colour}`, containerA, line.vin);
}
console.log(
  `  ${GREEN}Container complete: ${isContainerComplete(containerA!, lines, loadedVins)}${RESET}\n`,
);
console.log('─'.repeat(76) + '\n');

/* 2 — the failure the system exists to catch. */
console.log(`${BOLD}2. Wrong vehicle presented at ${containerB}${RESET}\n`);
const strayVin = lines.find((l) => l.containerNo === containers[2])!.vin;
scan('scan · vehicle booked for another container', containerB!, strayVin);

console.log('─'.repeat(76) + '\n');

/* 3 — OCR damage the engine can recover from, and damage it cannot. */
console.log(`${BOLD}3. Imperfect scans${RESET}\n`);
const targetB = lines.find((l) => l.containerNo === containerB)!;

// I and O are illegal in a VIN, so these substitutions are unambiguous.
const misreadVin = targetB.vin.replace(/1/g, 'I').replace(/0/g, 'O');
scan('scan · door label OCR read 1 as I and 0 as O', containerB!, misreadVin);

// A single genuine character error — recoverable, but flagged for confirmation.
const target2 = lines.filter((l) => l.containerNo === containerB)[1]!;
const oneOff = target2.vin.slice(0, 15) + (target2.vin[15] === '7' ? '9' : '7') + target2.vin[16];
scan('scan · one character misread on a dirty label', containerB!, oneOff);

console.log('─'.repeat(76) + '\n');

/* 4 — the remaining block conditions. */
console.log(`${BOLD}4. Exception handling${RESET}\n`);
scan('scan · same vehicle presented twice', containerA!, lines[0]!.vin);

// Use a vehicle that has NOT been loaded yet — otherwise the duplicate rule
// fires first and this case never reaches the container check.
const untouchedVin = lines.find((l) => l.containerNo === containers[3])!.vin;
scan('scan · container not on the report', 'MSKU1000016', untouchedVin);

scan('scan · vehicle not on the report', containerB!, 'MA3ERLF1S00999999');

console.log('─'.repeat(76) + '\n');

/* 5 — an expired report blocks everything, regardless of the pairing. */
console.log(`${BOLD}5. Report expiry${RESET}\n`);
const expired = reconcile({
  containerNo: containerA!,
  vin: lines[1]!.vin,
  lines,
  reportValidTo: validTo,
  now: new Date('2026-08-25T09:00:00Z'),
});
console.log(`  ${RED}${BOLD} FAIL ${RESET} ${RED}${expired.message}${RESET}`);
console.log(`  ${DIM}${expired.outcome} · ${expired.detail}${RESET}\n`);

console.log('─'.repeat(76));
console.log(`\n${BOLD}Shift summary${RESET}`);
console.log(`  vehicles loaded : ${loadedVins.size} of ${lines.length}`);
for (const containerNo of containers) {
  const complete = isContainerComplete(containerNo, lines, loadedVins);
  const forContainer = lines.filter((l) => l.containerNo === containerNo);
  const done = forContainer.filter((l) => loadedVins.has(l.vin)).length;
  const mark = complete ? `${GREEN}complete${RESET}` : `${YELLOW}${done}/${forContainer.length}${RESET}`;
  console.log(`  ${containerNo}   ${mark}`);
}
console.log();
