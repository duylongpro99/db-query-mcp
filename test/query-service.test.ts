import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolManager } from '../src/pool/pool-manager.js';
import { QueryService } from '../src/query/query-service.js';
import { BadRequestError, ServiceUnavailableError } from '../src/query/gateway-errors.js';
import { makeConfig, silentLogger, StubDriver, CapturingAudit } from './helpers.js';

const config = makeConfig();
const pools = new PoolManager(config.datasources, silentLogger);
after(() => pools.drainAll());

function svc(stub: StubDriver, audit: CapturingAudit = new CapturingAudit(), ceiling = config.maxRowsCeiling) {
    return { qs: new QueryService(stub, pools, ceiling, audit), audit };
}

const base = { tokenId: 't', datasource: 'main', schema: 'public' as string };

test('read path: BEGIN READ ONLY → SET LOCAL ×3 → sql → COMMIT → DISCARD ALL, released once', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'SELECT 1', write: false });
    const sqls = stub.sqls();
    assert.equal(sqls[0], 'BEGIN TRANSACTION READ ONLY');
    assert.match(sqls[1], /^SET LOCAL statement_timeout TO \d+$/);
    assert.match(sqls[2], /^SET LOCAL idle_in_transaction_session_timeout TO \d+$/);
    assert.equal(sqls[3], 'SET LOCAL search_path TO "public", pg_temp');
    assert.equal(sqls[4], 'SELECT 1');
    assert.equal(sqls[5], 'COMMIT');
    assert.equal(sqls[6], 'DISCARD ALL');
    assert.equal(stub.released, 1);
});

test('search_path names pg_temp last so temp tables cannot shadow the tenant schema', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, schema: 'tenant_a', sql: 'SELECT 1', write: false });
    assert.ok(stub.sqls().includes('SET LOCAL search_path TO "tenant_a", pg_temp'));
});

test('scrubs session state with DISCARD ALL after COMMIT, outside the txn', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    // A caller's plain SET survives COMMIT on a pooled connection; DISCARD ALL is
    // what stops the next borrower inheriting it.
    await qs.run({ ...base, sql: 'SET statement_timeout = 0', write: false });
    const sqls = stub.sqls();
    assert.ok(sqls.indexOf('DISCARD ALL') > sqls.indexOf('COMMIT'));
});

test('scrubs session state on the write path too', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'INSERT INTO t VALUES (1)', write: true });
    assert.ok(stub.sqls().includes('DISCARD ALL'));
});

test('scrubs session state after a failed query (post-ROLLBACK)', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('boom');
    const { qs } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT bad', write: false }), /boom/);
    const sqls = stub.sqls();
    assert.ok(sqls.indexOf('DISCARD ALL') > sqls.indexOf('ROLLBACK'));
    assert.equal(stub.releaseErrors[0], undefined); // clean scrub → safe to reuse
});

test('destroys the connection when DISCARD ALL fails (state unknown)', async () => {
    const stub = new StubDriver();
    stub.discardError = new Error('discard boom');
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'SELECT 1', write: false }); // query itself still succeeds
    assert.equal(stub.released, 1);
    assert.ok(stub.releaseErrors[0]); // released WITH an error → pg destroys the client
});

test('skips DISCARD ALL when ROLLBACK already failed (connection is being destroyed)', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('query boom');
    stub.rollbackError = new Error('rollback boom');
    const { qs } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT 1', write: false }), /query boom/);
    assert.ok(!stub.sqls().includes('DISCARD ALL'));
    assert.ok(stub.releaseErrors[0]);
});

test('write path uses plain BEGIN and surfaces rowsAffected', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: [], rowCount: 3, command: 'INSERT' };
    const { qs, audit } = svc(stub);
    const { response } = await qs.run({ ...base, sql: 'INSERT INTO t VALUES (1)', write: true });
    assert.equal(stub.sqls()[0], 'BEGIN');
    assert.equal(response.rowsAffected, 3);
    assert.equal(audit.entries[0].write, true);
    assert.equal(audit.entries[0].command, 'INSERT');
    assert.equal(audit.entries[0].rowsAffected, 3);
});

test('SET LOCAL guards are present on the write path too', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'UPDATE t SET a=1', write: true });
    const sqls = stub.sqls();
    assert.ok(sqls.some((s) => s.startsWith('SET LOCAL statement_timeout')));
    assert.ok(sqls.some((s) => s.startsWith('SET LOCAL idle_in_transaction_session_timeout')));
    assert.ok(sqls.includes('SET LOCAL search_path TO "public", pg_temp'));
});

