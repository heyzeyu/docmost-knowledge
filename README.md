# Docmost Knowledge

An open-source Codex and WorkBuddy plugin for searching, templating, and
maintaining a private Docmost knowledge base through a permission-scoped MCP
endpoint.

The plugin gives Codex and WorkBuddy operational guidance for knowledge work
and runs a small local stdio proxy. The proxy reads a bearer token from macOS
Keychain or an environment variable, then forwards MCP requests over HTTPS.

> This community project is not affiliated with Docmost. Stock Docmost does
> not currently provide the compatible `/mcp` endpoint required by this
> plugin. You need a Docmost deployment with the matching server-side MCP
> implementation.

## Features

- Permission-aware discovery of spaces and pages
- Keyword, semantic, and hybrid search, including one page subtree
- Page creation, updates, append operations, and deletion safeguards with
  mandatory idempotency and optimistic concurrency
- Ordered page-tree inspection plus signed, cycle-safe single and atomic batch
  moves within a knowledge space
- AI-first published-template discovery, preview, instantiation, authoring,
  publication, archival, and deletion
- Version inspection, comparison, and confirmed restoration
- Attachment listing, upload, download, and confirmed deletion
- Vector-index workflows exposed by the compatible server
- Personal and company profiles with isolated endpoints and Keychain entries
- Safe retry of known read-only tools that do not consume one-use challenges
- Optional signed Catalog Bundle v2 and trusted Delta consumption for
  diagnostic orchestrators, with immutable v1 compatibility
- Ed25519 proof verification with optional per-profile public-key pinning
- A strict v0.6 core and optional-extension contract doctor and live smoke test
- Bounded remote response streaming with a 16 MiB default limit
- Local credential handling without storing secrets in the repository

All authorization decisions remain on the Docmost server. The plugin never
broadens the token's space permissions.

## Requirements

- Codex or Tencent WorkBuddy with plugin support
- Node.js 20 or newer
- A credential-free HTTPS MCP endpoint compatible with this plugin
- A bearer token issued by that server
- macOS Keychain, or the `DOCMOST_MCP_TOKEN` environment variable

## Install

### Codex

Add this repository as a Codex marketplace and install its plugin:

```bash
codex plugin marketplace add wzyonline-1999/docmost-knowledge
codex plugin add docmost-knowledge@open-context
```

Restart Codex after installation.

### WorkBuddy

Add this GitHub repository as a WorkBuddy/CodeBuddy plugin marketplace, then
install `docmost-knowledge@open-context` and reload plugins:

```bash
/plugin marketplace add wzyonline-1999/docmost-knowledge
/plugin install docmost-knowledge@open-context
/reload-plugins
```

The WorkBuddy package uses the same `SKILL.md`, MCP proxy, configuration file,
and Keychain entries as Codex. It has its own `.codebuddy-plugin` manifest and
MCP launcher so the two clients can resolve their plugin roots and the
WorkBuddy-managed Node runtime correctly.
Do not also configure a manual `docmost-knowledge` MCP entry in the same
client, or the tools will be registered twice.

## Configure

Create `~/.config/docmost-knowledge/config.json`. A multi-profile configuration
keeps personal and company credentials separate:

```json
{
  "defaultProfile": "personal",
  "requestTimeoutMs": 90000,
  "maxReadRetries": 1,
  "maxResponseBytes": 16777216,
  "profiles": {
    "personal": {
      "mcpUrl": "https://docs.example.com/mcp",
      "keychainService": "Docmost MCP Personal",
      "keychainAccount": "you@example.com"
    },
    "company-test": {
      "mcpUrl": "https://docs.test.example.com/mcp",
      "keychainService": "Docmost MCP Company Test",
      "keychainAccount": "you@example.com"
    }
  }
}
```

Set `defaultProfile` to the profile the installed plugin should use, or set
`DOCMOST_PROFILE` before starting Codex. A legacy single-profile object with
`mcpUrl`, `keychainService`, and `keychainAccount` remains supported.
The same example is available at
`plugins/docmost-knowledge/examples/config.multi-profile.json`.

The URL must use HTTPS and must not contain a username, password, query, or
fragment. The configuration file must not contain a bearer token.

On macOS, store each profile's token in Keychain using its service and account:

```bash
read -s "DOCMOST_TOKEN?Docmost MCP token: "
security add-generic-password -U \
  -s "Docmost MCP Personal" \
  -a "you@example.com" \
  -w "$DOCMOST_TOKEN"
unset DOCMOST_TOKEN
```

For non-macOS environments, set `DOCMOST_MCP_TOKEN` in the environment
inherited by Codex. You may also configure everything with environment
variables:

| Variable                      | Purpose                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `DOCMOST_PROFILE`             | Select a named profile from the JSON config                                                            |
| `DOCMOST_MCP_URL`             | Compatible HTTPS MCP endpoint                                                                          |
| `DOCMOST_MCP_TOKEN`           | Bearer token; takes precedence over Keychain                                                           |
| `DOCMOST_KEYCHAIN_SERVICE`    | macOS Keychain service name                                                                            |
| `DOCMOST_KEYCHAIN_ACCOUNT`    | macOS Keychain account name                                                                            |
| `DOCMOST_CONFIG_FILE`         | Optional alternative path to the JSON config                                                           |
| `DOCMOST_REQUEST_TIMEOUT_MS`  | Per-request timeout, from 1,000 to 300,000 ms                                                          |
| `DOCMOST_MAX_READ_RETRIES`    | Transient retries for known read tools, from 0 to 3                                                    |
| `DOCMOST_RETRY_DELAY_MS`      | Base read-retry delay, from 0 to 5,000 ms                                                              |
| `DOCMOST_MAX_RESPONSE_BYTES`  | Maximum remote JSON response, from 1 KiB to 32 MiB                                                     |
| `DOCMOST_CATALOG_PUBLIC_KEYS` | Optional JSON object mapping trusted Catalog `key_id` values to Ed25519 SPKI DER base64url public keys |

