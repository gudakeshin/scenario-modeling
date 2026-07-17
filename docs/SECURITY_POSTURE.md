# Security and Data Protection Posture

This document describes implemented controls and deployment requirements. It is
not a certification claim. SOC 2 certification remains a roadmap item and must
not be represented as complete without an independent audit.

## Data classification and UPSI

- Workspaces are classified as `public`, `confidential`, or `upsi`.
- UPSI workspaces require explicit need-to-know membership. Application admins
  have no bypass.
- Reads of UPSI artifacts are appended to an immutable, hash-chained Structured
  Digital Database (SDD) containing the accessor, artifact, nature of UPSI, and
  timestamp. Admins who are explicit members can export the SDD on demand.
- Trading-window status is an awareness banner only. This application does not
  implement employee trading pre-clearance or exchange-compliance workflows.

## Encryption and key management

- New document originals are encrypted with AES-256-GCM before PostgreSQL or
  object-storage persistence when `CREDENTIALS_ENCRYPTION_KEY` is configured.
- Each document uses a distinct HKDF-derived key and authenticated document ID.
- Enterprise deployments require the encryption key. Rotate it through a
  controlled migration; replacing it without re-encryption makes stored
  documents unreadable.
- Database and worker volumes must also use provider-managed volume encryption.
- S3-compatible storage must enforce SSE-KMS, TLS, blocked public access,
  versioning, and least-privilege bucket policies. Application encryption is an
  additional layer, not a replacement.

## Residency and retention

- Indian listed-entity deployments should use an India region such as AWS
  `ap-south-1` for application, database, backups, logs, and object storage.
- Cross-region replication must be approved against contractual and regulatory
  requirements before enablement.
- Production backups are retained for 30 days by default. Legal, tax, SEBI PIT,
  and litigation-hold requirements may require longer retention.

## DPDP Act operational mapping

- Correction and access requests are handled through authenticated account and
  workspace administration.
- Erasure uses document/workspace deletion endpoints, subject to statutory
  retention, immutable audit/SDD records, and legal holds.
- Purpose limitation and data minimisation are deployment-owner obligations;
  avoid uploading personal data not needed for financial modelling.
- Suspected breaches follow `docs/runbooks/incident.md`: contain access, retain
  evidence, assess affected data principals, and execute required notifications
  through counsel and the organisation's incident-response process.

## Deployment requirements

Production operators must provide OIDC, Redis, encrypted managed PostgreSQL with
PITR, private object storage, ClamAV, TLS termination, Sentry/alerting, secrets
management, vulnerability gates, and tested backup restoration. See
`docs/runbooks/backup-restore.md`.
