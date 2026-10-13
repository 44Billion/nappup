# Working on nappup

nappup publishes Nostr apps through Blossom or IRFS and provides a CLI and an
ES module API for Node.js and browsers. The package runs directly from source;
there is no build step.

## Project layout and documentation

- `src/index.js` owns the public upload API, progress events and error boundary.
- `src/services/` contains transport, signing, credentials and manifest logic;
  follow its [maintenance instructions](src/services/AGENTS.md).
- `src/helpers/` contains reusable utilities; group related functions by purpose.
- `bin/nappup/` contains the CLI entry point and its argument/file helpers.
- `tests/` contains tests, test helpers and fixtures; follow its
  [testing instructions](tests/AGENTS.md).
- Keep the [README](README.md) focused on CLI setup and concise API usage. Keep
  publication behavior and transport contracts in [docs/publication.md](docs/publication.md).
  Update the relevant documentation when behavior changes; AGENTS.md files should
  contain maintenance instructions and links rather than duplicate those contracts.

## Implementation conventions

- Use plain JavaScript ES modules. Follow `eslint.config.js`, use kebab-case
  filenames and the existing `package.json` import aliases for internal modules.
  Prefix Node built-in imports with `node:`.
- Follow the surrounding module's export and state conventions. Choose functions
  or classes to suit the implementation; neither is required for every module.
- Prefer promises for asynchronous work. Add brief comments where intent or a
  contract is not clear from the code.
- Preserve Node and browser support in shared code; keep CLI-only filesystem and
  process behavior in the CLI or Node-specific services.
- Keep public error codes, causes and progress-event contracts compatible. Update
  API documentation and relevant tests when intentionally changing them.
- Avoid unnecessary dependencies. Use dependencies through public imports, test
  the installed package and keep committed dependency references on registry
  releases. Validate the exact prepared tarball before registry publication and
  retain its real integrity and registry URL in lockfiles.

## Validation

Run commands from the repository root:

- `npm ci` installs the locked dependencies when installation is needed.
- `npm test` runs the Node test suite.
- `npx --no-install eslint <changed JavaScript files>` checks code style.
- `git diff --check` checks whitespace. For documentation-only changes, verify
  local links and instructions; a full code test run is unnecessary.

AGENTS.md is the canonical instruction filename. Gemini CLI is configured in
[.gemini/settings.json](.gemini/settings.json) to read these files using its
[context filename setting](https://geminicli.com/docs/cli/gemini-md/).
