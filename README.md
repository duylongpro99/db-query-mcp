# pg-connection-pool — Query Gateway

A lightweight **query-execution gateway** (Fastify + `pg` + `zod` + `pino`). It owns
one pooled `pg.Pool` per logical datasource and runs queries on a caller's behalf under
guardrails. Callers know only a **logical datasource name** + SQL — never a connection,
credentials, host, or engine type. A parallel **MCP adapter** exposes the same
capability to agents.

> Design note (authoritative): `../docs/design-notes/pg-connection-pool-query-gateway.md`

## Why

External consumers (application services and debugging agents) need *real
data* from Postgres to reproduce scenarios, without managing credentials or connection
lifecycle. A live socket can't cross an HTTP/MCP boundary, so the server **owns** the
pool and exposes a guarded QUERY capability instead of a connection.

## Core invariants

- **Server owns the pool**, exposes a QUERY capability — never a raw connection.
- **One `pg.Pool` per datasource**, shared across tenants. Tenant isolation is per-query:
  every query runs inside a transaction with `SET LOCAL search_path TO "<schema>", pg_temp`,
  which auto-resets on COMMIT/ROLLBACK so a pooled connection can't leak one tenant's
  `search_path` to the next borrower. **This is a P0 correctness invariant.**
- **Connections are returned pristine**: `SET LOCAL` only auto-resets the settings *we*
  issue — a caller's own plain `SET` survives COMMIT on that pooled connection. Every
  query therefore ends with `DISCARD ALL`, which also drops temp tables and prepared
  statements. Without it, `SET statement_timeout = 0` in one request silently disabled
  the timeout guardrail for every later borrower of that connection.
- **One statement per request, enforced by the wire protocol.** All SQL runs through the
  extended protocol (`queryMode:'extended'`), under which *the server* rejects
  multi-statement text. This is structural; the text scanner is only a fast 400.
- **Read-only by default**, enforced at the engine (`BEGIN TRANSACTION READ ONLY`) — no
  fragile SQL keyword blocklist. Writes are opt-in (see below).
- **Layered timeouts**: `connectionTimeoutMillis` (acquire), `statement_timeout` (query),
  `idle_in_transaction_session_timeout` (stalled txn).
- `acquire → use → release-in-finally`; a mandatory `pool.on('error')` handler on every
  pool; graceful shutdown drains pools; fail-fast boot (one `SELECT 1` per datasource).

## Configuration (`.env`)

See `.env.example`. Logical datasource names decouple callers from real endpoints:

```
DATASOURCES=main
DS_MAIN_HOST=localhost
DS_MAIN_USER=postgres
DS_MAIN_PASSWORD=postgres
DS_MAIN_DATABASE=appdb
DS_MAIN_DEFAULT_SCHEMA=public
DS_MAIN_STATEMENT_TIMEOUT_MS=10000

TOKENS=agent_ro,svc_rw
TOKEN_AGENT_RO_SECRET=...   TOKEN_AGENT_RO_DATASOURCES=main  TOKEN_AGENT_RO_MODE=read   TOKEN_AGENT_RO_SCHEMAS=*
TOKEN_SVC_RW_SECRET=...     TOKEN_SVC_RW_DATASOURCES=main    TOKEN_SVC_RW_MODE=write    TOKEN_SVC_RW_SCHEMAS=public
```

- **Fallback:** if NO `DS_*` datasource is configured, a single `main` is seeded from
  the canonical `DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME/SSL`.
- **Hard caps:** `MAX_ROWS_CEILING` (default `10000`) is the absolute row cap; a request's
  `maxRows` is clamped to it. A request's `timeoutMs` is clamped to the datasource's
  `STATEMENT_TIMEOUT_MS`.
