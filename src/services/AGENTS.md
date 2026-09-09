# Service maintenance

This document is for contributors editing nappup's implementation. Keep CLI usage
and credential setup in the root README; keep internal transport contracts here.

## Blossom uploads

Uploads follow [BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md).
They send the actual MIME type, `X-SHA-256`, and a known content length: explicitly
for Node streams, and through native Blob/File bodies in browsers (which control
the `Content-Length` header). Each attempt gets fresh authorization and a fresh
body. A 60-second timeout covers the request and reading its JSON response.

`200` and `201` are successful upload responses. Retry network failures, timeouts,
`408`, `425`, `429`, and `5xx` except `501` and `505`, with at most five retries by
default. Other statuses, including `400`, `401`, `402`, `403`, `404`, `405`, `409`,
`411`, `413`, `415`, and redirects, stop retries for that file/server. A `404` from
an existence HEAD check still allows uploading; a `404` from PUT does not mean
repeating the same request will fix its endpoint. Malformed JSON success responses
and signer rejections also stop retries. Other files and servers continue.

`Retry-After` seconds or HTTP dates extend the backoff. If the requested wait
exceeds 60 seconds, stop this operation's retries rather than retrying earlier than
the server requested. `X-Reason` is shown only as diagnostic text, never parsed to
choose retries. Failure results retain HTTP status and timing on the original error,
and logs identify the destination, MIME type, and byte size. Do not disguise
JavaScript as another MIME type to bypass a server's upload policy.

When modifying `blossom-upload.js`, validate these contracts with
`tests/services/blossom-upload.test.js` and `tests/services/blossom-protocol.test.js`,
then run `npm test` and lint the changed JavaScript. Tests must use controlled
transports and disposable credentials, never the user's publisher identity.

## Publication failures

- One confirmed copy per file (per chunk for IRFS) and a confirmed manifest are
  sufficient. Retry exhaustion must not invalidate confirmations obtained earlier
  or an existing copy found by the replication query.
- Keep partial destination failures in diagnostics. Public `details.failures`
  records use `{ destination, filename?, reason }` and include only blocking
  failures. Preserve original errors, status, causes and aggregate members.
- Classify signer errors from original nodes in the error tree, never from the
  formatted aggregate message or a server's human-readable rejection text.
- Validate the public boundary with `tests/helpers/upload-failures.test.js` and
  the retry thresholds with `tests/services/irfs-upload.test.js`.
