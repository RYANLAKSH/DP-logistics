/**
 * Evidence image upload queue.
 *
 * Runs behind the session queue and on its own schedule. The ordering is the
 * design: session metadata carries the verdict and triggers the email, so it
 * goes first and never waits on bytes. Images follow whenever there is enough
 * connection to move them.
 *
 * Consequence worth being explicit about: between a scan and a successful image
 * upload there is a window where a reconciliation exists with no picture behind
 * it. That window is visible — the officer sees a pending count, and the admin
 * dashboard reports evidence coverage — because a silently missing image is the
 * failure that only shows up months later in a dispute.
 */

import {
  getPendingImages,
  attachUploadUrl,
  markImageVerified,
  markImageAttemptFailed,
  invalidateUploadUrl,
  imageQueueStats,
  type QueuedImage,
} from './store.ts';
import { refreshUploadUrl, finalizeImage, uploadImageBytes } from './api.ts';
import { discardLocalImage } from './images.ts';

export interface ImageSyncOutcome {
  uploaded: number;
  failed: number;
  pending: number;
  permanentlyFailed: number;
  offline: boolean;
}

/** Treat a URL as dead slightly early, so we never race its expiry mid-upload. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

const isUsable = (image: QueuedImage): boolean => {
  if (!image.uploadUrl) return false;
  if (!image.urlExpiresAt) return true;
  return new Date(image.urlExpiresAt).getTime() - EXPIRY_MARGIN_MS > Date.now();
};

let running = false;

export async function drainImageQueue(): Promise<ImageSyncOutcome> {
  const outcome: ImageSyncOutcome = {
    uploaded: 0, failed: 0, pending: 0, permanentlyFailed: 0, offline: false,
  };

  if (running) {
    const stats = await imageQueueStats();
    return { ...outcome, pending: stats.pending, permanentlyFailed: stats.failed };
  }
  running = true;

  try {
    for (const image of await getPendingImages()) {
      // Stop pushing at a dead network rather than burning the retry budget of
      // every remaining image on the same failure.
      if (outcome.offline) break;

      let upload = isUsable(image)
        ? { url: image.uploadUrl!, method: 'PUT' as const,
            headers: { 'content-type': image.contentType },
            expiresAt: image.urlExpiresAt ?? '' }
        : null;

      if (!upload) {
        const refreshed = await refreshUploadUrl(image.scanId);
        if (!refreshed.ok) {
          if (refreshed.offline) { outcome.offline = true; break; }

          // 409 ALREADY_VERIFIED means the server has it and we simply lost the
          // acknowledgement — that is success, not a failure to retry.
          if (refreshed.code === 'ALREADY_VERIFIED') {
            await markImageVerified(image.scanId);
            await discardLocalImage(image.localUri);
            outcome.uploaded++;
            continue;
          }
          await markImageAttemptFailed(image.scanId, refreshed.message);
          outcome.failed++;
          continue;
        }
        upload = refreshed.data.upload;
        await attachUploadUrl(image.scanId, upload);
      }

      const put = await uploadImageBytes(upload, image.localUri);
      if (!put.ok) {
        if (put.offline) { outcome.offline = true; break; }

        // A rejected capability means the URL died; get a new one next pass
        // rather than replaying a dead one.
        if (put.status === 403) await invalidateUploadUrl(image.scanId);

        await markImageAttemptFailed(image.scanId, put.message);
        outcome.failed++;
        continue;
      }

      const finalized = await finalizeImage(image.scanId);
      if (!finalized.ok) {
        if (finalized.offline) { outcome.offline = true; break; }

        // HASH_MISMATCH after a clean PUT means the bytes were corrupted in
        // transit; re-uploading is the right response. Retries are bounded, so
        // a genuinely broken local file eventually lands in 'failed' for a
        // human to look at rather than looping forever.
        await markImageAttemptFailed(image.scanId, finalized.code ?? finalized.message);
        outcome.failed++;
        continue;
      }

      await markImageVerified(image.scanId);
      // Only now is the local copy safe to delete — the server has confirmed a
      // byte-identical copy.
      await discardLocalImage(image.localUri);
      outcome.uploaded++;
    }

    const stats = await imageQueueStats();
    outcome.pending = stats.pending;
    outcome.permanentlyFailed = stats.failed;
    return outcome;
  } finally {
    running = false;
  }
}