- **Binding:** `HOST` defaults to `127.0.0.1`. Only loopback binds without
  `ALLOW_PUBLIC_BIND=true` — see [Network binding](#network-binding).
- **DB role:** point each datasource at a **read-only Postgres role**; that, not the
  token mode, is the real write barrier. See [The read-only guarantee](#the-read-only-guarantee-lives-in-the-database).

## HTTP API

| Method + path            | Auth | Purpose |
|--------------------------|------|---------|
| `GET  /health`           | no   | `{ status, datasources:[{name, ok, poolSize}] }` (503 if degraded) |
| `GET  /datasources`      | yes  | datasources this token may use |
| `POST /query`            | yes  | run one statement |
| `POST /introspect/schemas`  | yes | schemas visible to the token |
| `POST /introspect/tables`   | yes | `{ datasource, schema }` → tables + views |
| `POST /introspect/describe` | yes | `{ datasource, schema, table }` → columns |

Auth is `Authorization: Bearer <secret>`. `POST /query` body:

```jsonc
{ "datasource": "main", "schema": "<account-uuid>", "sql": "SELECT ...",
  "params": [1, "x"], "readOnly": true, "maxRows": 1000, "timeoutMs": 10000 }
```

Response: `{ columns:[{name,dataType}], rows:[...], rowCount, truncated, elapsedMs, rowsAffected? }`.

### Writes (opt-in)

A write requires **both** a write-mode token **and** an explicit `"readOnly": false`. A
read-only token with `readOnly:false` is rejected (403) before any DB contact. Write
queries add `write:true`, `command`, and `rowsAffected` to the audit line.

## MCP adapter

Exposes `run_query`, `list_schemas`, `list_tables`, `describe_table` over MCP — thin
wrappers over the SAME services, so all guardrails/auth/audit apply identically.

- Identity is process-level: set `MCP_TOKEN=<a configured secret>`; the process runs with
  that token's capabilities.
- `npm run start:mcp` — stdio (default; for a local agent client).
- `npm run start:mcp:http` — streamable HTTP (`MCP_TRANSPORT=http`), binds loopback by
  default (`MCP_HTTP_HOST`/`MCP_HTTP_PORT`). Never expose publicly — trusted infra utility.
- `npm run inspect` — MCP inspector against the built server.

## Scripts

```
npm run dev         # tsx watch (HTTP server)
npm run build       # tsc → dist/
npm start           # node dist/server.js  (HTTP)
npm run start:mcp   # MCP over stdio
npm run typecheck
npm test            # node --test via tsx
```

## Local Postgres (`docker-compose.yml`)

A PostgreSQL 18 container for local development:

```
docker compose up -d          # start
docker compose logs -f pg     # watch
docker compose down           # stop (data survives in the pgcp-pgdata volume)
docker compose down -v        # stop AND delete the data
```

Credentials are **not duplicated**. Compose auto-loads `.env` from this directory, so
`DS_MAIN_USER` / `_PASSWORD` / `_DATABASE` become the container's `POSTGRES_*` and the
compose file itself holds no secrets. A missing value is a startup error, not a
password-less superuser. Only `POSTGRES_*` are passed in — the bearer secrets and
`MCP_TOKEN` are deliberately withheld from the DB container.

The host port mirrors `DS_MAIN_PORT`, so **pointing the gateway at this container is a
one-line change**: set `DS_MAIN_HOST=localhost`.

Two deliberate choices worth knowing:

- **Published on `127.0.0.1` only.** A bare `"5432:5432"` publishes on every interface —
  the same footgun [Network binding](#network-binding) refuses for the gateway itself.
- **`PGDATA` is set explicitly** (to a subdirectory of the mount) rather than inherited
  from the image, whose default has moved between major versions.

### It is an empty database

A fresh container has none of the dev data, so two things do not work out of the box:

- `DS_MAIN_DEFAULT_SCHEMA` is a tenant UUID schema that will not exist. The boot ping
  (`SELECT 1`) passes, but any query resolving that `search_path` fails until you create
  the schema or repoint the var (e.g. `public`).
- The read-only role `agent_ro_pg` does not exist. Creating it is a **user action** (see
  [The read-only guarantee](#the-read-only-guarantee-lives-in-the-database)) — run that SQL
  against the container as the superuser above, then set `DS_MAIN_USER=agent_ro_pg`.
  Until then the boot log will correctly report `read-only posture WEAK`, because the
  superuser this container creates can write everything.

## Testing

- **Unit + E2E route tests** run with no database (a stub `QueryDriver` drives the full
  HTTP/MCP path). `npm test`.
- **Integration tests** (`test/integration/*`) hit a **real** Postgres and are SKIPPED
  unless configured — they prove the P0 tenant isolation, engine read-only enforcement,
  `statement_timeout`, write commit/rollback, and the `SECURITY:`-prefixed regressions
  (server-side multi-statement rejection, read-only-escape, session scrubbing) that a
  stub cannot. Run with:

  ```
  PGCP_TEST_HOST=localhost PGCP_TEST_USER=postgres PGCP_TEST_PASSWORD=postgres \
  PGCP_TEST_DATABASE=postgres npm test
  ```

  (falls back to `DATABASE_*` if `PGCP_TEST_*` are absent). They create/drop throwaway
  `pgcp_test_a` / `pgcp_test_b` schemas.

## Security notes

- Bearer secrets are compared in constant time and never logged (audit logs the token
  *id*, not the secret).
- The schema is applied as a **quoted identifier** (validated, double-quote-escaped); all
  values must be passed via `params` (`$1…`). The audit line records SQL text and error
  text (each capped at 2,000 chars with a `…[+N chars]` marker; a truncated statement also
  records `sqlLength` so it stays attributable) while `params` are **never** logged — so
  **never inline secret values as SQL literals**, use `params`.
- Not an ORM/migration runner (never generates or runs migrations), not a general SQL
  console — it's an infra utility for trusted services/agents.
- **MCP over HTTP** requires the caller to present the process's own token as a bearer and
  enables DNS-rebinding protection (Host allow-list); it still binds loopback by default.
- **`/health` is unauthenticated** but its DB pings are cached (`HEALTH_CACHE_TTL_MS`,
  default 5000ms) and de-duplicated, so probe floods can't exhaust the pool.
- Query error messages are returned to the caller verbatim (a debugging affordance);
  combined with the boundary below, treat error text as revealing structure.

### The read-only guarantee lives in the database

A token's `MODE=read` and the `BEGIN TRANSACTION READ ONLY` wrapper are **app-layer**
controls. They are correct, but they are app logic: one gateway bug, or one
`MODE=read`→`write` edit, removes them. The guarantee that survives that is a Postgres
login role with **no write grants**:

```sql
-- USER ACTION (privilege changes are never run by an agent). Run as superuser/owner.
CREATE ROLE agent_ro_pg WITH LOGIN PASSWORD '<strong-password>';
-- pg_read_all_data (PG14+): SELECT on all current AND FUTURE relations + schema USAGE.
-- Exactly right for schema-per-tenant, where new schemas appear at runtime.
GRANT pg_read_all_data TO agent_ro_pg;
-- Second lock: a plain BEGIN (the write path) is read-only too, so a mode misconfig
-- still cannot write. Advisory only — it is USERSET, so a caller can turn it off.
ALTER ROLE agent_ro_pg SET default_transaction_read_only = on;

-- PG14 only: PUBLIC still holds TEMP on the database, so any role can CREATE TEMP
-- TABLE and write to it. Session-local and cleared by DISCARD ALL, so it cannot touch
-- tenant data — revoke it anyway if you want the "no writes at all" claim to be literal.
-- REVOKE TEMP ON DATABASE <db> FROM PUBLIC;
-- Also PG14: PUBLIC holds CREATE on schema `public` unless revoked (PG15 changed the
-- default). Check with:
--   SELECT has_schema_privilege('public','public','CREATE');
-- REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Then set `DS_<NAME>_USER=agent_ro_pg` + its password. After this the role can write **no
existing relation** regardless of token mode, transaction mode, a smuggled statement, or a
gateway bug — it holds no privilege to do so.

Do **not** substitute `GRANT pg_write_all_data` for explicit grants on a write datasource:
its privileges are implicit in the ACL check and leave no per-table grant row, so naive
audit queries report it as harmless. (The boot probe below handles it explicitly.)

**Every boot reports the posture** for each datasource (`read-only posture OK` / `WEAK` /
`UNVERIFIED`). It asks whether the role *can* write — `has_table_privilege` /
`has_any_column_privilege` over every non-catalog relation, plus explicit superuser and
`pg_write_all_data` checks — rather than counting `information_schema.table_privileges`
rows, which are built from `relacl` and therefore blind to column-level grants, predefined
roles and superuser. It **fails closed**: a probe error or an unexpected result shape is
reported `UNVERIFIED`, never `OK`. It is a warning, never a hard failure — a legitimately
write-capable datasource may exist — so the point is that a misconfiguration is *loud*
rather than found in a later audit.

One caveat the probe cannot cover: if `dblink` or `postgres_fdw` is installed, `EXECUTE`
defaults to `PUBLIC` and `dblink('…','INSERT …')` writes over a *separate* connection —
outside the read-only transaction and outside any grant the role holds. Revoke `EXECUTE`
on those functions, or don't install them on a database this gateway reaches.

### Network binding

`HOST` defaults to `127.0.0.1`, and **only loopback binds without an explicit opt-in** —
anything else needs `ALLOW_PUBLIC_BIND=true`. This gateway holds live DB credentials and,
over HTTP, the only thing in front of them is a plaintext bearer secret, so binding beyond
this machine must be a deliberate decision made with TLS termination and a rotated secret.

The check is an **allowlist, not a denylist**, because the set of hosts that bind every
interface cannot be enumerated: `0.0.0.0`, `::`, `0`, `0.0`, `::0`, `0x0` and the *empty
string* all do it (an empty or bare-integer host is resolved rather than rejected, and
`net.isIP('0')` is `0`, so IP parsing does not catch it either). Requiring loopback is the
one rule that cannot be out-spelled. Note this means binding a specific private address
also needs the flag — deliberate either way.

The guard covers both `listen()` sites: the Fastify gateway (`HOST`) and the MCP
streamable-HTTP transport (`MCP_HTTP_HOST`), whose env vars bypass zod and so are
normalised for the empty-string case at the call site.

### Rotating the bearer secret

Secrets are plaintext in `.env` and compared as constant-time SHA-256 digests — never
logged. Rotation is therefore the only exposure control:

1. Generate: `openssl rand -base64 24`
2. Update **both** `TOKEN_<ID>_SECRET` and `MCP_TOKEN` in `.env` — the MCP process
   authenticates as one of the configured tokens, so a mismatch fails boot with
   `MCP_TOKEN does not match any configured token.`
3. Restart the gateway (`npm start`) and/or reconnect the MCP client (`/mcp` in Claude Code).
4. Rotate the **DB** password separately (`ALTER ROLE … PASSWORD …`, a user action) and
   update `DS_<NAME>_PASSWORD`; the bearer and the DB credential are independent secrets.

### ⚠️ Trust boundary — schema caps are NOT a hard tenant boundary

A token's `SCHEMAS` capability gates the **declared** target schema (the `schema` field /
`search_path`), **not** what the SQL body may touch. Every query runs as one shared DB
role, so **fully-qualified references bypass `search_path`** — e.g. a token scoped to
`public` can still run `SELECT * FROM "other_tenant".t`. `SET LOCAL search_path` guarantees
tenant isolation *between pooled borrowers* (the P0 invariant), but it does **not** confine
a caller that writes qualified names. Treat `SCHEMAS` as an accident-guard for trusted
callers, **not** a multi-tenant security boundary. If you need hard per-token schema
confinement, enforce it in Postgres (a DB role per token with `USAGE`/privileges revoked on
other schemas) — which is incompatible with the current shared-pool topology and is a
deliberate out-of-scope tradeoff for this utility.

### TLS note

When `SSL=true`, the client uses `rejectUnauthorized:false` (a typical TypeORM
config for managed Postgres with a self-signed chain) — this encrypts the connection but
does **not** authenticate the server. Provide a CA / set stricter TLS if MITM is in scope.

### search_path note

Only the target schema is put on `search_path` (not `public`), for isolation — so
references to shared `public` objects must be **fully qualified** (`public.foo`).
`pg_temp` is appended explicitly: when it is *absent* Postgres still searches it, and
searches it **first**, ahead of the tenant schema, for relation names — so a temp table
left on a pooled connection would shadow the next borrower's real table. Naming it
demotes it to last place.

### Why one statement per request is enforced twice

`assertSingleStatement` is a text scanner and text scanners lose. It previously missed
`E'…'` escape strings, where `\'` is an escaped quote rather than a terminator: the
scanner believed the literal was still open, swallowed the rest of the input, and let
`SELECT E'\''; COMMIT; <anything>` through. That smuggled `COMMIT` ended
`BEGIN TRANSACTION READ ONLY` and handed a **read-scoped token a read-write session** —
the read-only guarantee and the "defence in depth" guard were never independent, because
read-only lives on a transaction the caller could simply commit away.

The fix moves enforcement into the wire protocol. `pg` selects the protocol by whether
params were supplied — with none it uses the *simple* protocol, which executes `a; b`
from one call. `PostgresDriver.exec` now pins `queryMode:'extended'`, so Postgres answers
`cannot insert multiple commands into a prepared statement` regardless of what the
scanner thinks. The scanner is kept purely to fail such input earlier, as a 400, before
any DB contact. **Do not revert `exec` to the two-argument `client.query(sql, params)`
form** — that silently restores the simple protocol and the whole exploit chain.

## Known limitation

The row cap is enforced by fetching the result and slicing to `maxRows` (`truncated:true`
if exceeded), rather than a server-side cursor. For this trusted-caller utility that is
bounded in practice by `statement_timeout` + the row ceiling; a cursor-based bounded fetch
is a possible future optimization.
