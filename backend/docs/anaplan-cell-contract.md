# Anaplan — Cell Data API Contract

Pinned contract for the read-only connector in `backend/src/connectors/anaplan/`.
No live tenant was available during implementation; response compatibility is
locked by the fixtures under `backend/src/tests/fixtures/anaplan/`.

## Authentication

- Username/password: `POST https://auth.anaplan.com/token/authenticate` with
  HTTP Basic credentials.
- API calls use `Authorization: AnaplanAuthToken {tokenValue}`.
- Tokens last about 35 minutes. The client proactively calls
  `POST https://auth.anaplan.com/token/refresh` when fewer than five minutes
  remain, then falls back to a full authentication exchange if refresh fails.
- A single 401 causes one forced re-authentication. 429 and transient 5xx
  responses use bounded exponential or `Retry-After` backoff.
- A pre-issued `AnaplanAuthToken` can be supplied with `api_key` auth for
  short-lived/manual use.

## Connection and discovery endpoints

Discovery uses the configured workspace. Transactional metadata and cell-data
endpoints are under:

`{base_url}/models/{modelId}`

The default `base_url` is `https://api.anaplan.com/2/0`.

| Purpose | Endpoint |
|---|---|
| Current user | `GET /users/me` |
| Validate workspace | `GET /workspaces/{workspaceId}` |
| Models | `GET /workspaces/{workspaceId}/models` |
| Modules | `GET .../models/{modelId}/modules` |
| Line-item details | `GET .../modules/{moduleId}/lineItems?includeAll=true` |
| View dimension metadata | `GET .../views/{moduleId}` |
| List items | `GET .../lists/{listId}/items?includeAll=true` |
| Time/version items | `GET .../views/{moduleId}/dimensions/{dimensionId}/items` |

An importable model is one module, represented externally as
`{modelId}::{moduleId}`. This keeps one imported definition dimensionally
consistent even when an Anaplan model contains unrelated modules.

## Large-volume view reads

The connector reads the module default view (`viewId = moduleId`) without
requiring a pre-created export action:

1. `POST .../views/{viewId}/readRequests` with
   `{"exportType":"TABULAR_SINGLE_COLUMN"}`.
2. Poll `GET .../readRequests/{requestId}` until `requestState=COMPLETE`.
3. Download each advertised page from
   `GET .../readRequests/{requestId}/pages/{pageNumber}` with
   `Accept: text/csv`.
4. Always `DELETE .../readRequests/{requestId}` in cleanup.

Each CSV page has dimension columns, a `Line Items` column, and a `Value`
column. The connector resolves source names/IDs against metadata and emits
member keys in deterministic order: Time, Versions, then lists sorted by ID.
Unresolved and non-numeric cells are skipped. Non-leaf tuples are collected as
`source_aggregates`; leaf tuples become streamed facts.

Filtering by time, version, measure, and other dimension selections is applied
before a page is yielded. The remote API still downloads the full default view.

## Limits

- `ANAPLAN_MAX_MODULES_PER_MODEL` (default 100)
- `ANAPLAN_HTTP_MAX_RETRIES` (default 4)
- `ANAPLAN_READ_POLL_INTERVAL_MS` (default 1500)
- `ANAPLAN_READ_POLL_TIMEOUT_MS` (default 600000)
- The shared `EXTERNAL_MODEL_MAX_CELLS` cap applies after connector filtering.

## Live smoke checklist

1. Test username/password and workspace validation.
2. Confirm model/module composite entries appear in the browser.
3. Import a small module and compare leaf cells with its default grid.
4. Confirm source aggregate cross-foot warnings are near zero.
5. Refresh the import and verify read-request cleanup.
6. Confirm an oversized selection fails cleanly at the shared cell cap.
