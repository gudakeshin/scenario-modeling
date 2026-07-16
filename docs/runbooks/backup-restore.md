# Backup & Restore Runbook

Scope: this deployment runs Postgres 16 and Redis via `docker-compose.yml` (no
managed-DB / cloud platform decision has been made yet, so there is no native
point-in-time-recovery service to rely on). Backups here are `pg_dump`-based
logical backups plus, where applicable, a copy of workbook bytes held outside
Postgres. This runbook reflects what actually exists in the repo today — see
"Storage reality check" below.

## Storage reality check (read this first)

- **Primary data store**: Postgres 16 (`postgres:16-alpine`), single service
  named `postgres` in `docker-compose.yml`, with a named volume `pgdata`
  mounted at `/var/lib/postgresql/data`. All application state — scenarios,
  models, facts, documents metadata, auth — lives here.
- **Workbook / document bytes**: stored **in Postgres by default** (`BYTEA`
  column on the documents table). Object storage is optional: when
  `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`,
  `OBJECT_STORAGE_ACCESS_KEY`, and `OBJECT_STORAGE_SECRET_KEY` are all set
  (see `backend/.env.example` and `backend/src/services/objectStorage.ts`),
  the backend dual-writes new uploads to S3-compatible object storage and
  keeps the Postgres `BYTEA` copy as a fallback (`documentService.ts`,
  `loadDocumentBytes` reads S3 first, then falls back to `BYTEA`). There is
  **no dedicated S3 bucket provisioned by this repo** — if you configure
  object storage, back up that bucket separately (S3 versioning / cross-region
  replication on the bucket itself is the simplest approach and is out of
  scope for this runbook, which focuses on what docker-compose owns).
- **Redis**: used for session/context cache (`REDIS_URL`, optional). It is
  ephemeral/rebuildable — session state, not source of truth. Not covered by
  this backup procedure; a Redis outage does not lose data, only forces
  re-login/re-fetch.
- **Practical implication**: if you never configured `OBJECT_STORAGE_*`, a
  `pg_dump` of the `scenario_modeling` database is a complete backup of the
  system. If you did configure object storage, you additionally need to back
  up the bucket (see "Object storage backup" below).

## 1. Postgres backup procedure (pg_dump)

The compose Postgres service exposes the DB as `scenario_modeling`, reachable
from the host on port `5433` (mapped from container `5432`) or from within the
compose network as `postgres:5432`.

### One-off manual backup (custom format, compressed, recommended)

Run from the host, via `docker compose exec` so credentials never leave the
container network:

```bash
# From the repo root, with docker-compose stack running
docker compose exec -T postgres pg_dump \
  -U postgres \
  -d scenario_modeling \
  -Fc \
  -f /tmp/scenario_modeling_$(date +%Y%m%dT%H%M%S).dump

# Copy the dump out of the container to the host backup directory
docker compose cp postgres:/tmp/scenario_modeling_<timestamp>.dump \
  ./backups/scenario_modeling_<timestamp>.dump

# Clean up the in-container temp file
docker compose exec -T postgres rm /tmp/scenario_modeling_<timestamp>.dump
```

Alternative, single command that streams the dump straight to the host
without an intermediate container file (simpler, preferred for automation):

```bash
mkdir -p ./backups
docker compose exec -T postgres pg_dump \
  -U postgres -d scenario_modeling -Fc \
  > "./backups/scenario_modeling_$(date +%Y%m%dT%H%M%S).dump"
```

`-Fc` (custom format) is used because it is compressed, supports parallel
restore, and allows selective table/schema restore — plain SQL dumps are
harder to work with at any real data volume.

### Restore procedure (into the running database)

```bash
# Stop application traffic first (scale backend to 0, or take a maintenance
# window) so nothing writes while you restore.
docker compose stop backend

# Restore, dropping and recreating objects as needed (-c = clean before
# restore, --if-exists avoids errors on a fresh DB)
cat ./backups/scenario_modeling_<timestamp>.dump | docker compose exec -T postgres \
  pg_restore -U postgres -d scenario_modeling -c --if-exists

docker compose start backend
```

If restoring into a **brand-new** empty database (e.g. disaster recovery onto
a fresh volume), drop `-c --if-exists` and instead create the database first:

```bash
docker compose exec -T postgres createdb -U postgres scenario_modeling
cat ./backups/scenario_modeling_<timestamp>.dump | docker compose exec -T postgres \
  pg_restore -U postgres -d scenario_modeling
```

## 2. Scheduling backups

There is no backup automation in this repo yet. Use either a cron job or a
systemd timer on the host running docker-compose. Both examples call a small
wrapper script — create `./scripts/backup-postgres.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p ./backups
STAMP=$(date +%Y%m%dT%H%M%S)
docker compose exec -T postgres pg_dump -U postgres -d scenario_modeling -Fc \
  > "./backups/scenario_modeling_${STAMP}.dump"
# Retention: keep the last 14 daily backups (see retention guidance below)
find ./backups -name 'scenario_modeling_*.dump' -mtime +14 -delete
```

