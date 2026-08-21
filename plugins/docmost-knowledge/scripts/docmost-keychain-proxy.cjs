#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { createPublicKey } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { isRetrySafe } = require("./tool-contract.cjs");
const {
  CATALOG_TOOLS,
  CatalogValidationError,
  validateCatalogToolInput,
  validateCatalogToolResult,
} = require("./catalog-bundle-contract.cjs");
const {
  CATALOG_V2_TOOLS,
  CatalogV2ValidationError,
  validateCatalogV2ToolInput,
  validateCatalogV2ToolResult,
} = require("./catalog-bundle-v2-contract.cjs");

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "docmost-knowledge",
  "config.json",
);
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_READ_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const SERVER_VERSION = "0.6.0";
const PROXY_PROTOCOL_VERSION = "2025-11-25";
const REMOTE_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  PROXY_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  "2025-03-26",
]);
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);

const ErrorCode = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
});

let remoteRequestId = 0;

class RpcError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfigFile(configPath, readFile = fs.readFileSync) {
  let source;
  try {
    source = readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error("Unable to read the Docmost Knowledge config file");
  }

  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error("Docmost Knowledge config file is not valid JSON");
  }
  if (!isObject(config)) {
    throw new Error("Docmost Knowledge config file must contain an object");
  }
  return config;
}

function getConfig(env = process.env, readFile = fs.readFileSync) {
  const configPath = env.DOCMOST_CONFIG_FILE || DEFAULT_CONFIG_PATH;
  const fileConfig = readConfigFile(configPath, readFile);
  const { profileName, profile } = resolveProfile(fileConfig, env);
  rejectStoredToken(fileConfig);

  const remoteUrlValue = env.DOCMOST_MCP_URL || profile.mcpUrl;
  if (typeof remoteUrlValue !== "string" || !remoteUrlValue.trim()) {
    throw new Error(
      "Set DOCMOST_MCP_URL or mcpUrl for the selected Docmost profile",
    );
  }

  let remoteUrl;
  try {
    remoteUrl = new URL(remoteUrlValue);
  } catch {
    throw new Error("Docmost MCP URL is invalid");
  }
  if (
    remoteUrl.protocol !== "https:" ||
    remoteUrl.username ||
    remoteUrl.password ||
    remoteUrl.search ||
    remoteUrl.hash
  ) {
    throw new Error(
      "Docmost MCP URL must be a credential-free HTTPS URL without query or fragment",
    );
  }

  const catalogPublicKeys = parseCatalogPublicKeys(
    env.DOCMOST_CATALOG_PUBLIC_KEYS ?? profile.catalogPublicKeys,
  );
  return {
    profileName,
    remoteUrl: remoteUrl.toString(),
    keychainService: optionalString(
      env.DOCMOST_KEYCHAIN_SERVICE || profile.keychainService,
    ),
    keychainAccount: optionalString(
      env.DOCMOST_KEYCHAIN_ACCOUNT || profile.keychainAccount,
    ),
    requestTimeoutMs: parseIntegerSetting(
      env.DOCMOST_REQUEST_TIMEOUT_MS ?? profile.requestTimeoutMs,
      "requestTimeoutMs",
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      MAX_REQUEST_TIMEOUT_MS,
    ),
    maxReadRetries: parseIntegerSetting(
      env.DOCMOST_MAX_READ_RETRIES ?? profile.maxReadRetries,
      "maxReadRetries",
      DEFAULT_MAX_READ_RETRIES,
      0,
      3,
    ),
    retryDelayMs: parseIntegerSetting(
      env.DOCMOST_RETRY_DELAY_MS ?? profile.retryDelayMs,
      "retryDelayMs",
      DEFAULT_RETRY_DELAY_MS,
      0,
      5_000,
    ),
    maxResponseBytes: parseIntegerSetting(
      env.DOCMOST_MAX_RESPONSE_BYTES ?? profile.maxResponseBytes,
      "maxResponseBytes",
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      MAX_RESPONSE_BYTES,
    ),
    ...(catalogPublicKeys ? { catalogPublicKeys } : {}),
  };
}

