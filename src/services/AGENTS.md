# Service maintenance

Follow the root [AGENTS.md](../../AGENTS.md). Publication and transport contracts
are documented in [docs/publication.md](../../docs/publication.md); update that
document when changing them.

## Blossom uploads

- Preserve BUD-02 request semantics, bounded timeouts, fresh authorization/body
  per attempt, HTTP retry eligibility and Retry-After handling.
- Send the actual MIME type; never disguise JavaScript to bypass upload policies.
- Keep file paths, destinations and error causes visible in retry diagnostics,
  and explain why automatic retries stop. Treat X-Reason as diagnostic text.
- Validate changes with `tests/services/blossom-upload.test.js` and
  `tests/services/blossom-protocol.test.js`, then run `npm test` and lint the
  changed JavaScript.

## Publication failures

- Preserve confirmed copies when replication retries are exhausted. Keep partial
  destination failures in logs and only blocking failures in public error details.
- Preserve original errors, HTTP status, timing, causes and aggregate members.
- Classify signer errors from original nodes in the error tree, never from the
  formatted aggregate message or a server's human-readable rejection text.
- Validate the public boundary with `tests/helpers/upload-failures.test.js` and
  the retry thresholds with `tests/services/irfs-upload.test.js`.

## Manifest versions

- Preserve the canonical path/hash aggregate and published_at semantics. Keep
  the publication's version label compatible with the launcher updates screen.
- Log the version and full aggregate after a confirmed publication, including
  reused manifests, without changing public progress events.
- Validate with `tests/services/site-manifest.test.js`,
  `tests/helpers/manifest-version.test.js` and `tests/on-event.test.js`.

## Relay timing

- Use libp2r2p's public relay pool and timing APIs. The library owns Nostr params
  and per-message-type cooldowns; retain native diagnostics and nappup's upload
  thresholds. Keep HTTP Retry-After handling separate.
- Wait for terminal per-relay reports when determining upload confirmations.
  Validate relay changes with `tests/services/nostr-relays.test.js`,
  `tests/helpers/relay-diagnostics.test.js` and `tests/services/relay-replication.test.js`.
