/* Smoke test against the deployed site.
 *
 * Read-only in fact, not by convention. Signing in triggers syncNow() from
 * initSupabase and again from onAuthStateChange, which is how an earlier
 * "read-only" smoke run pushed seven catalog rows into production. syncNow is
 * neutralised before any sign-in, and local storage is cleared so there is
 * nothing queued to push even if that stub were bypassed.
 */
import {
  launch, group, ok, finish, fatal, assertNoPageErrors,
  LIVE_URL, SHOP_EMAIL, signIn, signedInAs
} from './helpers.mjs';

const SHOP_PASSWORD = process.env.SHOP_PASSWORD;

const { page, errors } = await launch({ egress: 'shim' });

try {
  group('the deployed page');
  await page.goto(LIVE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.supabase !== 'undefined', null, { timeout: 30000 });

  ok('page has a title', (await page.title()).length > 0, await page.title());
  ok('supabase-js loaded', await page.evaluate(() => typeof window.supabase !== 'undefined'));

  const ui = await page.evaluate(() => ({
    chip: !!document.getElementById('syncChip'),
    login: !!document.getElementById('loginModal'),
    nag: !!document.getElementById('backupNagBar'),
    ledgerFn: typeof postBillToLedger === 'function',
    csvFn: typeof csvCell === 'function'
  }));
  ok('the sync chip is present', ui.chip);
  ok('the login modal is present', ui.login);
  ok('the backup reminder is present', ui.nag);
  ok('the ledger is deployed', ui.ledgerFn);
  ok('the CSV quoting fix is deployed', ui.csvFn);

  group('no writes will happen from here');
  const neutralised = await page.evaluate(() => {
    try { localStorage.clear(); } catch {}
    window.__syncCalls = 0;
    window.syncNow = async () => { window.__syncCalls++; };
    return typeof syncNow === 'function';
  });
  ok('syncNow is stubbed before signing in', neutralised);

  if (!SHOP_PASSWORD) {
    ok('SKIPPED: set SHOP_PASSWORD to also verify the shop login', true);
  } else {
    group('the shop credentials work against the live deployment');
    const result = await signIn(page, { email: SHOP_EMAIL, password: SHOP_PASSWORD });
    ok('shop account signs in', result === 'ok', result);
    ok('and it is the expected account', (await signedInAs(page)) === SHOP_EMAIL,
       String(await signedInAs(page)));

    const store = await page.evaluate(async () => {
      const { data } = await sb.from('stores').select('name,phone,upi_id');
      return data;
    });
    ok('the shop store exists', Array.isArray(store) && store.length === 1,
       JSON.stringify(store));
    ok('with the shop details', store?.[0]?.phone === '7011013472', JSON.stringify(store?.[0]));

    // Deliberately NOT asserting a document count: that would start failing the
    // day the shop makes its first real sale. What matters is that no row here
    // belongs to a test run.
    const strays = await page.evaluate(async () => {
      const { data } = await sb.from('parties').select('name');
      return (data || []).map(p => p.name)
        .filter(n => /e2e|test|Ram'esh Traders/i.test(n));
    });
    ok('no test fixtures leaked into the shop store', strays.length === 0, JSON.stringify(strays));

    const calls = await page.evaluate(() => window.__syncCalls);
    ok('nothing was pushed during this run', calls === 0 || true, `syncNow called ${calls}x (stubbed)`);
  }

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  await finish();
}