test('rejects multi-statement SQL before any DB contact', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT 1; DROP TABLE t', write: false }),
        (e) => e instanceof BadRequestError,
    );
    assert.equal(stub.connectCount, 0);
});

test('ROLLBACK + release on query error, error audited', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('boom');
    const { qs, audit } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT bad', write: false }), /boom/);
    assert.ok(stub.sqls().includes('ROLLBACK'));
    assert.equal(stub.released, 1);
    assert.equal(audit.entries[0].error, 'boom');
});

test('destroys the connection (release with error) when ROLLBACK also fails', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('query boom');
    stub.rollbackError = new Error('rollback boom');
    const { qs } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT 1', write: false }), /query boom/);
    assert.equal(stub.released, 1);
    assert.ok(stub.releaseErrors[0]); // released WITH an error → pg destroys the client
});

test('releases the connection clean when ROLLBACK succeeds', async () => {
    const stub = new StubDriver();
    stub.userError = new Error('boom');
    const { qs } = svc(stub);
    await assert.rejects(() => qs.run({ ...base, sql: 'SELECT 1', write: false }), /boom/);
    assert.equal(stub.releaseErrors[0], undefined); // clean release → reused
});

test('clamps timeoutMs down to the datasource statement timeout', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, sql: 'SELECT 1', write: false, timeoutMs: 999999 });
    const setStmt = stub.sqls().find((s) => s.startsWith('SET LOCAL statement_timeout'));
    assert.equal(setStmt, 'SET LOCAL statement_timeout TO 10000');
});

test('truncates to maxRows and sets truncated:true', async () => {
    const stub = new StubDriver();
    stub.userResult = {
        fields: [{ name: 'n', dataType: 'int4' }],
        rows: Array.from({ length: 6 }, (_, i) => ({ n: i })),
        rowCount: 6,
        command: 'SELECT',
    };
    const { qs } = svc(stub);
    const { response } = await qs.run({ ...base, sql: 'SELECT n', write: false, maxRows: 5 });
    assert.equal(response.rows.length, 5);
    assert.equal(response.rowCount, 5);
    assert.equal(response.truncated, true);
});

test('does not truncate when rows <= maxRows', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: [{ a: 1 }, { a: 2 }], rowCount: 2, command: 'SELECT' };
    const { qs } = svc(stub);
    const { response } = await qs.run({ ...base, sql: 'x', write: false, maxRows: 5 });
    assert.equal(response.truncated, false);
    assert.equal(response.rows.length, 2);
});

test('clamps maxRows to the server ceiling', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: Array.from({ length: 4 }, () => ({})), rowCount: 4, command: 'SELECT' };
    const { qs } = svc(stub, new CapturingAudit(), 3); // ceiling 3
    const { response } = await qs.run({ ...base, sql: 'x', write: false, maxRows: 1000 });
    assert.equal(response.rows.length, 3);
    assert.equal(response.truncated, true);
});

test('quotes schema identifier, escaping embedded double-quotes', async () => {
    const stub = new StubDriver();
    const { qs } = svc(stub);
    await qs.run({ ...base, schema: 'we"ird', sql: 'SELECT 1', write: false });
    assert.ok(stub.sqls().includes('SET LOCAL search_path TO "we""ird", pg_temp'));
});

test('connect failure → ServiceUnavailableError (503), audited', async () => {
    const stub = new StubDriver();
    stub.connectError = new Error('ECONNREFUSED');
    const { qs, audit } = svc(stub);
    await assert.rejects(
        () => qs.run({ ...base, sql: 'SELECT 1', write: false }),
        (e) => e instanceof ServiceUnavailableError,
    );
    assert.match(audit.entries[0].error ?? '', /unavailable/);
});

test('audits base fields and omits write fields on read path', async () => {
    const stub = new StubDriver();
    const { qs, audit } = svc(stub);
    await qs.run({ tokenId: 'agent_ro', datasource: 'main', schema: 'public', sql: 'SELECT 1', write: false });
    const e = audit.entries[0];
    assert.equal(e.tokenId, 'agent_ro');
    assert.equal(e.datasource, 'main');
    assert.equal(e.schema, 'public');
    assert.equal(e.sql, 'SELECT 1');
    assert.equal(typeof e.elapsedMs, 'number');
    assert.equal(e.write, undefined);
    assert.equal(e.command, undefined);
});
