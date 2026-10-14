# Encore Bridge tests

The bridge's test suite. It uses Node's built-in test runner, no npm packages and no network. Every engine, Spotify
service, phone and GitHub release in it is a fake, and every name and id is made up.

## Requirements

- **Node.js 22** or newer.
- **ffmpeg** (a full build) for the image tests and some end-to-end tests. Set `FFMPEG` if it isn't on `PATH`.
- **Linux or macOS** for the end-to-end tests (`bridge-*.test.js`). Elsewhere, and without ffmpeg, they are skipped.

## Running it

```sh
node --test                                   # from gateway/test (or: npm test)
node --test "gateway/test/*.test.js"          # from the repository root
node --test gateway/test/catalog.test.js      # one file; add --test-name-pattern="..." for some tests
ENCORE_SLOW_TESTS=1 node --test               # also bridge-jam.test.js (about ten more minutes)
```

In PowerShell: `$env:ENCORE_SLOW_TESTS = "1"; node --test`. `LIVE=1` prints the bridge's own log in the end-to-end
tests. In the bridge's Docker image, with no network (from `gateway/`, after `docker compose build gateway`):
`docker run --rm --network none -v "$PWD:/g" -w /g/test --entrypoint node encore-gateway:local --test`.

The whole suite takes about two minutes. Most files are named after the `src/` module they test; `bridge-*.test.js`
start the real `src/main.js`. `support/` holds the fakes (engine models, stub servers, `fakegithub.js`) and helpers.
`fixtures/` holds made-up engine payloads and `update-vectors.json` (the launcher keeps a byte-identical copy).

## Writing tests

- **Made-up data only:** no real names, ids, playlists or addresses. Use `example` hosts and 192.0.2.0/24,
  198.51.100.0/24, 203.0.113.0/24 or `192.168.1.20`.
- **No network:** every test must pass with `--network none`. Listen on `127.0.0.1` port `0`.
- **No fixed paths:** temporary files go under `os.tmpdir()` (`tmp()` in `support/helpers.js`).
- **Skip, don't pass:** a test that needs ffmpeg, a FIFO or a long run uses `needs()` from `support/platform.js`.
- New files are named `*.test.js` and sit in this folder. On a busy machine, `--test-concurrency=1` helps.
