"use strict";

const assert = require("node:assert/strict");
const {
  generateKeyPairSync,
  sign: signBytes,
} = require("node:crypto");
const test = require("node:test");

const {
  DEFAULT_MAX_RESPONSE_BYTES,
  ErrorCode,
  callRemote,
  createForward,
  dispatchRequest,
  getConfig,
  handleLine,
  parseCatalogPublicKeys,
  parseIntegerSetting,
  readBoundedJsonResponse,
  readConfigFile,
  readTokenFromKeychain,
  resolveProfile,
  resolveToken,
} = require("../scripts/docmost-keychain-proxy.cjs");
const {
  CATALOG_BUNDLE_SCHEMA_VERSION,
  CATALOG_FRESHNESS_SCHEMA_VERSION,
  QTS_FACT_CATALOG_CONTRACT,
  computeBundleFingerprint,
  sha256,
} = require("../scripts/catalog-bundle-contract.cjs");
const {
  stableStringify: stableStringifyV3,
} = require("../scripts/catalog-bundle-v3-contract.cjs");

const catalogPageId = "11111111-1111-4111-8111-111111111111";
const catalogSpaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const catalogUpdatedAt = "2026-08-20T00:00:00.000Z";

function missingConfigFile() {
  const error = new Error("missing");
  error.code = "ENOENT";
  throw error;
}

function createCatalogCall() {
  const argumentsValue = {
    contract: QTS_FACT_CATALOG_CONTRACT,
    catalogRootPageId: catalogPageId,
    environment: "prod",
    roots: [{ pageId: catalogPageId }],
    challenge: "diagnosis-unique-0001",
  };
  const markdown = [
    "---",
    "document_type: service_profile",
    "schema_version: service-profile.v2",
    "entity_id: service/example",
    "---",
    "# Example",
  ].join("\n");
  const page = {
    page_id: catalogPageId,
    title: "Example",
    parent_page_id: null,
    space_id: catalogSpaceId,
    updated_at: catalogUpdatedAt,
    content_sha256: sha256(markdown),
    front_matter: {
      document_type: "service_profile",
      schema_version: "service-profile.v2",
      entity_id: "service/example",
    },
    markdown,
  };
  const roots = [
    {
      selector: { page_id: catalogPageId },
      status: "resolved",
      page_id: catalogPageId,
      document_type: "service_profile",
      entity_id: "service/example",
    },
  ];
  const manifest = [
    {
      page_id: catalogPageId,
      updated_at: catalogUpdatedAt,
      content_sha256: page.content_sha256,
    },
  ];
  const fingerprint = computeBundleFingerprint({
    catalogRootPageId: catalogPageId,
    environment: argumentsValue.environment,
    roots,
    pages: manifest,
    edges: [],
    unresolvedReferences: [],
  });
  const result = {
    content: [{ type: "text", text: `Catalog bundle ${fingerprint}` }],
    structuredContent: {
      schema_version: CATALOG_BUNDLE_SCHEMA_VERSION,
      contract: QTS_FACT_CATALOG_CONTRACT,
      catalog_root: {
        page_id: catalogPageId,
        title: "Catalog",
        space_id: catalogSpaceId,
        updated_at: catalogUpdatedAt,
      },
      environment: argumentsValue.environment,
      roots,
      pages: [page],
      edges: [],
      unresolved_references: [],
      closure_complete: true,
      bundle_fingerprint: fingerprint,
      freshness_proof: {
        schema_version: CATALOG_FRESHNESS_SCHEMA_VERSION,
        challenge: argumentsValue.challenge,
        verified_at: "2026-08-20T00:00:01.000Z",
        isolation: "repeatable_read",
        read_only: true,
        page_manifest: manifest,
        bundle_fingerprint: fingerprint,
      },
    },
  };
  return { argumentsValue, result };
}

