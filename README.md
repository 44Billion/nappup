# Napp Up!

```text
  _   _                   _   _       _
 | \ | | __ _ _ __  _ __ | | | |_ __ | |
 |  \| |/ _` | '_ \| '_ \| | | | '_ \| |
 | |\  | (_| | |_) | |_) | |_| | |_) |_|
 |_| \_|\__,_| .__/| .__/ \___/| .__/(_)
             |_|   |_|         |_|
```

**Napp Up!** is a powerful CLI tool for developers to effortlessly upload and manage Nostr applications. Ship your decentralized apps to the Nostr network with a single command.

## Usage

```bash
nappup [directory] [options]
```

### Arguments

- `[directory]`
  The root directory of your application to upload. If omitted, defaults to the current working directory (`.`).

### Options

| Flag | Description |
|------|-------------|
| `-s <secret_key>` | Your Nostr secret key (hex, nsec, or `bunker://` URL) used to sign the application event. See [Authentication](#authentication) for alternatives. |
| `-d <d_tag>` | The identifier (`d` tag) for your application. Any UTF-8 text up to 260 characters. If omitted, defaults to the directory name. Avoid generic names like `dist` or `build` - use something unique among your other apps like `mycoolapp`. |
| `-y` | Skip confirmation prompt. Useful for CI/CD pipelines or automated scripts. |
| `-r` | Force re-upload. By default, Napp Up! might skip files that haven't changed. Use this flag to ensure everything is pushed fresh; it does not create a new app version unless a file path or hash changes. |
| `--main` | Publish to the **main** release channel. This is the default behavior. |
| `--next` | Publish to the **next** release channel. Ideal for beta testing or staging builds. |
| `--draft` | Publish to the **draft** release channel. Use this for internal testing or work-in-progress builds. |
| `--dotenv-private-key <hex>` | Use a 32-byte hex private key to decrypt and manage encrypted credentials in `.env`. Prefer `DOTENV_PRIVATE_KEY_NAPPUP` because command-line arguments can be visible in shell history and process listings. |

## Authentication

Napp Up! supports multiple ways to provide your Nostr secret key:

1. **CLI flag**: Pass your secret key (hex or nsec) directly via `-s`:
   ```bash
   nappup -s nsec1...
   ```

