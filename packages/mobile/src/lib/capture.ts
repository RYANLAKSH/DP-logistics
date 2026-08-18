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
  enqueueImage,
} from './store.ts';
import { prepareEvidenceImage, type PreparedImage } from './images.ts';

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
  /** How many of the two images were captured and queued for upload. */
  imagesQueued: number;
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

  /**
   * Compress and hash before declaring.
   *
   * A failure here must not lose the reconciliation — the verdict is the thing
   * that stops a wrong car being loaded, and it is already computed. So a
   * broken image degrades to a scan with no evidence, which is visible in the
   * coverage metric, rather than a lost verdict.
   */
  const prepare = async (capture: CaptureResult): Promise<PreparedImage | null> => {
    if (!capture.imageUri) return null;
    try {
      return await prepareEvidenceImage(capture.imageUri);
    } catch {
      return null;
    }
  };

  const [containerImage, vinImage] = await Promise.all([
    prepare(args.container),
    prepare(args.vin),
  ]);

  const scanFor = (
    capture: CaptureResult,
    scanType: 'container' | 'vin',
    image: PreparedImage | null,
  ) => ({
    id: uuid(),
    scanType,
    finalValue: capture.value,
    detectedValue: capture.ocr?.value ?? undefined,
    ocrRawText: capture.ocr?.rawText || undefined,
    ocrConfidence: capture.ocr?.confidence,
    ocrEngine: capture.ocr ? 'mlkit-v2' : undefined,
    wasManualEntry: capture.wasManualEntry,
    checkDigitOk: capture.checkDigitOk ?? undefined,
    // Declare WHAT will be uploaded. The server derives the destination and
    // later checks the bytes that arrive against this hash.
    imageSha256: image?.sha256,
    imageContentType: image?.contentType,
    imageBytes: image?.bytes,
    gpsLat: position.lat,
    gpsLng: position.lng,
    gpsAccuracyM: position.accuracy,
    capturedAt: now,
  });

  const containerScan = scanFor(args.container, 'container', containerImage);
  const vinScan = scanFor(args.vin, 'vin', vinImage);

  for (const [scan, image] of [
    [containerScan, containerImage],
    [vinScan, vinImage],
  ] as const) {
    if (!image) continue;
    await enqueueImage({
      scanId: scan.id,
      sessionId,
      localUri: image.uri,
      sha256: image.sha256,
      bytes: image.bytes,
      contentType: image.contentType,
    });
  }

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
      scans: [containerScan, vinScan],
    },
  });

  // Record the local MATCH immediately so a second scan of the same vehicle is
  // caught before the queue has drained.
  if (result.outcome === 'MATCH' && result.matchedLine) {
    await markLoadedLocally(result.matchedLine.vin);
  }

  return {
    result,
    sessionId,
    hadReport: Boolean(report),
    imagesQueued: [containerImage, vinImage].filter(Boolean).length,
  };
}