test("getConfig accepts only credential-free HTTPS URLs", () => {
  assert.equal(
    getConfig(
      { DOCMOST_MCP_URL: "https://docs.example.com/mcp" },
      missingConfigFile,
    ).remoteUrl,
    "https://docs.example.com/mcp",
  );
  assert.throws(
    () =>
      getConfig(
        { DOCMOST_MCP_URL: "http://docs.example.com/mcp" },
        missingConfigFile,
      ),
    /HTTPS/,
  );
  assert.throws(
    () =>
      getConfig(
        { DOCMOST_MCP_URL: "https://user@example.com/mcp" },
        missingConfigFile,
      ),
    /credential-free/,
  );
  assert.throws(() => getConfig({}, missingConfigFile), /DOCMOST_MCP_URL/);
  assert.throws(
    () =>
      getConfig(
        { DOCMOST_MCP_URL: "https://docs.example.com/mcp?token=secret" },
        missingConfigFile,
      ),
    /without query or fragment/,
  );
});

test("getConfig reads non-secret settings from the config file", () => {
  const config = getConfig(
    { DOCMOST_CONFIG_FILE: "/tmp/docmost-config.json" },
    () =>
      JSON.stringify({
        mcpUrl: "https://docs.example.com/mcp",
        keychainService: "Docmost MCP",
        keychainAccount: "user@example.com",
      }),
  );

  assert.deepEqual(config, {
    profileName: "default",
    remoteUrl: "https://docs.example.com/mcp",
    keychainService: "Docmost MCP",
    keychainAccount: "user@example.com",
    requestTimeoutMs: 90_000,
    maxReadRetries: 1,
    retryDelayMs: 250,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    catalogMaxResolutionWindowMs: 120_000,
  });
});

test("getConfig selects a profile and applies shared and environment settings", () => {
  const config = getConfig(
    {
      DOCMOST_CONFIG_FILE: "/tmp/docmost-config.json",
      DOCMOST_PROFILE: "company-test",
      DOCMOST_REQUEST_TIMEOUT_MS: "120000",
    },
    () =>
      JSON.stringify({
        defaultProfile: "personal",
        maxReadRetries: 2,
        profiles: {
          personal: {
            mcpUrl: "https://docs.example.com/mcp",
            keychainService: "Docmost Personal",
            keychainAccount: "user@example.com",
          },
          "company-test": {
            mcpUrl: "https://docs.test.example.com/mcp",
            keychainService: "Docmost Company Test",
            keychainAccount: "user@example.com",
          },
        },
      }),
  );

  assert.deepEqual(config, {
    profileName: "company-test",
    remoteUrl: "https://docs.test.example.com/mcp",
    keychainService: "Docmost Company Test",
    keychainAccount: "user@example.com",
    requestTimeoutMs: 120_000,
    maxReadRetries: 2,
    retryDelayMs: 250,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    catalogMaxResolutionWindowMs: 120_000,
  });
});

test("resolveProfile requires an explicit selection for multiple profiles", () => {
  assert.throws(
    () =>
      resolveProfile(
        {
          profiles: {
            personal: { mcpUrl: "https://docs.example.com/mcp" },
            company: { mcpUrl: "https://docs.company.example.com/mcp" },
          },
        },
        {},
      ),
    /DOCMOST_PROFILE or defaultProfile/,
  );
});

test("getConfig rejects bearer tokens stored in JSON", () => {
  assert.throws(
    () =>
      getConfig({ DOCMOST_CONFIG_FILE: "/tmp/docmost-config.json" }, () =>
        JSON.stringify({
          mcpUrl: "https://docs.example.com/mcp",
          token: "must-not-be-stored-here",
        }),
      ),
    /Do not store bearer tokens/,
  );
  assert.throws(
    () =>
      getConfig(
        {
          DOCMOST_CONFIG_FILE: "/tmp/docmost-config.json",
          DOCMOST_PROFILE: "personal",
        },
        () =>
          JSON.stringify({
            profiles: {
              personal: {
                mcpUrl: "https://docs.example.com/mcp",
              },
              company: {
                mcpUrl: "https://docs.company.example.com/mcp",
                bearerToken: "must-not-be-stored-in-another-profile",
              },
            },
          }),
      ),
    /Do not store bearer tokens/,
  );
});

