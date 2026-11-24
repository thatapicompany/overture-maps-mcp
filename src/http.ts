#!/usr/bin/env node
/**
 * Overture Maps MCP server, hosted (Streamable HTTP).
 *
 * The same tools as the local server, reachable at a URL, for clients that
 * connect to remote MCP servers and cannot run npx: POST /mcp.
 *
 * Each caller brings their own Overture Maps API key, in any of:
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
 *   /mcp?api_key=<key>      for clients that only take a URL
 * With no key the public demo key is used, which searches near a few demo
 * cities. Nothing is kept between requests: every request gets a fresh server
 * bound to its key, so one caller can never see another's key or results, and
 * the service can run on any number of instances.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { API_BASE, createServer, DEMO_KEY, USER_AGENT } from "./server.js";

const MAX_BODY_BYTES = 1_000_000;
const KEY_SHAPE = /^[A-Za-z0-9_.\-]{8,200}$/;
export const HOSTED_USER_AGENT = USER_AGENT.replace("overture-maps-mcp/", "overture-maps-mcp-hosted/");

/** The API key a request carries, or the demo key when it carries none. */
export function keyFrom(headers: IncomingMessage["headers"], url: URL): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ""))?.[1];
  const header = Array.isArray(headers["x-api-key"]) ? headers["x-api-key"][0] : headers["x-api-key"];
  const key = (bearer ?? header ?? url.searchParams.get("api_key") ?? url.searchParams.get("key") ?? "").trim();
  return KEY_SHAPE.test(key) ? key : DEMO_KEY;
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-api-key, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);

  if (url.pathname === "/" || url.pathname === "/health") {
    return send(res, 200, {
      service: "overture-maps-mcp",
      transport: "streamable-http",
      endpoint: "/mcp",
      docs: "https://www.overturemapsapi.com/docs/use-with-ai-tools",
    });
  }
  if (url.pathname !== "/mcp") return send(res, 404, { error: "Not found. The MCP endpoint is POST /mcp." });
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  // No sessions and no server-initiated messages, so there is nothing to GET or DELETE.
  if (req.method !== "POST") {
    return send(
      res,
      405,
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Send MCP requests with POST." }, id: null },
      { allow: "POST, OPTIONS" },
    );
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "The request body must be JSON, up to 1 MB." }, id: null });
  }

  const server = createServer({ apiKey: keyFrom(req.headers, url), userAgent: HOSTED_USER_AGENT });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP request failed:", err instanceof Error ? err.message : err);
    if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}

// Started directly (node dist/http.js), not when imported by a test.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT ?? 8080);
  createHttpServer((req, res) => void handle(req, res)).listen(port, () => {
    console.error(`overture-maps MCP server (hosted) listening on :${port} (API: ${API_BASE})`);
  });
}
