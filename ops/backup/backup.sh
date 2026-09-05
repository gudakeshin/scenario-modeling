#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PREFIX="${BACKUP_PREFIX:-scenario-modeling/postgres}"
FILE="/tmp/scenario_modeling_${STAMP}.dump"
KEY="${PREFIX}/scenario_modeling_${STAMP}.dump"
ENDPOINT_ARGS=()
[[ -n "${OBJECT_STORAGE_ENDPOINT:-}" ]] && ENDPOINT_ARGS+=(--endpoint-url "$OBJECT_STORAGE_ENDPOINT")

trap 'rm -f "$FILE"' EXIT
pg_dump "$DATABASE_URL" --format=custom --compress=9 --file="$FILE"

SSE_ARGS=(--sse AES256)
if [[ -n "${BACKUP_KMS_KEY_ID:-}" ]]; then
  SSE_ARGS=(--sse aws:kms --sse-kms-key-id "$BACKUP_KMS_KEY_ID")
fi
aws "${ENDPOINT_ARGS[@]}" s3 cp "$FILE" "s3://${BACKUP_BUCKET}/${KEY}" "${SSE_ARGS[@]}"

# Keep 30 days by default. Provider-side lifecycle policy remains recommended.
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
CUTOFF_EPOCH="$(( $(date +%s) - RETENTION_DAYS * 86400 ))"
CUTOFF="$(date -u -d "@${CUTOFF_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)"
mapfile -t EXPIRED < <(
  aws "${ENDPOINT_ARGS[@]}" s3api list-objects-v2 \
    --bucket "$BACKUP_BUCKET" --prefix "$PREFIX/" \
    --query "Contents[?LastModified<=\`${CUTOFF}\`].Key" --output text |
    tr '\t' '\n'
)
for expired_key in "${EXPIRED[@]}"; do
  [[ -z "$expired_key" || "$expired_key" == "None" ]] && continue
  aws "${ENDPOINT_ARGS[@]}" s3 rm "s3://${BACKUP_BUCKET}/${expired_key}"
done

echo "backup_complete bucket=${BACKUP_BUCKET} key=${KEY}"
