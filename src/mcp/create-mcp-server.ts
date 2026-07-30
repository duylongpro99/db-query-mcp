/**
 * createMcpServer — build one McpServer with the 4 tools registered against the
 * shared services + resolved identity. A single server suffices (the 4 tools are
 * static; no per-session state). The HTTP transport still builds one per session
 * because the SDK binds a server to exactly one transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../services.js';
import type { Capabilities } from '../auth/token-auth.js';
import { registerTools } from './tools.js';

export function createMcpServer(services: Services, caps: Capabilities): McpServer {
    const server = new McpServer({ name: 'pg-connection-pool', version: '0.1.0' });
    registerTools(server, services, caps);
    return server;
}