test("parseIntegerSetting enforces operational limits", () => {
  assert.equal(parseIntegerSetting(undefined, "timeout", 10, 1, 20), 10);
  assert.equal(parseIntegerSetting("15", "timeout", 10, 1, 20), 15);
  assert.throws(
    () => parseIntegerSetting("21", "timeout", 10, 1, 20),
    /between 1 and 20/,
  );
  assert.throws(
    () => parseIntegerSetting("1.5", "timeout", 10, 1, 20),
    /integer/,
  );
});

test("parseCatalogPublicKeys accepts Ed25519 pins and rejects malformed keys", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const encoded = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url");

  assert.deepEqual(
    parseCatalogPublicKeys(
      JSON.stringify({ "catalog-ed25519-current": encoded }),
    ),
    { "catalog-ed25519-current": encoded },
  );
  assert.throws(
    () => parseCatalogPublicKeys('{"catalog-ed25519-current":"bad"}'),
    /invalid key/,
  );
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64url");
  assert.throws(
    () => parseCatalogPublicKeys({ "catalog-rsa": rsa }),
    /Ed25519/,
  );
});

test("getConfig reads profile-level Catalog signing-key pins", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const encoded = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url");
  const config = getConfig(
    { DOCMOST_CONFIG_FILE: "/tmp/docmost-config.json" },
    () =>
      JSON.stringify({
        mcpUrl: "https://docs.example.com/mcp",
        keychainService: "Docmost MCP",
        keychainAccount: "user@example.com",
        catalogPublicKeys: { "catalog-ed25519-current": encoded },
      }),
  );

  assert.deepEqual(config.catalogPublicKeys, {
    "catalog-ed25519-current": encoded,
  });
});

test("readConfigFile rejects malformed configuration", () => {
  assert.throws(
    () => readConfigFile("/tmp/docmost-config.json", () => "not json"),
    /valid JSON/,
  );
  assert.throws(
    () => readConfigFile("/tmp/docmost-config.json", () => "[]"),
    /object/,
  );
});

test("readTokenFromKeychain uses configured service and account", () => {
  const calls = [];
  const token = readTokenFromKeychain(
    { keychainService: "service", keychainAccount: "account" },
    (...args) => {
      calls.push(args);
      return "a-secure-token-value-for-tests\n";
    },
  );

  assert.equal(token, "a-secure-token-value-for-tests");
  assert.deepEqual(calls[0][1], [
    "find-generic-password",
    "-w",
    "-s",
    "service",
    "-a",
    "account",
  ]);
});

test("resolveToken prefers the environment and falls back to Keychain", () => {
  assert.equal(
    resolveToken(
      {},
      { DOCMOST_MCP_TOKEN: "an-environment-token-for-tests" },
      () => assert.fail("Keychain should not be used"),
    ),
    "an-environment-token-for-tests",
  );

  assert.equal(
    resolveToken(
      { keychainService: "service", keychainAccount: "account" },
      {},
      () => "a-keychain-token-value-for-tests\n",
    ),
    "a-keychain-token-value-for-tests",
  );
});

test("createForward keeps the MCP process available after local startup failure", async () => {
  const { forward, startupError } = createForward(() => {
    throw new Error("Docmost MCP token is unavailable in macOS Keychain");
  });

  assert.equal(
    startupError.message,
    "Docmost MCP token is unavailable in macOS Keychain",
  );

  const response = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
    forward,
  );

  assert.equal(response.error.code, ErrorCode.InternalError);
  assert.equal(
    response.error.message,
    "Docmost MCP token is unavailable in macOS Keychain",
  );
});

test("initialize is handled locally", async () => {
  const result = await dispatchRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
    () => assert.fail("initialize must not be forwarded"),
  );

  assert.equal(result.protocolVersion, "2025-11-25");
  assert.equal(result.serverInfo.name, "docmost-knowledge");
  assert.equal(result.serverInfo.version, "0.7.0");
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
});

test("initialize falls back to the proxy protocol for unknown versions", async () => {
  const result = await dispatchRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-01-01" },
    },
    () => assert.fail("initialize must not be forwarded"),
  );

  assert.equal(result.protocolVersion, "2025-11-25");
});

test("notifications are ignored without forwarding", async () => {
  const result = await dispatchRequest(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    () => assert.fail("notifications must not be forwarded"),
  );
  assert.equal(result, null);
});

