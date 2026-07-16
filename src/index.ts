#!/usr/bin/env node
/**
 * Overture Maps MCP server (local / stdio).
 *
 * Exposes a curated, LLM-optimised set of tools over the Overture Maps API
 * (https://www.overturemapsapi.com). Responses are deliberately compact —
 * summaries rather than full GeoJSON — to stay token-efficient, and the tools
 * steer toward cheap query shapes (a country or a radius, sensible limits).
 *
 * Auth: set OVERTURE_API_KEY in the environment. A public DEMO-API-KEY works
 * for light testing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.OVERTURE_API_BASE || "https://api.overturemapsapi.com";
const API_KEY = process.env.OVERTURE_API_KEY || process.env.API_KEY || "DEMO-API-KEY";

const MAX_LIMIT = 50; // keep LLM responses within a sane token budget
const MAX_RADIUS = 25000; // API ceiling

type Json = Record<string, any>;

async function apiGet(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<{ data: any; total: number | null }> {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Overture API ${res.status} for ${path}: ${body.slice(0, 300)}`,
    );
  }
  const totalHeader = res.headers.get("Pagination-Count");
  const data = await res.json();
  return { data, total: totalHeader ? Number(totalHeader) : null };
}

// Overture JSON and GeoJSON both appear across formats; normalise to the
// property bag either way.
const props = (item: Json): Json => item?.properties ?? item ?? {};

const coords = (item: Json): { lat?: number; lng?: number } => {
  const g = item?.geometry ?? props(item)?.geometry;
  const c = g?.coordinates;
  if (Array.isArray(c) && c.length >= 2) return { lng: c[0], lat: c[1] };
  return {};
};

const first = (v: unknown): string | undefined =>
  Array.isArray(v) && v.length ? String(v[0]) : undefined;

function compactPlace(item: Json): Json {
  const p = props(item);
  const addr = Array.isArray(p.addresses) ? p.addresses[0] : undefined;
  const { lat, lng } = coords(item);
  return {
    id: p.id,
    name: p.names?.primary ?? null,
    category: p.categories?.primary ?? p.taxonomy?.primary ?? p.basic_category ?? null,
    locality: addr?.locality ?? null,
    region: addr?.region ?? null,
    country: addr?.country ?? null,
    website: first(p.websites) ?? null,
    phone: first(p.phones) ?? null,
    confidence: p.confidence ?? null,
    lat: lat ?? null,
    lng: lng ?? null,
    ...(p.ext_distance != null ? { distance_m: Math.round(p.ext_distance) } : {}),
  };
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const asArray = (data: any): any[] =>
  Array.isArray(data) ? data : data?.features ?? data?.data ?? [];

const server = new McpServer({
  name: "overture-maps",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// search_places — the core tool
// ---------------------------------------------------------------------------
server.tool(
  "search_places",
  "Search for places (points of interest / businesses) in Overture Maps data. " +
    "You must scope the search to keep it fast and cheap: provide either a `country` " +
    "(ISO 3166-1 alpha-2, e.g. GB, US, FR) OR a `lat`+`lng` with a `radius`. " +
    "Filter by `categories` (e.g. restaurant, cafe, used_car_dealer — use list_place_categories to discover valid values), " +
    "`brand_name` (e.g. Starbucks), or `has_contact` to only return places with a website/phone. " +
    "Returns compact summaries (name, category, location, website, phone), not full geometry.",
  {
    country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2 country code, e.g. GB, US, FR. Use this OR lat+lng."),
    lat: z.number().optional().describe("Latitude for a radius search. Requires lng."),
    lng: z.number().optional().describe("Longitude for a radius search. Requires lat."),
    radius: z.number().optional().describe(`Search radius in metres for a lat/lng search (default 1000, max ${MAX_RADIUS}).`),
    categories: z.string().optional().describe("Comma-separated category names, e.g. 'restaurant' or 'cafe,bakery'."),
    taxonomy: z.string().optional().describe("Hierarchy-aware category, e.g. 'food_and_drink' matches every restaurant/cafe/bar/bakery."),
    brand_name: z.string().optional().describe("Retail chain / brand name, e.g. 'Starbucks', 'Tesco'."),
    has_contact: z.string().optional().describe("Only return places that have at least one of these contact fields (OR): website, phone, email, social. e.g. 'website,social'."),
    min_confidence: z.number().optional().describe("Minimum confidence 0-1 (default 0.5). Higher = more precise, fewer results."),
    limit: z.number().optional().describe(`Number of results (default 10, max ${MAX_LIMIT}).`),
    page: z.number().optional().describe("0-indexed page number for paging through results."),
  },
  async (args) => {
    if (!args.country && !(args.lat != null && args.lng != null)) {
      return text(
        "Please scope the search: provide a `country` (e.g. GB) or a `lat`+`lng` (with an optional `radius`).",
      );
    }
    const limit = Math.min(Math.max(args.limit ?? 10, 1), MAX_LIMIT);
    const params: Record<string, any> = {
      country: args.country,
      lat: args.lat,
      lng: args.lng,
      radius: args.lat != null ? Math.min(args.radius ?? 1000, MAX_RADIUS) : undefined,
      categories: args.categories,
      taxonomy: args.taxonomy,
      brand_name: args.brand_name,
      has_contact: args.has_contact,
      min_confidence: args.min_confidence ?? 0.5,
      limit,
      page: args.page ?? 0,
      format: "json",
    };
    const { data, total } = await apiGet("/places", params);
    const rows = asArray(data).map(compactPlace);
    const scope = args.country && args.lat == null
      ? `country-wide (${args.country})`
      : `near ${args.lat},${args.lng} within ${params.radius}m`;
    const header =
      `Found ${rows.length} place(s) ${scope}` +
      (total != null ? ` — ${total} total match(es).` : ".") +
      (total != null && total > rows.length
        ? ` Use page=${(args.page ?? 0) + 1} for more.`
        : "");
    return text(`${header}\n\n${JSON.stringify(rows, null, 2)}`);
  },
);

// ---------------------------------------------------------------------------
// list_place_categories — discover valid category values
// ---------------------------------------------------------------------------
server.tool(
  "list_place_categories",
  "List the place categories available in Overture Maps data for a country (or a lat/lng/radius area), " +
    "with how many places each has. Use this to find valid `categories` values before calling search_places.",
  {
    country: z.string().length(2).optional().describe("ISO country code, e.g. GB. Use this OR lat+lng."),
    lat: z.number().optional(),
    lng: z.number().optional(),
    radius: z.number().optional().describe(`Radius in metres for a lat/lng area (max ${MAX_RADIUS}).`),
  },
  async (args) => {
    if (!args.country && !(args.lat != null && args.lng != null)) {
      return text("Please provide a `country` or a `lat`+`lng`.");
    }
    const { data } = await apiGet("/places/categories", {
      country: args.country,
      lat: args.lat,
      lng: args.lng,
      radius: args.lat != null ? Math.min(args.radius ?? 1000, MAX_RADIUS) : undefined,
    });
    const rows = asArray(data)
      .map((c: Json) => ({
        category: c.primary ?? c.category ?? c.name,
        count: c.counts?.places ?? c.count ?? null,
      }))
      .filter((c) => c.category)
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .slice(0, 150);
    return text(`${rows.length} categories (most common first):\n\n${JSON.stringify(rows, null, 2)}`);
  },
);

// ---------------------------------------------------------------------------
// list_place_countries — coverage overview
// ---------------------------------------------------------------------------
server.tool(
  "list_place_countries",
  "List every country present in Overture Maps places data, with the number of places (and brands) in each. " +
    "Useful to check coverage before searching.",
  {},
  async () => {
    const { data } = await apiGet("/places/countries", {});
    const all = asArray(data)
      .map((c: Json) => ({
        country: c.country ?? c.country_code,
        places: c.counts?.places ?? c.count_places ?? null,
        brands: c.counts?.brands ?? null,
      }))
      .filter((c) => c.country)
      .sort((a, b) => (b.places ?? 0) - (a.places ?? 0));
    const rows = all.slice(0, 100);
    const note = all.length > rows.length ? ` (showing top ${rows.length} of ${all.length} by place count)` : "";
    return text(`${all.length} countries${note}:\n\n${JSON.stringify(rows, null, 2)}`);
  },
);

// ---------------------------------------------------------------------------
// search_divisions — administrative boundaries / place-name lookup
// ---------------------------------------------------------------------------
server.tool(
  "search_divisions",
  "Look up administrative divisions (countries, regions, counties, localities) in Overture Maps. " +
    "Search by `name` (e.g. 'Springfield'), optionally narrowed by `country`, `subtype` " +
    "(country, region, county, locality, ...) or `admin_level`. Geometry is omitted by default to save space; " +
    "set include_geometry=true only if you specifically need the boundary polygon.",
  {
    name: z.string().optional().describe("Division name to search for, e.g. 'Paris', 'Bavaria'."),
    country: z.string().length(2).optional().describe("ISO country code to narrow the search, e.g. FR."),
    subtype: z.string().optional().describe("Division subtype: country, region, county, locality, etc."),
    admin_level: z.number().optional().describe("Administrative level (0 = country, higher = more local)."),
    lat: z.number().optional(),
    lng: z.number().optional(),
    radius: z.number().optional(),
    limit: z.number().optional().describe(`Number of results (default 10, max ${MAX_LIMIT}).`),
    include_geometry: z.boolean().optional().describe("Include the boundary polygon (large). Default false."),
  },
  async (args) => {
    if (!args.name && !args.country && !(args.lat != null && args.lng != null)) {
      return text("Please provide a `name`, a `country`, or a `lat`+`lng` to search divisions.");
    }
    const { data, total } = await apiGet("/divisions", {
      name: args.name,
      country: args.country,
      subtype: args.subtype,
      admin_level: args.admin_level,
      lat: args.lat,
      lng: args.lng,
      radius: args.lat != null ? Math.min(args.radius ?? 5000, MAX_RADIUS) : undefined,
      limit: Math.min(Math.max(args.limit ?? 10, 1), MAX_LIMIT),
      include_geometry: args.include_geometry ? true : undefined,
      format: "json",
    });
    const rows = asArray(data).map((item: Json) => {
      const p = props(item);
      return {
        id: p.id,
        name: p.names?.primary ?? p.name ?? null,
        subtype: p.subtype ?? null,
        admin_level: p.admin_level ?? null,
        country: p.country ?? null,
        region: p.region ?? null,
        ...(args.include_geometry ? { geometry: item.geometry ?? p.geometry } : {}),
      };
    });
    const header = `Found ${rows.length} division(s)` + (total != null ? ` of ${total} total.` : ".");
    return text(`${header}\n\n${JSON.stringify(rows, null, 2)}`);
  },
);

// ---------------------------------------------------------------------------
// find_buildings — building footprints near a point
// ---------------------------------------------------------------------------
server.tool(
  "find_buildings",
  "Find building footprints near a location from Overture Maps. Requires `lat`+`lng`; " +
    "returns compact building summaries (id, distance, height/levels where known) without full geometry.",
  {
    lat: z.number().describe("Latitude (required)."),
    lng: z.number().describe("Longitude (required)."),
    radius: z.number().optional().describe(`Radius in metres (default 250, max ${MAX_RADIUS}).`),
    limit: z.number().optional().describe(`Number of results (default 10, max ${MAX_LIMIT}).`),
  },
  async (args) => {
    const { data, total } = await apiGet("/buildings", {
      lat: args.lat,
      lng: args.lng,
      radius: Math.min(args.radius ?? 250, MAX_RADIUS),
      limit: Math.min(Math.max(args.limit ?? 10, 1), MAX_LIMIT),
      format: "json",
    });
    const rows = asArray(data).map((item: Json) => {
      const p = props(item);
      return {
        id: p.id,
        class: p.class ?? p.subtype ?? null,
        height_m: p.height ?? null,
        levels: p.num_floors ?? null,
        ...(p.ext_distance != null ? { distance_m: Math.round(p.ext_distance) } : {}),
      };
    });
    const header = `Found ${rows.length} building(s)` + (total != null ? ` of ${total} total.` : ".");
    return text(`${header}\n\n${JSON.stringify(rows, null, 2)}`);
  },
);

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
