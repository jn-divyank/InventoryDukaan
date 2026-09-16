# Tests

Both suites drive the real `index.html` in headless Chromium.

    npx http-server -p 8899 -s .          # from the repo root
    node tests/app.test.mjs               # local/offline behaviour, no network
    node tests/sync.test.mjs              # end-to-end against the Supabase project

`app.test.mjs` needs no network. The bill-overwrite case in it fails against the
pre-fix revision, which is the point of it.

`sync.test.mjs` needs a Supabase account to sign in as. It expects
`synctest@example.com` / `SyncTest!2026`, which is deliberately NOT left in the
project — create a throwaway confirmed user before running it and delete it
after, so test rows never mix with the shop's data.

Note on the sandbox: the test harness routes the browser's external requests
through Node's `fetch` rather than configuring a browser proxy, because the
container's Chromium does not trust the egress proxy's CA. Outside that
sandbox a plain `chromium.launch()` with normal networking works.
