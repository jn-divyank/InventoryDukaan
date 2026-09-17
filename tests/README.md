# Tests

Every suite drives the real `index.html` in headless Chromium. There is no test
framework — each file is a script that asserts through the shared helpers in
`helpers.mjs` and exits non-zero on the first failure count above zero.

## Running them

```sh
node tests/run-all.mjs          # the seven local suites, no network
node tests/run-all.mjs --all    # also the two that talk to Supabase
node tests/run-all.mjs 05       # just the suites matching "05"
node tests/01-billing.test.mjs  # one suite directly
```

The local suites need nothing but Node and Playwright: `run-all` starts its own
static server on a free port, so there is no `http-server` to remember.

## Credentials

The networked suites read their account from the environment. Nothing is
committed.

```sh
export E2E_EMAIL='e2e-test@arpitsteel.invalid'   # dedicated test account
export E2E_PASSWORD='...'
export SHOP_PASSWORD='...'                       # optional, for 09 only
```

`helpers.mjs` refuses to run if `E2E_EMAIL` is the shop account.

## The suites

| Suite | Covers | Network |
|---|---|---|
| `01-billing` | Line items, Gram pricing, warranty, discounts, scrap, round-off, payment modes, bill numbering, the Enter-key focus chain | no |
| `02-parties` | Party matching, the khata ledger, credit and split posting, payments, negative balances on credit purchases | no |
| `03-catalog` | Chips, autosave and dedupe, the directory, escaping of quotes and markup | no |
| `04-purchase` | The whole PURCHASE side and independent `PUR-` numbering | no |
| `05-history-reports` | History tabs and search, reprint and reshare, daily totals, both CSV exports and their quoting and encoding | no |
| `06-backup` | Export, restore, the pre-ledger migration path, the backup-age nag | no |
| `07-output-devices` | Bill text, WhatsApp, thermal print, clipboard, UPI QR, OCR parsing, voice entry, calculator | no |
| `08-sync-and-rls` | Sync to Postgres, idempotency, editing a synced bill, duplicate-number and double-post rejection, RLS isolation, offline queueing | **yes** |
| `09-live-smoke` | The deployed site loads and carries the current build | **yes** |

## Safety when testing against production

There is one Supabase project, so `08` writes to it. Three things keep the
shop's data out of reach:

1. **A dedicated test account owning its own store.** RLS scopes every table by
   store membership, so the test account cannot read or write the shop's rows.
   This is enforced by Postgres, not by convention, and `08` asserts it.
2. **`cleanupTestStore()` in a `finally`.** It only ever deletes rows under the
   signed-in account's store, and it runs even when a suite throws — which is
   what makes the suite re-runnable after a crashed run.
3. **Delta assertions.** Row counts are compared before and after, never
   asserted absolutely, so a non-empty starting database is not fatal.

`09` is read-only in fact rather than by convention: signing in triggers
`syncNow()` from both `initSupabase` and `onAuthStateChange`, which is how an
earlier "read-only" smoke run pushed seven catalog rows into production. It now
stubs `syncNow` and clears local storage before any sign-in.

## Notes on the environment

The sandboxed Chromium here does not trust the egress proxy's CA, so a browser
proxy setting fails with `ERR_CERT_AUTHORITY_INVALID`. `installFetchShim()`
relays external requests through Node's `fetch`, which does trust it. The page
still runs the real application code against the real project. Outside that
sandbox the shim is harmless.

One consequence worth knowing: the shim forces permissive CORS headers, so no
suite can detect a genuine CORS regression on the Supabase project.

`PLAYWRIGHT_PATH` overrides where Playwright is imported from if it is not at
the default location.