function resolveProfile(fileConfig, env) {
  if (fileConfig.profiles === undefined) {
    return {
      profileName: optionalString(env.DOCMOST_PROFILE) || "default",
      profile: fileConfig,
    };
  }
  if (!isObject(fileConfig.profiles)) {
    throw new Error("Docmost Knowledge profiles must contain an object");
  }

  const profileNames = Object.keys(fileConfig.profiles);
  const selectedProfile =
    optionalString(env.DOCMOST_PROFILE) ||
    optionalString(fileConfig.defaultProfile) ||
    (profileNames.length === 1 ? profileNames[0] : undefined);
  if (!selectedProfile) {
    throw new Error(
      "Set DOCMOST_PROFILE or defaultProfile when multiple profiles exist",
    );
  }

  const selectedConfig = fileConfig.profiles[selectedProfile];
  if (!isObject(selectedConfig)) {
    throw new Error(`Unknown Docmost Knowledge profile: ${selectedProfile}`);
  }

  const {
    profiles: _profiles,
    defaultProfile: _defaultProfile,
    ...sharedConfig
  } = fileConfig;
  return {
    profileName: selectedProfile,
    profile: { ...sharedConfig, ...selectedConfig },
  };
}

function rejectStoredToken(fileConfig) {
  const queue = [fileConfig];
  const forbiddenKeys = new Set(["token", "mcptoken", "bearertoken"]);

  while (queue.length > 0) {
    const candidate = queue.pop();
    if (!isObject(candidate)) continue;

    for (const [key, value] of Object.entries(candidate)) {
      if (forbiddenKeys.has(key.toLowerCase())) {
        throw new Error(
          "Do not store bearer tokens in the Docmost Knowledge config file",
        );
      }
      if (isObject(value)) queue.push(value);
    }
  }
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCatalogPublicKeys(value) {
  if (value === undefined || value === null || value === "") return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("DOCMOST_CATALOG_PUBLIC_KEYS must be valid JSON");
    }
  }
  if (!isObject(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("catalogPublicKeys must be a non-empty object");
  }
  for (const [keyId, publicKey] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId) ||
      typeof publicKey !== "string" ||
      publicKey.length < 32
    ) {
      throw new Error("catalogPublicKeys contains an invalid key");
    }
    let decoded;
    let keyObject;
    try {
      decoded = Buffer.from(publicKey, "base64url");
      if (decoded.toString("base64url") !== publicKey) {
        throw new Error("non-canonical base64url");
      }
      keyObject = createPublicKey({
        key: decoded,
        format: "der",
        type: "spki",
      });
    } catch {
      throw new Error("catalogPublicKeys contains an invalid public key");
    }
    if (keyObject.asymmetricKeyType !== "ed25519") {
      throw new Error("catalogPublicKeys must contain Ed25519 public keys");
    }
  }
  return { ...parsed };
}

