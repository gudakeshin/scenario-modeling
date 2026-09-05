# ADR 0001: Local JWT authentication

## Status

Accepted

## Context

The product needed authenticated multi-user access with roles (viewer → admin) without standing up an IdP for the first production-ready cut. Legacy header-based identity (`x-user-id`) and self-service role switching were unsafe for anything beyond a demo.

## Decision

Use a **local auth provider**: email/password (argon2), JWT access tokens, refresh tokens in Postgres, and server-enforced RBAC. `AUTH_PROVIDER=local` is the only supported value today; OIDC can be added behind the same provider interface later.

## Consequences

- Clients must register/login and send `Authorization: Bearer …`.
- Role changes are admin-controlled, not a UI toggle.
- Operators must set a strong `JWT_SECRET` and plan rotation (see `SECURITY.md`).
