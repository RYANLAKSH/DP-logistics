#!/usr/bin/env bash
#
# Wraps `npm run backup -w @dp/api` and, if it succeeds, syncs BACKUP_DIR to
# an off-server destination. Intended to run once a day under cron or a
# systemd timer — see docs/deployment.md, "Backup scheduling."
#
# A template, not a live configuration — nothing here runs unless something
# on the actual host schedules it. Loads real paths/credentials from an
# environment file that lives OUTSIDE this repository and is never committed.
#
# Fails loudly and non-zero on every failure mode it can detect: the backup
# command itself failing (missing database, disk full, incomplete backup —
# npm run backup already exits non-zero for these, see lib/backup.ts), a
# missing required variable, or the off-server sync failing (auth failure,
# network failure, remote out of space all surface as rsync/rclone's own
# non-zero exit). Cron's default behavior is to email the invoking user
# stderr/stdout from a failed job — that is the alerting mechanism here,
# deliberately: this is a pilot, not a monitoring platform.

set -euo pipefail

ENV_FILE="${DP_BACKUP_ENV_FILE:-/etc/dp-logistics/backup.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
else
  echo "[backup] WARNING: $ENV_FILE not found — relying on the calling environment only." >&2
fi

: "${DB_PATH:?DB_PATH must be set (see $ENV_FILE) - must match the running API DB_PATH}"
: "${STORAGE_DIR:?STORAGE_DIR must be set (see $ENV_FILE) - must match the running API STORAGE_DIR}"
: "${BACKUP_DIR:?BACKUP_DIR must be set (see $ENV_FILE)}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[backup] starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if ! DB_PATH="$DB_PATH" STORAGE_DIR="$STORAGE_DIR" BACKUP_DIR="$BACKUP_DIR" npm run backup -w @dp/api; then
  echo "[backup] FAILED — npm run backup exited non-zero (see output above for which check failed:" \
       "missing database, or an incomplete backup with specific missing/mismatched evidence keys)." >&2
  exit 1
fi
echo "[backup] local backup created in $BACKUP_DIR"

if [ -n "${OFFSITE_DESTINATION:-}" ]; then
  echo "[backup] syncing $BACKUP_DIR to $OFFSITE_DESTINATION"
  if command -v rclone >/dev/null 2>&1; then
    SYNC_CMD=(rclone sync "$BACKUP_DIR" "$OFFSITE_DESTINATION" --config "${RCLONE_CONFIG:-/etc/dp-logistics/rclone.conf}")
  else
    # rsync over SSH — the alternative when the destination is a second
    # server rather than S3-compatible object storage. See docs/deployment.md.
    SYNC_CMD=(rsync -az --delete "$BACKUP_DIR"/ "$OFFSITE_DESTINATION"/)
  fi

  if ! "${SYNC_CMD[@]}"; then
    echo "[backup] FAILED — off-server sync did not complete. A local backup exists;" \
         "the off-server copy is now stale until this succeeds." >&2
    exit 1
  fi
  echo "[backup] off-server sync complete"
else
  echo "[backup] WARNING: OFFSITE_DESTINATION is not set — this backup exists only on this server." \
       "See docs/deployment.md, \"Off-server backups\" — this must be configured before pilot go-live." >&2
fi

echo "[backup] done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
