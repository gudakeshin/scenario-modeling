#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"

PREFIX="${BACKUP_PREFIX:-scenario-modeling/postgres}"
ENDPOINT_ARGS=()
[[ -n "${OBJECT_STORAGE_ENDPOINT:-}" ]] && ENDPOINT_ARGS+=(--endpoint-url "$OBJECT_STORAGE_ENDPOINT")
KEY="${1:-}"
if [[ -z "$KEY" ]]; then
  KEY="$(aws "${ENDPOINT_ARGS[@]}" s3api list-objects-v2 \
    --bucket "$BACKUP_BUCKET" --prefix "$PREFIX/" \
    --query 'reverse(sort_by(Contents,&LastModified))[0].Key' --output text)"
fi
[[ -z "$KEY" || "$KEY" == "None" ]] && { echo "No backup found" >&2; exit 1; }

FILE="/tmp/restore-verify.dump"
DB="scenario_restore_verify_$(date +%s)"
ADMIN_URL="${DATABASE_URL%/*}/postgres"
VERIFY_URL="${DATABASE_URL%/*}/${DB}"
cleanup() {
  dropdb --if-exists --force --dbname="$ADMIN_URL" "$DB" >/dev/null 2>&1 || true
  rm -f "$FILE"
}
trap cleanup EXIT

aws "${ENDPOINT_ARGS[@]}" s3 cp "s3://${BACKUP_BUCKET}/${KEY}" "$FILE"
createdb --maintenance-db="$ADMIN_URL" "$DB"
pg_restore --dbname="$VERIFY_URL" --no-owner --no-privileges "$FILE"
psql "$VERIFY_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'users' AS table_name, count(*) FROM users
UNION ALL SELECT 'workspaces', count(*) FROM workspaces
UNION ALL SELECT 'documents', count(*) FROM documents
UNION ALL SELECT 'scenarios', count(*) FROM scenarios
UNION ALL SELECT 'run_manifests', count(*) FROM run_manifests;
SELECT count(*) AS broken_document_workspaces
FROM documents d LEFT JOIN workspaces w ON w.workspace_id = d.workspace_id
WHERE w.workspace_id IS NULL;
SQL

echo "restore_verification_complete key=${KEY}"