function parseIntegerSetting(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function readTokenFromKeychain(config, exec = execFileSync) {
  let token;
  try {
    token = exec(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-w",
        "-s",
        config.keychainService,
        "-a",
        config.keychainAccount,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error("Docmost MCP token is unavailable in macOS Keychain");
  }

  if (token.length < 20) {
    throw new Error("Docmost MCP token in macOS Keychain is invalid");
  }
  return token;
}

function resolveToken(config, env = process.env, exec = execFileSync) {
  const environmentToken = env.DOCMOST_MCP_TOKEN?.trim();
  if (environmentToken) {
    if (environmentToken.length < 20) {
      throw new Error("DOCMOST_MCP_TOKEN is invalid");
    }
    return environmentToken;
  }

  if (!config.keychainService || !config.keychainAccount) {
    throw new Error(
      "Set DOCMOST_MCP_TOKEN or configure keychainService and keychainAccount",
    );
  }
  return readTokenFromKeychain(config, exec);
}

async function callRemote(
  config,
  token,
  method,
  params,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
) {
  const retries = isRetrySafe(method, params)
    ? (config.maxReadRetries ?? DEFAULT_MAX_READ_RETRIES)
    : 0;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await callRemoteOnce(config, token, method, params, fetchImpl);
    } catch (error) {
      if (
        !(error instanceof RpcError) ||
        !error.retryable ||
        attempt >= retries
      ) {
        throw error;
      }
      await sleep(
        (config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * (attempt + 1),
      );
    }
  }

  throw new RpcError(ErrorCode.InternalError, "Docmost MCP request failed");
}

async function callRemoteOnce(config, token, method, params, fetchImpl) {
  const signal = AbortSignal.timeout(
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  let response;
  try {
    response = await fetchImpl(config.remoteUrl, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": REMOTE_PROTOCOL_VERSION,
        "User-Agent": `docmost-knowledge-codex-plugin/${SERVER_VERSION}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `docmost-plugin-${process.pid}-${++remoteRequestId}`,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
  } catch {
    throw new RpcError(
      ErrorCode.InternalError,
      "Docmost MCP transport request failed",
      { retryable: !signal.aborted },
    );
  }

  let payload;
  try {
    payload = await readBoundedJsonResponse(
      response,
      config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (!response.ok) {
      throw createHttpError(response);
    }
    throw new RpcError(
      ErrorCode.InternalError,
      "Docmost MCP returned an invalid JSON response",
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw createHttpError(response);
    }
    if (isObject(payload?.error)) {
      throw createPayloadError(payload.error, response, token);
    }
    throw createHttpError(response);
  }

  if (isObject(payload.error)) {
    throw createPayloadError(payload.error, response, token);
  }
  if (!isObject(payload.result)) {
    throw new RpcError(
      ErrorCode.InternalError,
      "Docmost MCP response is missing a result",
    );
  }
  return payload.result;
}

async function readBoundedJsonResponse(response, maxBytes) {
  const contentLengthValue = response.headers?.get?.("content-length");
  if (contentLengthValue !== null && contentLengthValue !== undefined) {
    const contentLength = Number(contentLengthValue);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw responseTooLargeError(maxBytes);
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw responseTooLargeError(maxBytes);
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(
        ErrorCode.InternalError,
        "Docmost MCP response stream failed",
        { retryable: true },
      );
    }
    return parseBoundedJson(Buffer.concat(chunks).toString("utf8"));
  }

  if (typeof response.text === "function") {
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > maxBytes) {
      throw responseTooLargeError(maxBytes);
    }
    return parseBoundedJson(source);
  }

  if (typeof response.json === "function") {
    const value = await response.json();
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
      throw responseTooLargeError(maxBytes);
    }
    return value;
  }

  throw new Error("Response body is unavailable");
}

function parseBoundedJson(source) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Response body is not valid JSON");
  }
}

function responseTooLargeError(maxBytes) {
  return new RpcError(
    -32013,
    `Docmost MCP response exceeds the ${maxBytes}-byte plugin limit`,
  );
}

function createPayloadError(error, response, token) {
  const code = Number.isInteger(error.code)
    ? error.code
    : ErrorCode.InternalError;
  let message =
    typeof error.message === "string"
      ? sanitizeRemoteMessage(error.message, token)
      : "Docmost MCP request failed";
  if (response.status === 429 && !/retry/i.test(message)) {
    const retryAfter = response.headers?.get?.("retry-after");
    if (retryAfter) message = `${message}; retry after ${retryAfter}`;
  }
  return new RpcError(code, message, {
    retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
  });
}

function sanitizeRemoteMessage(message, token) {
  let sanitized = String(message);
  if (token) {
    sanitized = sanitized.split(token).join("[redacted-token]");
  }
  sanitized = sanitized.replace(
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    "Bearer [redacted-token]",
  );
  return sanitized.slice(0, 500);
}

function createHttpError(response) {
  const status = Number(response.status);
  if (status === 401 || status === 403) {
    return new RpcError(
      ErrorCode.InternalError,
      "Docmost MCP authentication or authorization failed",
    );
  }
  if (status === 429) {
    const retryAfter = response.headers?.get?.("retry-after");
    return new RpcError(
      -32029,
      `Docmost MCP rate limit exceeded${
        retryAfter ? `; retry after ${retryAfter}` : ""
      }`,
    );
  }
  return new RpcError(
    ErrorCode.InternalError,
    `Docmost MCP returned HTTP ${status}`,
    { retryable: RETRYABLE_HTTP_STATUSES.has(status) },
  );
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function formatStartupError(error) {
  const message =
    error instanceof Error ? error.message : "Docmost MCP local startup failed";
  return sanitizeRemoteMessage(message);
}

function createForward(
  getConfigFn = () => getConfig(),
  resolveTokenFn = (config) => resolveToken(config),
  callRemoteFn = callRemote,
) {
  try {
    const config = getConfigFn();
    const token = resolveTokenFn(config);
    const forward = (method, params) =>
      callRemoteFn(config, token, method, params);
    forward.catalogPublicKeys = config.catalogPublicKeys;
    return {
      forward,
      startupError: null,
    };
  } catch (error) {
    const startupError = new RpcError(
      ErrorCode.InternalError,
      formatStartupError(error),
    );
    return {
      forward: async () => {
        throw startupError;
      },
      startupError,
    };
  }
}

async function dispatchRequest(message, forward) {
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    throw new RpcError(ErrorCode.InvalidRequest, "Invalid JSON-RPC request");
  }

  if (typeof message.method !== "string" || !message.method) {
    throw new RpcError(ErrorCode.InvalidRequest, "Request method is required");
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return null;
  }

  switch (message.method) {
    case "initialize": {
      const requestedVersion = message.params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
          ? requestedVersion
          : PROXY_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "docmost-knowledge",
          version: SERVER_VERSION,
        },
        instructions:
          "Use Docmost tools according to the docmost-knowledge skill and server-side space permissions.",
      };
    }
    case "ping":
      return {};
    case "tools/list": {
      const result = await forward("tools/list", message.params);
      if (!Array.isArray(result.tools)) {
        throw new RpcError(
          ErrorCode.InternalError,
          "Docmost MCP tools/list returned no tools",
        );
      }
      return result;
    }
    case "tools/call": {
      if (
        !isObject(message.params) ||
        typeof message.params.name !== "string" ||
        !message.params.name ||
        (message.params.arguments !== undefined &&
          !isObject(message.params.arguments))
      ) {
        throw new RpcError(ErrorCode.InvalidParams, "Invalid tool call");
      }
      if (CATALOG_TOOLS.includes(message.params.name)) {
        try {
          validateCatalogToolInput(
            message.params.name,
            message.params.arguments,
          );
        } catch (error) {
          if (error instanceof CatalogValidationError) {
            throw new RpcError(ErrorCode.InvalidParams, error.message);
          }
          throw error;
        }
      }
      if (CATALOG_V2_TOOLS.includes(message.params.name)) {
        try {
          validateCatalogV2ToolInput(
            message.params.name,
            message.params.arguments,
            { trustedPublicKeys: forward.catalogPublicKeys },
          );
        } catch (error) {
          if (error instanceof CatalogV2ValidationError) {
            throw new RpcError(ErrorCode.InvalidParams, error.message);
          }
          throw error;
        }
      }
      const result = await forward("tools/call", message.params);
      if (CATALOG_TOOLS.includes(message.params.name)) {
        try {
          validateCatalogToolResult(
            message.params.name,
            message.params.arguments,
            result,
          );
        } catch (error) {
          if (error instanceof CatalogValidationError) {
            throw new RpcError(
              ErrorCode.InternalError,
              `Docmost Catalog response validation failed: ${error.message}`,
            );
          }
          throw error;
        }
      }
      if (CATALOG_V2_TOOLS.includes(message.params.name)) {
        try {
          validateCatalogV2ToolResult(
            message.params.name,
            message.params.arguments,
            result,
            { trustedPublicKeys: forward.catalogPublicKeys },
          );
        } catch (error) {
          if (error instanceof CatalogV2ValidationError) {
            throw new RpcError(
              ErrorCode.InternalError,
              `Docmost Catalog v2 response validation failed: ${error.message}`,
            );
          }
          throw error;
        }
      }
      return result;
    }
    default:
      throw new RpcError(
        ErrorCode.MethodNotFound,
        `Unsupported MCP method: ${message.method}`,
      );
  }
}

function serializeSuccess(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function serializeError(id, error) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: error instanceof RpcError ? error.code : ErrorCode.InternalError,
      message:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Docmost MCP request failed",
    },
  };
}

async function handleLine(line, forward) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return serializeError(
      null,
      new RpcError(ErrorCode.ParseError, "Invalid JSON"),
    );
  }

  const id = isObject(message) && "id" in message ? message.id : null;
  try {
    const result = await dispatchRequest(message, forward);
    return result === null ? null : serializeSuccess(id, result);
  } catch (error) {
    return serializeError(id, error);
  }
}

async function main() {
  const { forward, startupError } = createForward();
  if (startupError) {
    process.stderr.write(
      `Docmost MCP proxy unavailable: ${startupError.message}\n`,
    );
  }
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of input) {
    if (!line.trim()) continue;
    const response = await handleLine(line, forward);
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `Docmost MCP proxy failed: ${formatStartupError(error)}\n`,
    );
    process.exitCode = 1;
  });
} else {
  module.exports = {
    DEFAULT_CONFIG_PATH,
    DEFAULT_MAX_RESPONSE_BYTES,
    ErrorCode,
    RpcError,
    callRemote,
    createForward,
    dispatchRequest,
    formatStartupError,
    getConfig,
    handleLine,
    parseIntegerSetting,
    parseCatalogPublicKeys,
    readConfigFile,
    readBoundedJsonResponse,
    readTokenFromKeychain,
    resolveProfile,
    resolveToken,
    serializeError,
    serializeSuccess,
  };
}
