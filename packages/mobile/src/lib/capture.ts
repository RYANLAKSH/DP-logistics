/**
 * Ties a container capture and a VIN capture into a reconciliation.
 *
 * The verdict is computed HERE, on the device, against the cached report — so
 * the officer sees PASS/FAIL with no network at all. The same session is then
 * queued for the server, which recomputes it authoritatively and sends the
 * email. The device result is advisory; it exists so the officer is not
 * waiting on a signal that may not come.
 */

import * as Location from 'expo-location';
import { reconcile, type ReconResult } from '@dp/shared-rules';

import type { CaptureResult } from '../screens/ScanScreen.tsx';
import {
  getCachedLines, getCachedReport, getLoadedVins, markLoadedLocally, enqueueSession,
} from './store.ts';

/** RFC 4122 v4 without pulling in a dependency. */
function uuid(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function currentPosition(): Promise<{ lat?: number; lng?: number; accuracy?: number }> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return {};

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy ?? undefined,
    };
  } catch {
    // Location is evidence, not a gate. Never block a scan on it.
    return {};
  }
}

export interface CommitOutcome {
  result: ReconResult;
  sessionId: string;
  /** False when there was no cached report to judge against. */
  hadReport: boolean;
}

export async function commitCapture(args: {
  locationId: string;
  appVersion: string;
  container: CaptureResult;
  vin: CaptureResult;
}): Promise<CommitOutcome> {
  const [lines, report, loadedVins, position] = await Promise.all([
    getCachedLines(),
    getCachedReport(),
    getLoadedVins(),
    currentPosition(),
  ]);

  const result = reconcile({
    containerNo: args.container.value,
    vin: args.vin.value,
    lines,
    loadedVins,
    reportValidTo: report ? new Date(`${report.validTo}T23:59:59.999Z`) : undefined,
  });

  const sessionId = uuid();
  const now = new Date().toISOString();

  const scanFor = (capture: CaptureResult, scanType: 'container' | 'vin') => ({
    id: uuid(),
    scanType,
    finalValue: capture.value,
    detectedValue: capture.ocr?.value ?? undefined,
    ocrRawText: capture.ocr?.rawText || undefined,
    ocrConfidence: capture.ocr?.confidence,
    ocrEngine: capture.ocr ? 'mlkit-v2' : undefined,
    wasManualEntry: capture.wasManualEntry,
    checkDigitOk: capture.checkDigitOk ?? undefined,
    // The image itself uploads separately via a presigned URL; the record
    // carries the local reference until that completes.
    imageKey: capture.imageUri ?? undefined,
    gpsLat: position.lat,
    gpsLng: position.lng,
    gpsAccuracyM: position.accuracy,
    capturedAt: now,
  });

  await enqueueSession({
    id: sessionId,
    locationId: args.locationId,
    startedAt: now,
    deviceOutcome: result.outcome,
    payload: {
      id: sessionId,
      locationId: args.locationId,
      startedAt: now,
      appVersion: args.appVersion,
      deviceOutcome: result.outcome,
      scans: [scanFor(args.container, 'container'), scanFor(args.vin, 'vin')],
    },
  });

  // Record the local MATCH immediately so a second scan of the same vehicle is
  // caught before the queue has drained.
  if (result.outcome === 'MATCH' && result.matchedLine) {
    await markLoadedLocally(result.matchedLine.vin);
  }

  return { result, sessionId, hadReport: Boolean(report) };
}
