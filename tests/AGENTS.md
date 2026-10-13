# Testing nappup

- Use `node:test` and `node:assert/strict`. Keep regression tests focused on
  observable behavior, including transport and CLI integration where needed.
- Use controlled HTTP/WebSocket transports and disposable signer credentials.
  Routine tests must not publish to real relays or Blossom servers, use the
  publisher's identity, or read/write the project's real `.env`.
- Use committed `tests/fixtures/` for fixed input samples. Create writable files,
  dotenv data and runtime fixtures in temporary directories and clean them up
  with test hooks; never mutate committed fixtures during tests.
- Reuse helpers in `tests/helpers/`. For tests that write NMMR chunks, use
  `isolateTemporaryDirectory()` from `tests/helpers/temporary-directory.js` to
  isolate NMMR's temporary-folder cleanup between test processes.
- Restore mocked globals, timers and environment variables after each test.
  Local protocol tests may bind to `127.0.0.1`; keep their servers disposable.

Run `npm test` from the repository root. To run selected files with the same
module-mocking support:

```sh
node --test --experimental-test-module-mocks tests/services/blossom-upload.test.js tests/services/blossom-protocol.test.js
```
