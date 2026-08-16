/**
 * Writes the dummy pickup report to disk in the formats the ingest pipeline
 * has to accept.
 *
 * Run: npm run seed
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateReport, toCsv, assertFixtureIntegrity } from './generate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data');
mkdirSync(outDir, { recursive: true });

const report = generateReport({ containers: 6, vehiclesPerContainer: 4 });
assertFixtureIntegrity(report);

writeFileSync(join(outDir, 'pickup-report.csv'), toCsv(report));
writeFileSync(join(outDir, 'pickup-report.json'), JSON.stringify(report, null, 2) + '\n');

/**
 * A second report seeded differently, used to exercise the amendment path:
 * same reference, version 2, with one vehicle reassigned to another container.
 */
const amended = generateReport({ seed: 20260817, containers: 6, vehiclesPerContainer: 4 });
amended.referenceNo = report.referenceNo;
amended.version = 2;
writeFileSync(join(outDir, 'pickup-report-v2.json'), JSON.stringify(amended, null, 2) + '\n');

const containers = new Set(report.lines.map((line) => line.containerNo));
console.log(`Wrote ${report.lines.length} vehicles across ${containers.size} containers`);
console.log(`  ${join(outDir, 'pickup-report.csv')}`);
console.log(`  ${join(outDir, 'pickup-report.json')}`);
console.log(`  ${join(outDir, 'pickup-report-v2.json')}  (amendment fixture)`);