test("tools/list validates and returns the remote tool list", async () => {
  const calls = [];
  const result = await dispatchRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    async (...args) => {
      calls.push(args);
      return { tools: [{ name: "list_spaces" }] };
    },
  );

  assert.deepEqual(calls, [["tools/list", {}]]);
  assert.deepEqual(result.tools, [{ name: "list_spaces" }]);
});

test("tools/call rejects malformed arguments before forwarding", async () => {
  await assert.rejects(
    dispatchRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_page", arguments: [] },
      },
      () => assert.fail("invalid calls must not be forwarded"),
    ),
    (error) => error.code === ErrorCode.InvalidParams,
  );
});

test("tools/call validates Catalog input and output around forwarding", async () => {
  const { argumentsValue, result } = createCatalogCall();
  const calls = [];
  const accepted = await dispatchRequest(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "resolve_catalog_bundle",
        arguments: argumentsValue,
      },
    },
    async (...args) => {
      calls.push(args);
      return result;
    },
  );

  assert.equal(accepted, result);
  assert.deepEqual(calls, [
    [
      "tools/call",
      { name: "resolve_catalog_bundle", arguments: argumentsValue },
    ],
  ]);

  await assert.rejects(
    dispatchRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "resolve_catalog_bundle",
          arguments: { ...argumentsValue, challenge: "short" },
        },
      },
      () => assert.fail("invalid Catalog input must not be forwarded"),
    ),
    (error) => error.code === ErrorCode.InvalidParams,
  );

  const tampered = structuredClone(result);
  tampered.structuredContent.pages[0].markdown += "\ntampered";
  await assert.rejects(
    dispatchRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "resolve_catalog_bundle",
          arguments: argumentsValue,
        },
      },
      async () => tampered,
    ),
    (error) =>
      error.code === ErrorCode.InternalError &&
      /response validation failed/.test(error.message),
  );
});

test("tools/call enforces Catalog v2 validation at the proxy boundary", async () => {
  const argumentsValue = {
    contract: "qts-fact-catalog.v1",
    catalogRootPageId: catalogPageId,
    environment: "prod",
    roots: [{ pageId: catalogPageId }],
    challenge: "diagnosis-unique-v2-0001",
  };
  const { publicKey } = generateKeyPairSync("ed25519");
  const encodedPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url");
  const invalidResponseForward = async () => ({
    content: [{ type: "text", text: "invalid v2 response" }],
    structuredContent: {},
  });
  invalidResponseForward.catalogPublicKeys = {
    "catalog-ed25519-current": encodedPublicKey,
  };
  const neverForward = () =>
    assert.fail("invalid Catalog v2 input must not be forwarded");
  neverForward.catalogPublicKeys = invalidResponseForward.catalogPublicKeys;

  await assert.rejects(
    dispatchRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "resolve_catalog_bundle_v2",
          arguments: { ...argumentsValue, challenge: "short" },
        },
      },
      neverForward,
    ),
    (error) => error.code === ErrorCode.InvalidParams,
  );

  await assert.rejects(
    dispatchRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "resolve_catalog_bundle_v2",
          arguments: argumentsValue,
        },
      },
      invalidResponseForward,
    ),
    (error) =>
      error.code === ErrorCode.InternalError &&
      /Catalog v2 response validation failed/.test(error.message),
  );
});

