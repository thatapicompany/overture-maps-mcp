import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compactPlace, server } from "../src/server.js";

// Every test stubs fetch, so nothing here reaches the real API.
type Call = { url: URL; headers: Record<string, string> };
let calls: Call[] = [];
let nextResponse: () => Response;
const realFetch = globalThis.fetch;

const place = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [151.2093, -33.8688] },
  properties: {
    id: "00000000-0000-0000-0000-000000000001",
    names: { primary: "Example Cafe" },
    categories: { primary: "cafe" },
    addresses: [{ freeform: "1 Example St", locality: "Sydney", region: "NSW", country: "AU" }],
    websites: ["https://example.com"],
    phones: ["+61200000000"],
    confidence: 0.9,
    ext_distance: 42.4,
  },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const client = new Client({ name: "test", version: "0.0.0" });

before(async () => {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string> });
    return nextResponse();
  }) as typeof fetch;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

after(async () => {
  await client.close();
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  nextResponse = () => json([place], 200, { "Pagination-Count": "3" });
});

const textOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe("tool listing", () => {
  it("exposes the five tools, each annotated as read-only", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["find_buildings", "list_place_categories", "list_place_countries", "search_divisions", "search_places"],
    );
    for (const tool of tools) {
      assert.ok(tool.annotations?.title, `${tool.name} has a title`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} destructiveHint`);
      assert.equal(tool.annotations?.idempotentHint, true, `${tool.name} idempotentHint`);
      assert.equal(tool.annotations?.openWorldHint, true, `${tool.name} openWorldHint`);
    }
  });
});

describe("compactPlace", () => {
  it("flattens a GeoJSON feature into a compact summary", () => {
    assert.deepEqual(compactPlace(place), {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Example Cafe",
      category: "cafe",
      locality: "Sydney",
      region: "NSW",
      country: "AU",
      website: "https://example.com",
      phone: "+61200000000",
      confidence: 0.9,
      lat: -33.8688,
      lng: 151.2093,
      distance_m: 42,
    });
  });

  it("returns nulls rather than throwing on a sparse record", () => {
    const row = compactPlace({ properties: { id: "x" } });
    assert.equal(row.id, "x");
    assert.equal(row.name, null);
    assert.equal(row.lat, null);
  });
});

describe("search_places", () => {
  it("clamps radius and limit, sends the key, and reports the total", async () => {
    const result = await client.callTool({
      name: "search_places",
      arguments: { lat: -33.8688, lng: 151.2093, radius: 999999, limit: 500, categories: "cafe" },
    });
    assert.equal(calls.length, 1);
    const { url, headers } = calls[0];
    assert.equal(url.pathname, "/places");
    assert.equal(url.searchParams.get("radius"), "25000");
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(url.searchParams.get("categories"), "cafe");
    assert.equal(headers["x-api-key"], "DEMO-API-KEY");
    const text = textOf(result);
    assert.match(text, /Found 1 place\(s\)/);
    assert.match(text, /3 total match/);
    assert.match(text, /Example Cafe/);
  });

  it("asks for a location instead of calling the API when none is given", async () => {
    const result = await client.callTool({ name: "search_places", arguments: { categories: "cafe" } });
    assert.equal(calls.length, 0);
    assert.match(textOf(result), /lat`\+`lng/);
  });

  it("refuses a country-wide search on the demo key without calling the API", async () => {
    const result = await client.callTool({ name: "search_places", arguments: { country: "AU" } });
    assert.equal(calls.length, 0);
    assert.match(textOf(result), /paid plan/);
  });

  it("relays a quota refusal as an answer, not an error", async () => {
    nextResponse = () => json({ message: "Monthly request limit reached" }, 429);
    const result = await client.callTool({
      name: "search_places",
      arguments: { lat: -33.8688, lng: 151.2093 },
    });
    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /declined this request \(429\): Monthly request limit reached/);
  });

  it("surfaces a server error as a tool error", async () => {
    nextResponse = () => json({ message: "boom" }, 500);
    const result = await client.callTool({
      name: "search_places",
      arguments: { lat: -33.8688, lng: 151.2093 },
    });
    assert.equal(result.isError, true);
  });
});

describe("find_buildings", () => {
  it("summarises buildings without geometry", async () => {
    nextResponse = () =>
      json([{ type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: { id: "b1", class: "office", height: 30, num_floors: 8, ext_distance: 12.6 } }]);
    const result = await client.callTool({ name: "find_buildings", arguments: { lat: -33.8688, lng: 151.2093 } });
    assert.equal(calls[0].url.pathname, "/buildings");
    const text = textOf(result);
    assert.match(text, /"levels": 8/);
    assert.doesNotMatch(text, /Polygon/);
  });
});