```bash
chmod +x ./scripts/backup-postgres.sh
```

### Cron example (daily at 02:15)

```cron
15 2 * * * /path/to/repo/scripts/backup-postgres.sh >> /var/log/scenario-modeling-backup.log 2>&1
```

### systemd timer example

`/etc/systemd/system/scenario-modeling-backup.service`:

```ini
[Unit]
Description=Scenario Modeling Postgres backup

[Service]
Type=oneshot
WorkingDirectory=/path/to/repo
ExecStart=/path/to/repo/scripts/backup-postgres.sh
User=deploy
```

`/etc/systemd/system/scenario-modeling-backup.timer`:

```ini
[Unit]
Description=Daily Scenario Modeling Postgres backup

[Timer]
OnCalendar=*-*-* 02:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now scenario-modeling-backup.timer
```

Ship backups off the host after they land — rsync/rclone to a separate
machine or a cloud bucket. A backup that lives only on the same disk as the
database it backs up does not protect against host/disk failure.

## 3. Retention guidance

- Daily backups, retained **14 days** locally (see the `find -mtime +14
  -delete` in the script above) — adjust to your recovery-point requirements.
- Keep at least **4 weekly** snapshots and **3 monthly** snapshots off-host
  (e.g. in object storage) for longer-horizon recovery and audit purposes.
  A simple approach: copy the Sunday daily backup into a `weekly/` prefix and
  the 1st-of-month backup into a `monthly/` prefix in your off-host target,
  with their own independent retention.
- Store backups encrypted at rest if the off-host target does not already
  encrypt (most object storage does by default).

## 4. Object storage backup (only if OBJECT_STORAGE_* is configured)

If you have set `OBJECT_STORAGE_ENDPOINT` / `OBJECT_STORAGE_BUCKET` /
`OBJECT_STORAGE_ACCESS_KEY` / `OBJECT_STORAGE_SECRET_KEY` (see
`backend/.env.example`), workbook originals are dual-written to that bucket.
Back it up using your object storage provider's native replication/versioning
(e.g. S3 bucket versioning + cross-region replication, or an `aws s3 sync` /
`rclone sync` cron job to a second bucket). This repo does not provision or
manage that bucket — provisioning and its backup policy are an infrastructure
decision outside docker-compose.

If object storage was never configured, there is nothing extra to back up:
all workbook bytes are already inside the `scenario_modeling` Postgres
database and covered by the `pg_dump` above.

## 5. Restore-drill checklist

A backup is not valid until it has been proven to restore. Run this drill
periodically (e.g. monthly) and after any schema migration:

1. **Spin up a scratch Postgres** — do not restore into anything that could
   be mistaken for production:
   ```bash
   docker run --rm -d --name pg-restore-drill \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=restore_drill \
     -p 5544:5432 postgres:16-alpine
   # wait for it to become healthy
   until docker exec pg-restore-drill pg_isready -U postgres; do sleep 1; done
   ```
2. **Restore the latest backup into it**:
   ```bash
   cat ./backups/scenario_modeling_<latest>.dump | docker exec -i pg-restore-drill \
     pg_restore -U postgres -d restore_drill
   ```
3. **Verify row counts on key tables** (adjust table names to match the
   current schema — check `backend/src` migrations for the authoritative
   list; at minimum verify `users`, `scenarios`, `documents`, and whichever
   table holds facts/driver data):
   ```bash
   docker exec pg-restore-drill psql -U postgres -d restore_drill -c \
     "SELECT 'users', count(*) FROM users
      UNION ALL SELECT 'scenarios', count(*) FROM scenarios
      UNION ALL SELECT 'documents', count(*) FROM documents;"
   ```
   Compare counts against what you expect from production (a rough sanity
   check — an empty or drastically smaller table indicates a bad dump).
4. **Run a smoke query** that exercises a join/foreign-key path relevant to
   the app (a scenario joined to its creator, per the `creator_id` FK defined
   in `backend/src/db/schema.sql`) to confirm referential integrity survived
   the dump/restore:
   ```bash
   docker exec pg-restore-drill psql -U postgres -d restore_drill -c \
     "SELECT s.scenario_id, s.name, u.email
      FROM scenarios s JOIN users u ON u.user_id = s.creator_id
      LIMIT 5;"
   ```
   (Re-verify table/column names against `backend/src/db/schema.sql` at drill
   time in case the schema has evolved.)
5. **Tear down the scratch container**:
   ```bash
   docker stop pg-restore-drill
   ```
6. **Record the result** (date, backup file used, row counts, pass/fail) in
   your team's incident/ops log. A restore drill that silently fails to run
   is as bad as no drill at all — treat a failed or skipped drill as an
   action item, not a footnote.

Only once a backup has passed this drill should it be considered a valid
recovery point.