test("tools/call validates a pinned Catalog v3 start ticket", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url");
  const challenge = "diagnosis-v3-ticket-0001";
  const issuedAt = new Date(Date.now() - 100).toISOString();
  const unsigned = {
    schema_version: "catalog-resolution-ticket.v1",
    signature_algorithm: "ed25519",
    public_key_format: "spki-der-base64url",
    public_key: publicKeyEncoded,
    key_id: "catalog-ed25519-current",
    ticket_id: "66666666-6666-4666-8666-666666666666",
    issued_at: issuedAt,
    expires_at: new Date(Date.parse(issuedAt) + 120_000).toISOString(),
    challenge,
    catalog_root_page_id: catalogPageId,
    environment: "prod",
    authorization_context_sha256: "a".repeat(64),
  };
  const ticket = {
    ...unsigned,
    signature: signBytes(
      null,
      Buffer.from(stableStringifyV3(unsigned), "utf8"),
      privateKey,
    ).toString("base64url"),
  };
  const forward = async () => ({
    content: [{ type: "text", text: "Catalog resolution ticket" }],
    structuredContent: ticket,
  });
  forward.catalogPublicKeys = {
    "catalog-ed25519-current": publicKeyEncoded,
  };
  forward.catalogMaxResolutionWindowMs = 120_000;

  const response = await dispatchRequest(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "begin_catalog_resolution",
        arguments: {
          contract: "qts-fact-catalog.v1",
          catalogRootPageId: catalogPageId,
          environment: "prod",
          challenge,
        },
      },
    },
    forward,
  );
  assert.equal(response.structuredContent.ticket_id, ticket.ticket_id);
});

test("handleLine returns a JSON-RPC parse error", async () => {
  const response = await handleLine("not json", () => undefined);
  assert.equal(response.id, null);
  assert.equal(response.error.code, ErrorCode.ParseError);
});

test("callRemote sends a bearer token without exposing it in errors", async () => {
  const requests = [];
  const result = await callRemote(
    { remoteUrl: "https://docs.example.com/mcp" },
    "secret-token-value-for-tests",
    "tools/list",
    {},
    async (...args) => {
      requests.push(args);
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { tools: [] } }),
      };
    },
  );

  assert.deepEqual(result, { tools: [] });
  assert.equal(requests[0][1].redirect, "error");
  assert.equal(
    requests[0][1].headers.Authorization,
    "Bearer secret-token-value-for-tests",
  );
  assert.equal(requests[0][1].headers["MCP-Protocol-Version"], "2025-06-18");

  await assert.rejects(
    callRemote(
      { remoteUrl: "https://docs.example.com/mcp" },
      "secret-token-value-for-tests",
      "tools/list",
      {},
      async () => ({
        ok: false,
        status: 401,
        json: async () => {
          throw new Error("not json");
        },
      }),
    ),
    (error) =>
      error.message === "Docmost MCP authentication or authorization failed" &&
      !error.message.includes("secret-token-value-for-tests"),
  );
});

test("readBoundedJsonResponse enforces declared and streamed limits", async () => {
  await assert.rejects(
    readBoundedJsonResponse(
      new Response(JSON.stringify({ result: { tools: [] } }), {
        headers: { "content-length": "2048" },
      }),
      1024,
    ),
    /exceeds the 1024-byte plugin limit/,
  );

  await assert.rejects(
    readBoundedJsonResponse(
      new Response(JSON.stringify({ value: "x".repeat(2048) })),
      1024,
    ),
    /exceeds the 1024-byte plugin limit/,
  );

  assert.deepEqual(
    await readBoundedJsonResponse(
      new Response(JSON.stringify({ result: { ok: true } })),
      1024,
    ),
    { result: { ok: true } },
  );
});

test("callRemote preserves safe JSON-RPC errors on non-2xx responses", async () => {
  await assert.rejects(
    callRemote(
      {
        remoteUrl: "https://docs.example.com/mcp",
        maxReadRetries: 0,
      },
      "secret-token-value-for-tests",
      "tools/list",
      {},
      async () => ({
        ok: false,
        status: 429,
        headers: { get: () => "8" },
        json: async () => ({
          error: {
            code: -32029,
            message: "MCP rate limit exceeded; retry after 8s",
          },
        }),
      }),
    ),
    (error) =>
      error.code === -32029 &&
      error.message === "MCP rate limit exceeded; retry after 8s",
  );
});

test("callRemote hides JSON error details for authentication failures", async () => {
  await assert.rejects(
    callRemote(
      {
        remoteUrl: "https://docs.example.com/mcp",
        maxReadRetries: 0,
      },
      "secret-token-value-for-tests",
      "tools/list",
      {},
      async () => ({
        ok: false,
        status: 401,
        json: async () => ({
          error: {
            code: -32001,
            message: "internal authentication detail",
          },
        }),
      }),
    ),
    (error) =>
      error.message === "Docmost MCP authentication or authorization failed",
  );
});