One plugin process selects one profile. To expose two profiles to Codex at the
same time, define two intentionally named MCP server entries that run this
proxy with different `DOCMOST_PROFILE` values. Do not keep an old manually
configured server that points to the same profile as the installed plugin.

## Server contract

The configured endpoint must accept JSON-RPC 2.0 over HTTPS `POST`, authenticate
with an `Authorization: Bearer ...` header, and implement `tools/list` and
`tools/call`. It should enforce token permissions independently for every
space, operation, template, version, attachment, and vector-search action.

The v0.5 core contract expects all 40 page, hierarchy, template, history,
attachment, search, and vector-job tools from v0.4. It also verifies:

- `search_docs` and `semantic_search_docs` support `rootPageId`
- page hierarchy supports `get_page_tree`, signed `preview_page_move`,
  concurrency-safe `move_page`, and atomic `move_pages`
- every mutation requires `idempotencyKey`
- page moves and page/template updates require `expectedUpdatedAt`
- batch moves plus template archival and deletion require explicit confirmation

Catalog Bundle/Freshness is an optional, negotiated extension. A server remains
core-compatible when it exposes no Catalog tools. The immutable v1 pair is
`resolve_catalog_bundle` and `resolve_catalog_delta`. The preferred signed v2
pair is `resolve_catalog_bundle_v2` and `resolve_catalog_delta_v2`; both still
use the `qts-fact-catalog.v1` request selector contract while returning
`catalog-bundle.v2`, `catalog-delta.v2`, and
`catalog-freshness-proof.v2`. Each exposed version must advertise its complete
pair. A partial or malformed pair fails the contract check.

For v2, the proxy validates exact fields and canonical ordering, Markdown
SHA-256 values, roots, known-root-cause candidates, graph closure, deterministic
fingerprints, Ed25519 signatures, and complete Delta reconstruction before
returning a result. The signed proof binds the challenge, snapshot window,
requested roots, authorization context, page manifest, extractor version, and
bundle fingerprint. HTTPS authenticates the endpoint; deployments that also
want explicit signing-key identity can configure `catalogPublicKeys` per
profile or `DOCMOST_CATALOG_PUBLIC_KEYS`. A configured pin is mandatory for
that profile and supports multiple key IDs during rotation.

Every new diagnosis must send a fresh challenge and receive a new live
freshness proof. A caller may retain static page content only under its exact
`(page_id, updated_at, content_sha256)` tuple and may reuse that content only
after the current Bundle or Delta revalidates the same tuple. Runtime facts and
prior diagnostic conclusions must never be reused across diagnoses. Remote
Monkey execution does not read Catalog; only the local diagnostic orchestrator
consumes these tools.

The proxy never automatically retries either v2 Catalog tool because the
server consumes its challenge before reading the Catalog. If transport outcome
is ambiguous, discard that challenge and begin a new Bundle or Delta call with
a fresh one.

The local proxy handles `initialize` and `ping`, rejects redirects, validates
remote responses, applies a configurable 90-second default timeout, preserves
safe JSON-RPC errors on HTTP 409/429, retries only known read operations on
HTTP 502/503/504 when replay is safe, and avoids including credentials in error
messages.

The plugin continues to use MCP even when the server also exposes a unified
Developer API. A load balancer and multiple Docmost application replicas are
transparent to the plugin as long as they share the same server-side
PostgreSQL, Redis, object storage, secrets, and permission model.

## Upgrade

The plugin registers an MCP server named `docmost-knowledge`. Remove an older
manual `[mcp_servers.docmost]` entry when it invokes a hard-coded proxy for the
same endpoint. Keeping both produces duplicate tools and can make Codex select
the wrong server.

Existing single-profile JSON configuration continues to work. Convert it to
`profiles` only when you need separate personal, company-test, or company
production endpoints.

Upgrading from v0.3 requires no local configuration change. Version 0.4 adds
the four same-space page-tree tools; the remote Docmost server must expose
them, including signed move previews and atomic batch moves, for the strict
doctor and live smoke checks to pass.

Upgrading from v0.4 to v0.5 also requires no local configuration change. Old
servers remain usable for all core tools. Catalog workflows become available
only after the server advertises both optional tools. Increase
`maxResponseBytes` only when a legitimate bounded Catalog closure exceeds the
16 MiB default; the proxy never permits more than 32 MiB.

Upgrading from v0.5 to v0.6 preserves the core and immutable Catalog v1
contracts. Signed fenced-YAML Catalog workflows use the separate v2 tool pair.
Public-key pinning is optional and disabled by default, so existing profiles
need no configuration change. To pin a server, add a non-secret map to one
profile:

```json
{
  "catalogPublicKeys": {
    "catalog-ed25519-current": "<spki-der-base64url-public-key>"
  }
}
```

## Development

Run the local test suite:

```bash
cd plugins/docmost-knowledge
npm test
```

Validate local configuration, Keychain access, the remote tool catalog, and the
strict v0.6 core contract and both optional Catalog capability versions:

```bash
npm run doctor
```

Run the end-to-end stdio live smoke test only after configuring a compatible
server and token:

```bash
npm run test:live
```

During a staged server upgrade, append `-- --warn` to either command to report
missing core or partial Catalog capabilities without failing the process.

## License

[MIT](LICENSE)
