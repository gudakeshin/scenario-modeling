# Incident Response Runbook

This is a blameless runbook: the goal during an incident is to restore
service and understand what happened, not to assign fault. Anyone following
this runbook should feel free to escalate, ask for help, or say "I don't
know" without it being held against them.

## Alerting mechanism (Sentry-only)

This deployment uses **Sentry** as the sole alerting surface — there is no
Prometheus/Alertmanager stack in this repo. `/metrics` exists (Prometheus
text format) but is token-gated (`METRICS_TOKEN`) for manual/debugging scrape
access only; it is not wired to any alert-firing pipeline.

Error-rate spike alerts, new-issue alerts, and regression alerts must be
configured **in the Sentry project's own settings (Alerts tab)** — this is a
dashboard configuration step in Sentry, not something enforced or defined in
this repository. There is no code in this repo that creates or manages
Sentry alert rules. At minimum, configure in Sentry:

- An alert rule for error-count/error-rate spikes on the backend project
  (e.g. "N events in M minutes" threshold).
- An alert rule for any new issue type (first seen) above a severity
  threshold.
- Notification routing from those alert rules to wherever your team actually
  watches (email / Slack integration configured inside Sentry) — this repo
  does not integrate a paging SaaS (no PagerDuty/Opsgenie wiring exists
  today).

### Where errors are reported from

- **Backend**: `backend/src/errorReporter.ts` — `captureException` /
  `captureMessage` log via pino always, and additionally forward to Sentry
  (`@sentry/node`) when `SENTRY_DSN` is set. Wired into global crash handlers
  in `backend/src/server.ts` (`uncaughtException`, `unhandledRejection`) so
  process-level crashes are reported before shutdown.
- **Frontend**: also reports to Sentry. `frontend/src/instrumentation-client.ts`
  initializes `@sentry/nextjs` using `NEXT_PUBLIC_SENTRY_DSN` (falls back to
  `SENTRY_DSN`), and `frontend/src/lib/errorReporter.ts` provides the same
  `captureException` / `captureMessage` helpers for application code, active
  whenever `NEXT_PUBLIC_SENTRY_DSN` is set.
- Both reporters scrub `authorization`/`cookie` headers (and, on the
  frontend, user email/IP) before sending events — check Sentry's "Issues"
  view per-project (backend project vs. frontend project, if configured as
  separate Sentry projects) when triaging.

## Severity levels

| Severity | Definition | Examples | Response expectation |
|---|---|---|---|
| **SEV1** | Full outage or data-integrity risk. Users cannot use the app, or data may be corrupted/lost. | API down, database unreachable, auth broken for all users, active data corruption. | Immediate response, all-hands until mitigated. |
| **SEV2** | Major functionality broken for a significant subset of users, no data loss. | Scenario creation failing, document upload broken, a core API route 500ing for many requests. | Respond within the on-call window; mitigate same day. |
| **SEV3** | Degraded but workable — a non-critical feature broken, elevated but non-critical error rate, performance degradation. | A secondary report broken, slow queries, non-blocking UI bug. | Fix in the next normal work cycle. |
| **SEV4** | Cosmetic or low-impact issue, or a near-miss caught before user impact. | Minor UI glitch, log noise, an alert that fired but self-resolved. | Backlog. |

## Who gets paged

**On-call rotation / paging tool is not yet set up in this deployment** (no
PagerDuty/Opsgenie integration exists in the repo or infra). Until one is
configured, use this placeholder process:

- SEV1/SEV2: page/contact whoever owns on-call by your team's current manual
  process (e.g. direct Slack/phone to the engineer(s) listed in
  `<TEAM ON-CALL CONTACT — FILL IN>`).
- SEV3/SEV4: file as a normal ticket, no immediate paging.

> TODO (tracked separately from this runbook): stand up a real on-call
> rotation tool and wire Sentry alert notifications to it. Until then, Sentry
> alert rules should notify via email/Slack to the team channel, not a paging
> service.

## Immediate triage steps

1. **Confirm the incident** — check Sentry (Issues tab, both backend and
   frontend projects if split) for a spike in error volume or a new
   high-frequency issue. Cross-check `/ready` and `/health` (or whichever
   liveness/readiness endpoints `backend/src/server.ts` exposes) if the
   service seems fully down.
