# Publication behavior

For CLI setup and public API usage, see the [README](../README.md).

## Destinations and confirmations

nappup discovers the publisher's Blossom servers and checks their reachability.
If at least one is reachable, it uses Blossom; otherwise it uses IRFS chunks on
Nostr relays. An HTTP error response to the health check still establishes
reachability; it does not guarantee that the server accepts a particular upload.

A file succeeds when at least one destination confirms a copy (each chunk for
IRFS). Different files may succeed on different servers. Partial destination
failures remain in diagnostics without invalidating confirmed copies or emitting
a terminal error. Exhausting replication retries also preserves confirmations
from earlier attempts or copies found by the replication query. The app manifest
requires a confirmed copy as well. If every destination for a required file fails,
the publication fails before publishing its manifest.

## Blossom requests and retries

Uploads follow [BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md).
PUT requests send the actual MIME type, `X-SHA-256` and a known content length.
Node streaming bodies receive an explicit Content-Length header; native Blob/File
bodies let the browser control it. Each attempt gets fresh authorization and a
fresh body. Default health/existence checks time out after five seconds, and the
upload timeout covers both the request and reading its JSON response for up to
60 seconds.

Files are processed sequentially within each server; servers run in parallel.
An existence HEAD check can skip a confirmed existing file. A HEAD `404` or a
network failure allows uploading; a PUT `404` stops retries for that file/server.

| Outcome | Automatic retry behavior |
| --- | --- |
| `200`, `201` with valid JSON | Upload succeeds. |
| Network failure or request timeout | Retry with bounded backoff. |
| `408`, `425`, `429`; `5xx` except `501`, `505` | Retry with bounded backoff. |
| Other statuses, including `415` and redirects | Stop for this file/server. |
| Malformed success JSON, signer rejection or cancellation | Stop for this file/server. |

There are at most five retries by default: six total attempts, with waits of
1, 3, 5, 7 and 9 seconds unless Retry-After extends a wait. Retry-After accepts
seconds or an HTTP date. A requested wait exceeding 60 seconds stops retries in
this operation rather than retrying earlier than requested. X-Reason is diagnostic
text and never determines retry eligibility. Other files and servers continue
after a file/server failure.

## Upload diagnostics

Every Blossom retry identifies the relative file path, destination, wait, next
attempt and previous error, including HTTP status when available:

```text
Retrying upload of assets/app.js to https://blossom.example in 1000ms (attempt 2/6): fetch failed
Retrying upload of assets/app.js to https://blossom.example in 3000ms (attempt 3/6): upload returned an error (503): temporarily unavailable
```

A failed existence check includes both the filename and SHA-256 hash:

```text
Could not check whether assets/app.js (sha256=<file hash>) exists on https://blossom.example; uploading it anyway: fetch failed
```

Final upload failures include the path, server, MIME type, byte size, original
error and reason retries stopped: a non-retryable error, signer rejection,
cancellation, exhausted attempts or excessive Retry-After. For example:

```text
assets/app.js: Failed to upload to https://blossom.example (text/javascript, 1234 bytes): upload returned an error (415): Unsupported Media Type; no further automatic retry: non-retryable error
```

This sequence means earlier attempts failed for other reasons and the `415`
stopped the operation for that file/server; no additional PUT follows that `415`.

## Manifest versions

The manifest's aggregate `x` tag identifies the version from file path/hash
mappings. The canonical aggregate is the SHA-256 of sorted `hash /path\n` lines;
metadata and file ordering do not affect it. Blossom uses file SHA-256 hashes;
IRFS uses file MMR roots. Updating only metadata or forcing a re-upload preserves
the aggregate. `published_at` records the publication time of the file version
and is preserved across subsequent metadata revisions; `created_at` records the
latest manifest revision. Legacy same-version manifests without a valid
published_at use the previous manifest's created_at when that tag is added.

After a confirmed publication, including reuse or replication of an existing
manifest, the CLI output ends with:

```text
Version: v2026-10-13-1234abcd
Version hash: <full aggregate hash>
Visit at https://44billion.net/<app identifier>
```

Programmatic callers receive these messages through the optional `log` callback.
The version label matches the launcher updates screen: the UTC date from
published_at and the first eight characters of the aggregate hash. A missing or
invalid timestamp, including one more than ten minutes in the future, produces
only the short hash. The timestamp must be a decimal non-negative safe integer
string without leading zeros, except for `"0"` itself.

The full aggregate hash identifies the file version. The Nostr event ID identifies
the signed manifest revision and may change even when the file version does not.
`Event: id=... kind=...` is a relay-failure diagnostic; it is not printed on every
successful publication. The Visit URL identifies the app and channel.

## Public failures and relay timing

Rejected uploads use NappupError with stable NAPPUP_ERROR_CODES. For blocking
destination failures, `error.details.failures` contains
`{ destination, filename?, reason }` records. The original reason retains HTTP
status, retryable, retryAfterMs or relay category when available, as well as
native causes and aggregate members. Extra replica failures remain in logs.
Signer failures normalize to NAPPUP_SIGNER_LOCKED or NAPPUP_SIGNER_DENIED,
including when nested inside aggregates. Classification uses original error
nodes, never the formatted aggregate message or server rejection text.

Applications should show recovery instructions for rejected operations and use
destination-specific guidance only when it applies to all blocking failures.

Nostr relay timing belongs to libp2r2p: optional params represent relative
milliseconds or `@` Unix milliseconds. Cooldowns apply to the refused
EVENT/AUTH/REQ/COUNT type; publication failures do not block replication reads.
nappup waits for terminal per-relay reports to determine confirmations, retries
publication timeouts once, and backs off for rate-limited relays. Other relay
failures have no further automatic retry in that operation. HTTP Retry-After is
a separate transport contract.
