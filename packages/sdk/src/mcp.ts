#!/usr/bin/env node
// Runs the Reputed MCP server over stdio. Set REPUTED_API_URL to the Reputed server.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ReputedClient } from './client.ts';
import { createMcpServer } from './mcpServer.ts';

const apiUrl = process.env.REPUTED_API_URL ?? 'http://localhost:4000';
const server = createMcpServer(new ReputedClient({ apiUrl }));
await server.connect(new StdioServerTransport());
// stdout carries the protocol, so anything for humans goes to stderr.
console.error(`Reputed MCP server ready (API: ${apiUrl})`);
