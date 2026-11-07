#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { API_BASE, server } from "./server.js";

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is reserved for the MCP protocol.
  console.error(`overture-maps MCP server running (API: ${API_BASE})`);
}

main().catch((err) => {
  console.error("Fatal error starting overture-maps MCP server:", err);
  process.exit(1);
});
