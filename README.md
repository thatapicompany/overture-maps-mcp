# Overture Maps MCP server

Query [Overture Maps](https://www.overturemapsapi.com) data — places (POIs), buildings and administrative divisions — directly from Claude and other MCP-compatible LLM tools.

This is a local (stdio) MCP server that wraps the [Overture Maps API](https://www.overturemapsapi.com). Responses are compact summaries rather than full GeoJSON, so they stay token-efficient, and the tools steer toward cheap, well-scoped queries.

## Tools

| Tool | What it does |
|------|--------------|
| `search_places` | Search POIs/businesses by country or lat/lng+radius, filtered by category, taxonomy, brand or contact details. |
| `list_place_categories` | List available place categories (with counts) for a country or area — use to find valid `categories` values. |
| `list_place_countries` | List every country in the dataset with place/brand counts. |
| `search_divisions` | Look up administrative divisions (countries, regions, counties, localities) by name or location. |
| `find_buildings` | Find building footprints near a point (id, distance, height/levels). |

## Get an API key

Sign up at [overturemapsapi.com](https://www.overturemapsapi.com) for a free API key. The public `DEMO-API-KEY` also works for light testing. Set it as `OVERTURE_API_KEY`.

> Note: the Free tier is for non-commercial use. Commercial use needs a paid plan.

## Use with Claude Desktop

Add this to your `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "overture-maps": {
      "command": "npx",
      "args": ["-y", "@thatapicompany/overture-maps-mcp"],
      "env": {
        "OVERTURE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Restart Claude Desktop. You can then ask things like:

- "Find cafes within 500m of the Eiffel Tower."
- "List every used car dealer in the UK that has a website."
- "What administrative region is Springfield in?"
- "How many places does Overture have for Bermuda?"

## Use with other MCP clients

Any client that supports local stdio MCP servers works the same way — run `npx -y @thatapicompany/overture-maps-mcp` with `OVERTURE_API_KEY` in the environment.

## Local development

```bash
npm install
npm run build
OVERTURE_API_KEY=your-key node dist/index.js
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OVERTURE_API_KEY` | `DEMO-API-KEY` | Your Overture Maps API key. |
| `OVERTURE_API_BASE` | `https://api.overturemapsapi.com` | Override for staging/self-hosted deployments. |

## License

MIT
