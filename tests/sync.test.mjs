import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const URL = 'http://127.0.0.1:8899/index.html';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } };

const PROXY = process.env.HTTPS_PROXY || undefined;
const browser = await chromium.launch();  // egress handled by page.route + Node fetch
const page = await browser.newPage();
page.on('dialog', d => d.accept(''));
const errs = [];
page.on('pageerror', e => errs.push(e.message));

/* The sandboxed Chromium does not trust the egress proxy's CA, so every
   external request is fulfilled via Node's fetch, which does. The page still
   runs the real application code against the real Supabase project. */
await page.route('**/*', async route => {
  const req = route.request();
  const url = req.url();
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return route.continue();
  try {
    const headers = { ...req.headers() };
    delete headers['host']; delete headers['origin']; delete headers['referer'];
    const resp = await fetch(url, {
      method: req.method(),
      headers,
      body: ['GET','HEAD'].includes(req.method()) ? undefined : req.postData(),
      redirect: 'follow'
    });
    const body = Buffer.from(await resp.arrayBuffer());
    const out = {};
    resp.headers.forEach((v, k) => {
      if (!['content-encoding','content-length','transfer-encoding'].includes(k)) out[k] = v;
    });
    out['access-control-allow-origin'] = '*';
    out['access-control-allow-headers'] = '*';
    out['access-control-allow-methods'] = '*';
    out['access-control-expose-headers'] = '*';
    await route.fulfill({ status: resp.status, headers: out, body });
  } catch (e) {
    console.log('  route error:', url.slice(0, 70), e.message);
    await route.abort();
  }
});

await page.goto(URL);
await page.waitForTimeout(3000);   // let the CDN script land
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(3000);

// The Supabase library must actually be reachable.
const libLoaded = await page.evaluate(() => typeof window.supabase !== 'undefined');
ok('supabase-js loaded from CDN', libLoaded);
if (!libLoaded) { console.log('\n==== aborting: no library ===='); await browser.close(); process.exit(1); }

await page.waitForFunction(() => window.sb !== undefined || document.getElementById('syncChip').innerText.length > 3, { timeout: 10000 }).catch(() => {});

console.log('\n--- login ---');
const loginResult = await page.evaluate(async () => {
  const { error } = await sb.auth.signInWithPassword({ email: 'synctest@example.com', password: 'SyncTest!2026' });
  return error ? error.message : 'ok';
});
ok('signs in with email + password', loginResult === 'ok', loginResult);

console.log('\n--- build a credit bill locally ---');
await page.evaluate(() => {
  document.getElementById('mCustAcc').value = '12';
  document.getElementById('mCustName').value = "Ram'esh Traders";
  document.getElementById('mCustPhone').value = '9876543210';
  document.getElementById('mCustOldBal').value = '500';
  saveManualCustomer();
  document.getElementById('custInfo').value = "[खाता: 12] Ram'esh Traders - 9876543210";
  onCustInput();
  document.getElementById('itemName').value = 'कुकर 5L';
  document.getElementById('itemMRP').value = '1850';
  document.getElementById('itemQty').value = '2';
  document.getElementById('itemDiscount').value = '10';
  addItemToList();
  setPaymentMode('Credit');
  saveCurrentBillToHistory();
});

const localState = await page.evaluate(() => ({
  balance: partyBalance(customers[0]),
  billNo: salesHistory[0].billNo,
  grand: salesHistory[0].totals.grandTotal,
  pending: dirtyCount()
}));
console.log('  local:', JSON.stringify(localState));
ok('local balance = 500 opening + 3330 credit', localState.balance === 3830, String(localState.balance));
ok('records queued for sync', localState.pending > 0, String(localState.pending));

console.log('\n--- push to Postgres ---');
const syncErr = await page.evaluate(async () => {
  try { await syncNow(true); return null; } catch (e) { return e.message; }
});
await page.waitForFunction(() => !syncBusy, { timeout: 20000 }).catch(() => {});
ok('sync completed without throwing', !syncErr, syncErr || '');

const after = await page.evaluate(() => ({ pending: dirtyCount(), store: storeId, chip: document.getElementById('syncChip').innerText }));
console.log('  after sync:', JSON.stringify(after));
ok('sync queue drained', after.pending === 0, String(after.pending));
ok('store was created/linked', !!after.store, String(after.store));

console.log('\n--- read it back from the server ---');
const remote = await page.evaluate(async () => {
  const { data: docs } = await sb.from('documents').select('doc_no,pay_mode,grand_total,party_text');
  const { data: items } = await sb.from('document_items').select('name,qty,net_price');
  const { data: bal } = await sb.from('party_balances').select('name,balance');
  const { data: led } = await sb.from('ledger_entries').select('entry_type,amount');
  return { docs, items, bal, led };
});
console.log('  remote:', JSON.stringify(remote));
ok('bill reached Postgres', remote.docs && remote.docs.length === 1, JSON.stringify(remote.docs));
ok('grand total matches', remote.docs?.[0] && Number(remote.docs[0].grand_total) === localState.grand, String(remote.docs?.[0]?.grand_total));
ok('line item reached Postgres', remote.items && remote.items.length === 1, JSON.stringify(remote.items));
ok('server-side balance = 3830', remote.bal?.[0] && Number(remote.bal[0].balance) === 3830, JSON.stringify(remote.bal));
ok('apostrophe name survived the round trip', remote.bal?.[0]?.name?.includes("Ram'esh"), remote.bal?.[0]?.name);
ok('one BILL ledger entry', remote.led?.filter(l => l.entry_type === 'BILL').length === 1, JSON.stringify(remote.led));

console.log('\n--- re-sync must be idempotent ---');
await page.evaluate(async () => { markAllDirty(); await syncNow(true); });
await page.waitForFunction(() => !syncBusy, { timeout: 20000 }).catch(() => {});
const dupe = await page.evaluate(async () => {
  const { data: docs } = await sb.from('documents').select('doc_no');
  const { data: items } = await sb.from('document_items').select('name');
  const { data: led } = await sb.from('ledger_entries').select('entry_type');
  return { docs: docs.length, items: items.length, led: led.length };
});
console.log('  after re-sync:', JSON.stringify(dupe));
ok('re-sync did not duplicate the bill', dupe.docs === 1, String(dupe.docs));
ok('re-sync did not duplicate line items', dupe.items === 1, String(dupe.items));
ok('re-sync did not duplicate ledger rows', dupe.led === 1, String(dupe.led));

console.log('\n--- offline behaviour ---');
await page.context().setOffline(true);
const offline = await page.evaluate(() => {
  // A bill stays open under its number until "New" is pressed, so finalize the
  // current one first, then bill a genuinely new customer with no network.
  resetNewBill();
  const before = salesHistory.length;
  document.getElementById('itemName').value = 'ऑफलाइन आइटम';
  document.getElementById('itemMRP').value = '300';
  addItemToList();
  saveCurrentBillToHistory();
  return { pending: dirtyCount(), before, saved: salesHistory.length,
           billNo: salesHistory[0].billNo };
});
ok('billing still works with no network', offline.saved === offline.before + 1, JSON.stringify(offline));
ok('offline work is queued, not lost', offline.pending > 0, String(offline.pending));
await page.context().setOffline(false);

ok('no uncaught page errors', errs.length === 0, errs.join(' | '));
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await browser.close();
process.exit(fail ? 1 : 0);
