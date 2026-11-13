import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The MCP Registry rejects a publish when server.json and the npm package
// disagree, so keep them in step (the publish workflow also syncs versions).
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

describe("server.json (MCP Registry metadata)", () => {
  it("uses the package's mcpName under the organisation's GitHub namespace", () => {
    assert.equal(server.name, pkg.mcpName);
    assert.match(server.name, /^io\.github\.thatapicompany\//);
  });

  it("points at this npm package and version", () => {
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages[0].registryType, "npm");
    assert.equal(server.packages[0].identifier, pkg.name);
    assert.equal(server.packages[0].version, pkg.version);
    assert.equal(server.packages[0].transport.type, "stdio");
  });

  it("keeps the description within the registry's 100-character limit", () => {
    assert.ok(server.description.length <= 100, `${server.description.length} characters`);
  });
});
