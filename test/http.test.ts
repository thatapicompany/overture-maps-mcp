import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handle, HOSTED_USER_AGENT, keyFrom } from "../src/http.js";

const realFetch = globalThis.fetch;
let http: Server;
let base: string;
let apiCalls: { url: string; key: string | null; agent: string | null }[] = [];

before(async () => {
  http = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  // Calls to the Overture API are answered here; calls to the test server pass through.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(base)) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    apiCalls.push({ url, key: headers.get("x-api-key"), agent: headers.get("user-agent") });
    return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json", "Pagination-Count": "0" } });
  }) as typeof fetch;
});
beforeEach(() => {
  apiCalls = [];
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => http.close(resolve));
});

async function connect(path: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path), { requestInit: { headers } }));
  return client;
}

describe("the key a request carries", () => {
  const url = (search = "") => new URL(`http://x/mcp${search}`);
  it("is read from a bearer token, the x-api-key header or the address, in that order", () => {
    assert.equal(keyFrom({ authorization: "Bearer key-from-bearer" }, url("?api_key=key-from-url")), "key-from-bearer");
    assert.equal(keyFrom({ "x-api-key": "key-from-header" }, url("?api_key=key-from-url")), "key-from-header");
    assert.equal(keyFrom({}, url("?api_key=key-from-url")), "key-from-url");
    assert.equal(keyFrom({}, url("?key=key-from-url")), "key-from-url");
  });
  it("falls back to the demo key when there is none, or it is not shaped like a key", () => {
    assert.equal(keyFrom({}, url()), "DEMO-API-KEY");
    assert.equal(keyFrom({ "x-api-key": "bad key\nwith: header" }, url()), "DEMO-API-KEY");
  });
});

describe("the hosted endpoint", () => {
  it("lists the same tools as the local server", async () => {
    const client = await connect("/mcp");
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["find_buildings", "list_place_categories", "list_place_countries", "search_divisions", "search_places"],
    );
    await client.close();
  });

  it("calls the API with the caller's own key and the hosted user agent", async () => {
    const client = await connect("/mcp", { authorization: "Bearer callers-own-key" });
    await client.callTool({ name: "search_places", arguments: { lat: 51.5, lng: -0.12, radius: 500 } });
    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].key, "callers-own-key");
    assert.equal(apiCalls[0].agent, HOSTED_USER_AGENT);
    await client.close();
  });

  it("keeps two callers' keys apart", async () => {
    const [a, b] = await Promise.all([connect("/mcp?api_key=first-caller-key"), connect("/mcp", { "x-api-key": "second-caller-key" })]);
    await Promise.all([
      a.callTool({ name: "find_buildings", arguments: { lat: 51.5, lng: -0.12 } }),
      b.callTool({ name: "find_buildings", arguments: { lat: 51.5, lng: -0.12 } }),
    ]);
    assert.deepEqual(apiCalls.map((c) => c.key).sort(), ["first-caller-key", "second-caller-key"]);
    await Promise.all([a.close(), b.close()]);
  });

  it("answers health checks and refuses anything but POST on /mcp", async () => {
    assert.equal((await realFetch(`${base}/health`)).status, 200);
    const get = await realFetch(`${base}/mcp`);
    assert.equal(get.status, 405);
    assert.equal((await realFetch(`${base}/elsewhere`)).status, 404);
    const bad = await realFetch(`${base}/mcp`, { method: "POST", body: "not json" });
    assert.equal(bad.status, 400);
  });
});
