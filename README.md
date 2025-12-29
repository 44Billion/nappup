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
| `-s <secret_key>` | Your Nostr secret key (hex or nsec format) used to sign the application event. See [Authentication](#authentication) for alternatives. |
| `-d <d_tag>` | The unique identifier (`d` tag) for your application. If omitted, defaults to the directory name. Avoid generic names like `dist` or `build` - use something unique among your other apps like `mycoolapp`. |
| `-y` | Skip confirmation prompt. Useful for CI/CD pipelines or automated scripts. |
| `-r` | Force re-upload. By default, Napp Up! might skip files that haven't changed. Use this flag to ensure everything is pushed fresh. |
| `--main` | Publish to the **main** release channel. This is the default behavior. |
| `--next` | Publish to the **next** release channel. Ideal for beta testing or staging builds. |
| `--draft` | Publish to the **draft** release channel. Use this for internal testing or work-in-progress builds. |

## Authentication

Napp Up! supports multiple ways to provide your Nostr secret key:

1. **CLI flag**: Pass your secret key (hex or nsec) directly via `-s`:
   ```bash
   nappup -s nsec1...
   ```

2. **Environment variable**: Set `NOSTR_SECRET_KEY` in your environment or a `.env` file:
   ```bash
   export NOSTR_SECRET_KEY=nsec1...
   nappup ./dist
   ```

3. **Auto-generated key**: If no key is provided, Napp Up! will generate a new keypair automatically and store it (as nsec) in your project's `.env` file for future use.

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
nappup ./dist -s nsec1... -d myapp --next
```

Force re-upload a draft:
```bash
nappup ~/my-repos/projectx/build/projectx --draft -r
```