2. **Remote signer (NIP-46)**: Pass a `bunker://` URL to sign events via a remote signer like [nak](https://github.com/fiatjaf/nak?tab=readme-ov-file#start-a-bunker-that-persists-its-metadata-secret-key-relays-authorized-client-pubkeys-to-disc) or [Amber](https://github.com/greenart7c3/Amber):
   ```bash
   nappup -s 'bunker://<pubkey>?relay=wss://relay.example.com&secret=<token>'
   ```
   Napp Up! creates a persistent NIP-46 client key before connecting. For URLs passed with `-s`, the latest session is stored as `LAST_CLI_BUNKER_SESSION` in the project's `.env`. A URL without `secret` is also valid when the remote signer uses its public key as the access capability.

3. **Environment variable**: Set `NOSTR_SECRET_KEY` in your environment or a `.env` file (also supports `bunker://` URLs):
   ```bash
   export NOSTR_SECRET_KEY=nsec1...
   nappup ./dist
   ```

4. **Auto-generated key**: If no key is provided, Napp Up! will generate a new keypair automatically and store it (as nsec) in your project's `.env` file for future use.

When `NOSTR_SECRET_KEY` in `.env` is a bunker URL, Napp Up! adds the local client key as a `#client_key=...` URI fragment while retaining the query-string `secret` for compatibility fallback. Reconnects first use the same client key without the token and retry with the token only if necessary.

Napp Up! stores `NOSTR_SECRET_KEY` and `LAST_CLI_BUNKER_SESSION` in the official dotenvx `encrypted:<base64>` format, using the compressed public key in `DOTENV_PUBLIC_KEY_NAPPUP`. The private key is selected from `--dotenv-private-key`, then `DOTENV_PRIVATE_KEY_NAPPUP` in the process environment, and finally a built-in fallback. The public key is selected from the `.env`, then the process environment, and finally derived from the selected private key.

The built-in fallback makes migration automatic, but is public knowledge and therefore only hides plaintext; use an explicit private key for confidentiality. Generate one locally for storage in your secret manager with:

```bash
nappup env keygen
```

Alternatively, generate and export one directly into the current shell:

```bash
export DOTENV_PRIVATE_KEY_NAPPUP="$(nappup env keygen)"
```

`env keygen` writes only the generated 64-character lowercase hex key to standard output, writes a reminder to standard error, and never reads or modifies `.env`. Store the result in a secret manager; nappup cannot recover it.

Because encryption itself requires only the public key, the following command can safely replace the Nostr secret without receiving the private key:

```bash
nappup env set NOSTR_SECRET_KEY
printf '%s\n' 'nsec1...' | nappup env set NOSTR_SECRET_KEY
```

The interactive form hides and confirms the value. Redirected stdin and a positional value are also accepted; the positional form emits a warning because it may be exposed through shell history or process listings. With only `DOTENV_PUBLIC_KEY_NAPPUP`, `env set` can encrypt a replacement, while commands that need an existing value fail clearly without the matching private key.

Existing plaintext values are encrypted automatically when used. If an explicit private key does not match the stored public key, it becomes authoritative: recoverable values are re-encrypted and inaccessible credentials are reset with a warning naming only the affected variables. This can result in a new publisher identity or bunker client key.

Use `DOTENV_CONFIG_PATH` to select a different dotenv file. The private key must come from the process environment or CLI and is rejected if stored inside that file.

### Examples

Upload the current directory to the main channel:
```bash
nappup -s nsec1...
```

Or using an environment variable:
```bash
NOSTR_SECRET_KEY=nsec1... nappup
```

Upload a specific `dist` folder with a custom identifier to the `next` channel:
```bash
nappup ./dist -s nsec1... -d "My App #1" --next
```

Force re-upload a draft:
```bash
nappup ~/my-repos/projectx/build/projectx --draft -r
```

## Programmatic Usage

Each published manifest includes an aggregate `x` tag that identifies the app
version from its file path/hash mappings. Updating only manifest metadata or
forcing a re-upload preserves that aggregate. The `published_at` tag records
the first publication time of that aggregate and is preserved across later
metadata revisions, while the event's `created_at` records the latest manifest
revision.

Napp Up! also exports a function that works in both Node.js and the browser, so you can integrate app uploads directly into your own tooling:

```js
import publishApp from 'nappup'

await publishApp(fileList, signer, {
  dTag: 'my-app',
  channel: 'main',       // 'main' | 'next' | 'draft'
  shouldReupload: false,
  onEvent ({ type, progress }) {
    console.log(`${type} — ${progress}%`)
  }
})
```

- **`fileList`** — a `FileList` or array of `File` objects (each needs `webkitRelativePath`).
- **`signer`** — a [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md)-compatible signer. In the browser, `window.nostr` is used automatically if omitted.
- **`onEvent`** — optional callback that receives progress events with a `type` (`'init'`, `'file-uploaded'`, `'complete'`, `'error'`, …) and `progress` (0–100).

Rejected uploads use `NappupError`, with a stable code from
`NAPPUP_ERROR_CODES`. The original error is retained as `cause`, and some
errors include structured `details`, so applications can show their own
recovery instructions without matching CLI-oriented message text:

```js
import publishApp, { NAPPUP_ERROR_CODES } from 'nappup'

try {
  await publishApp(fileList, signer)
} catch (error) {
  if (error.code === NAPPUP_ERROR_CODES.GENERIC_FOLDER_NAME) {
    // Ask the user to choose a unique app folder name.
  }
}
```
