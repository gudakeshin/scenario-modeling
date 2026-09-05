# SAP Analytics Cloud — Data Export Service Contract

Pinned references used by the SAC connector (`backend/src/connectors/sac/`).
No live tenant was available during implementation; behavior is locked by
recorded OData fixtures under `backend/src/tests/fixtures/sac/`.

## Official sources (Help Portal / KBAs)

| Topic | Reference |
|-------|-----------|
| Data Export Service overview | SAP Analytics Cloud REST API Developer Guide — Data Export Service |
| Administration API | `GET /api/v1/dataexport/administration/Namespaces(NamespaceID='sac')/Providers` |
| Provider / FactData | `GET /api/v1/dataexport/providers/sac/{ProviderID}/FactData` |
| Metadata | `GET .../providers/sac/{ProviderID}/$metadata` |
| Master data | `{Dim}Master`, `{Dim}MasterWithHierarchy` |
| Pagination | Follow `@odata.nextLink` verbatim; never invent `$skiptoken` |
| Default page size | KBA 3685484 (~1000); large pages may truncate without nextLink |
| Parent member filters | KBA 3345648 — filter on leaf/base members only |
| Account signage (stored) | INC/LEQ → −1; EXP/AST → +1 |

## Connection `base_url`

Tenant root, e.g. `https://{tenant}.sapanalytics.cloud`.
Optional `auth_public.des_base_path` (default `/api/v1/dataexport`).
Optional `auth_public.namespace_id` (default `sac`).

## Live-tenant certification

Contract compatibility is proven via fixtures and unit tests.
Live-tenant certification (token fetch, `$metadata` parse, FactData paging
against a real SAC tenant) remains pending tenant access.