2. **Classify severity** using the table above.
3. **Check recent deploys** — `git log` on the deployed branch and the
   running container's image tag/digest. Most incidents immediately
   following a deploy are deploy-caused; check first before deep debugging.
4. **Check dependencies** — is Postgres reachable (`docker compose ps`,
   `docker compose logs postgres`)? Is Redis reachable (if `REDIS_URL` is
   configured)? Is the Anthropic API (or other external LLM/connector calls)
   erroring — check Sentry breadcrumbs/tags for the failing outbound call.

## Immediate mitigation

Because this is a docker-compose deployment (no Kubernetes/ECS), rollback is
manual:

### Rollback via git tag / previous image

```bash
# 1. Identify the last known-good commit/tag
git log --oneline -10

# 2. Check out (or build from) that commit on the deploy host
git checkout <last-good-tag-or-sha>

# 3. Rebuild and restart the affected service(s)
docker compose build backend frontend
docker compose up -d backend frontend

# 4. Confirm health
docker compose ps
curl -f http://localhost:4000/ready
```

If you tag releases (recommended even if not currently enforced), rollback
is simply checking out the previous release tag and repeating the build/up
steps above.

### If the incident is data-related (not code-related)

Do **not** attempt an in-place data fix under pressure. Stop writes (stop the
`backend` service), assess using a read-only `psql` session, and if a restore
is needed, follow `docs/runbooks/backup-restore.md`. Restoring into a scratch
database first to confirm scope of the problem is strongly preferred over
restoring directly into production.

### Quick service restart (when a code rollback isn't needed)

```bash
docker compose restart backend
# or, if a full recreate is needed:
docker compose up -d --force-recreate backend
```

## Communication during an incident

- Post a running timeline in your team's incident channel: what was observed,
  when, what was tried, what the current status is. Timestamps matter more
  than prose during an active incident.
- State severity and current user impact plainly, and update it as it
  changes (including "this is now mitigated" — don't let a channel go silent
  once things are fixed, since that's when the postmortem timeline gets
  fuzzy).

## Resolution

- Confirm the mitigation actually resolved the issue: error rate back to
  baseline in Sentry, health checks passing, spot-check the affected user
  flow manually.
- Close out the incident channel/thread with a clear "resolved at <time>,
  root cause believed to be <X>, full postmortem to follow."

## Postmortem template

Use this for any SEV1/SEV2 incident (SEV3/SEV4 optional, at the team's
discretion). Blameless: describe what happened and why the system allowed it
to happen, not who made a mistake.

```markdown
# Postmortem: <short title>

- **Date**: <date>
- **Severity**: SEV<N>
- **Duration**: <start time> – <end time> (<total duration>)
- **Author(s)**: <names>
- **Status**: Draft / Reviewed / Final

## Summary
<2-3 sentences: what broke, what was the user impact, how was it resolved.>

## Impact
- Who/what was affected (users, features, data)
- Quantify if possible (error rate, request volume, duration of outage)

## Timeline (all times UTC)
- HH:MM — <event, e.g. "deploy of commit abc123">
- HH:MM — <event, e.g. "Sentry alert fired: error rate spike">
- HH:MM — <event, e.g. "on-call engineer began investigating">
- HH:MM — <event, e.g. "rollback initiated">
- HH:MM — <event, e.g. "confirmed mitigated">

## Root cause
<What actually caused this, at a systems level. Avoid "someone forgot to..."
— ask why the system made that easy to get wrong.>

## Detection
<How was this detected — Sentry alert, user report, manual observation?
How long between the issue starting and detection? Could detection have
been faster?>

## Mitigation / Resolution
<What was actually done to stop user impact and to fully resolve it.>

## What went well
<Things that worked — fast detection, clean rollback, good communication,
etc.>

## What went poorly / contributing factors
<Gaps that made this worse or harder to resolve — missing alerting, unclear
runbook, no rollback plan ready, etc.>

## Action items
| Action | Owner | Priority | Status |
|---|---|---|---|
| <e.g. add Sentry alert rule for X> | | | |
| <e.g. add test coverage for Y> | | | |
| <e.g. document Z in a runbook> | | | |

## Lessons learned
<Anything broader than the specific action items — patterns worth watching
for in future changes.>
```