test("callRemote redacts credentials echoed by a remote error", async () => {
  const token = "secret-token-value-for-tests";
  await assert.rejects(
    callRemote(
      {
        remoteUrl: "https://docs.example.com/mcp",
        maxReadRetries: 0,
      },
      token,
      "tools/list",
      {},
      async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: -32602,
            message: `bad header Bearer ${token}`,
          },
        }),
      }),
    ),
    (error) =>
      error.message.includes("[redacted-token]") &&
      !error.message.includes(token),
  );

  await assert.rejects(
    callRemote(
      {
        remoteUrl: "https://docs.example.com/mcp",
        maxReadRetries: 0,
      },
      token,
      "tools/list",
      {},
      async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: -32602,
            message: `${"x".repeat(495)}${token}`,
          },
        }),
      }),
    ),
    (error) =>
      !error.message.includes(token) &&
      !error.message.endsWith(token.slice(0, 5)),
  );
});

test("callRemote retries a transient read failure once", async () => {
  const calls = [];
  const sleeps = [];
  const result = await callRemote(
    {
      remoteUrl: "https://docs.example.com/mcp",
      maxReadRetries: 1,
      retryDelayMs: 25,
    },
    "secret-token-value-for-tests",
    "tools/list",
    {},
    async () => {
      calls.push("fetch");
      if (calls.length === 1) {
        return {
          ok: false,
          status: 503,
          json: async () => {
            throw new Error("not json");
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { tools: [] } }),
      };
    },
    async (delayMs) => sleeps.push(delayMs),
  );

  assert.deepEqual(result, { tools: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [25]);
});

test("callRemote never automatically retries a mutation", async () => {
  let calls = 0;
  await assert.rejects(
    callRemote(
      {
        remoteUrl: "https://docs.example.com/mcp",
        maxReadRetries: 3,
        retryDelayMs: 0,
      },
      "secret-token-value-for-tests",
      "tools/call",
      {
        name: "update_page",
        arguments: {
          pageId: "11111111-1111-4111-8111-111111111111",
          expectedUpdatedAt: "2026-07-28T00:00:00.000Z",
          idempotencyKey: "stable-key",
        },
      },
      async () => {
        calls += 1;
        return {
          ok: false,
          status: 503,
          json: async () => {
            throw new Error("not json");
          },
        };
      },
      async () => assert.fail("mutation retry delay must not run"),
    ),
    /HTTP 503/,
  );
  assert.equal(calls, 1);
});

test("callRemote never replays a challenge-consuming Catalog v2 request", async () => {
  let calls = 0;
  await assert.rejects(
    callRemote(
      {
        remoteUrl: "https://docs.example.com/mcp",
        maxReadRetries: 3,
        retryDelayMs: 0,
      },
      "secret-token-value-for-tests",
      "tools/call",
      {
        name: "resolve_catalog_bundle_v2",
        arguments: {
          contract: "qts-fact-catalog.v1",
          catalogRootPageId: "11111111-1111-4111-8111-111111111111",
          environment: "prod",
          roots: [{ pageId: "22222222-2222-4222-8222-222222222222" }],
          challenge: "diagnosis-unique-v2-retry",
        },
      },
      async () => {
        calls += 1;
        return {
          ok: false,
          status: 503,
          json: async () => {
            throw new Error("not json");
          },
        };
      },
      async () => assert.fail("Catalog v2 retry delay must not run"),
    ),
    /HTTP 503/,
  );
  assert.equal(calls, 1);
});

test("callRemote does not retry after the request timeout is exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    callRemote(
      {
        remoteUrl: "https://docs.example.com/mcp",
        requestTimeoutMs: 1,
        maxReadRetries: 3,
        retryDelayMs: 0,
      },
      "secret-token-value-for-tests",
      "tools/list",
      {},
      async (_url, options) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(options.signal.aborted, true);
        throw new Error("timed out");
      },
      async () => assert.fail("timeout retry delay must not run"),
    ),
    /transport request failed/,
  );
  assert.equal(calls, 1);
});
