import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServices } from '../src/services.js';
import { registerTools } from '../src/mcp/tools.js';
import type { Capabilities } from '../src/auth/token-auth.js';
import { makeConfig, silentLogger, StubDriver } from './helpers.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

/** Minimal McpServer stand-in that captures tool registrations. */
class FakeMcp {
    tools = new Map<string, { config: Record<string, unknown>; handler: Handler }>();
    registerTool(name: string, config: Record<string, unknown>, handler: Handler): unknown {
        this.tools.set(name, { config, handler });
        return {};
    }
}

function setup(stub: StubDriver) {
    const services = buildServices(makeConfig(), silentLogger, stub);
    const fake = new FakeMcp();
    return { services, fake };
}

const roCaps: Capabilities = { id: 'agent_ro', datasources: ['main'], canWrite: false, schemas: ['*'] };
const rwCaps: Capabilities = { id: 'svc_rw', datasources: ['main'], canWrite: true, schemas: ['public'] };

after(() => undefined);

test('registers exactly the 4 tools', () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    assert.deepEqual([...fake.tools.keys()].sort(), ['describe_table', 'list_schemas', 'list_tables', 'run_query']);
});

test('run_query delegates to QueryService and returns neutral result as content', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [{ name: 'id', dataType: 'uuid' }], rows: [{ id: 'a' }], rowCount: 1, command: 'SELECT' };
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);

    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', sql: 'SELECT id FROM t' });
    assert.notEqual(res.isError, true);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.rowCount, 1);
    assert.deepEqual(payload.columns, [{ name: 'id', dataType: 'uuid' }]);
    // Went through the guarded txn path.
    assert.ok(stub.sqls().includes('BEGIN TRANSACTION READ ONLY'));
});

test('run_query with readOnly:false under a read token → isError (write-not-permitted)', async () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', sql: 'INSERT INTO t VALUES (1)', readOnly: false });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /write-not-permitted/);
    assert.equal(stub.connectCount, 0); // denied before DB contact
});

test('run_query with a datasource outside caps → isError', async () => {
    const stub = new StubDriver();
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'ghost', sql: 'SELECT 1' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not permitted/);
});

test('run_query write under a write token commits and reports rowsAffected', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: [], rowCount: 2, command: 'UPDATE' };
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, rwCaps);
    const res = await fake.tools.get('run_query')!.handler({ datasource: 'main', schema: 'public', sql: 'UPDATE t SET a=1', readOnly: false });
    assert.notEqual(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).rowsAffected, 2);
    assert.equal(stub.sqls()[0], 'BEGIN'); // write txn
});

test('list_tables delegates to IntrospectService', async () => {
    const stub = new StubDriver();
    stub.userResult = { fields: [], rows: [{ table_name: 't1', table_type: 'BASE TABLE' }], rowCount: 1, command: 'SELECT' };
    const { services, fake } = setup(stub);
    registerTools(fake as never, services, roCaps);
    const res = await fake.tools.get('list_tables')!.handler({ datasource: 'main', schema: 'public' });
    assert.deepEqual(JSON.parse(res.content[0].text), { tables: [{ name: 't1', type: 'BASE TABLE' }] });
});
