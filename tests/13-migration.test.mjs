/* Rehearses the Netlify → Vercel handover.
 *
 * That sequence runs exactly once, on the shop's real data, with no second
 * chance. Two servers give two ports, and two ports are two origins with
 * separate localStorage — a faithful stand-in for the old host and the new one.
 */
import {
  launch, startServer, group, ok, finish, fatal, assertNoPageErrors,
  appState, signIn, testCredentials, syncAndSettle, readTables,
  snapshotCounts, assertDelta, cleanupTestStore
} from './helpers.mjs';

const oldHost = await startServer();
const newHost = await startServer();
let a, b;

/* What a backup taken from the pre-ledger build looks like: oldBal only, no
   party ids, no ledger, no sequences, no device id. */
const LEGACY = {
  catalog: [
    { name: 'कुकर 5L', mrp: 1850, disc: 25 },
    { name: 'पुराना आइटम', mrp: 320, disc: 10 }
  ],
  customers: [
    { acc: '7', name: 'पुरानी पार्टी', phone: '9000000007', oldBal: 1200 },
    { acc: '8', name: 'दूसरी पार्टी', phone: '9000000008', oldBal: 0 }
  ],
  salesHistory: [{
    billNo: 'ASC-014', type: 'SALE', cust: '[खाता: 7] पुरानी पार्टी - 9000000007',
    date: '01/09/2026 11:30', dateOnly: '01/09/2026', payMode: 'Cash',
    items: [{ id: 1, name: 'कुकर 5L', qty: 1, unit: 'Pcs', mrp: 1850, disc: 25,
              warranty: '1 वर्ष', totalMRP: 1850, netPrice: 1388 }],
    totals: { sumMRP: 1850, sumNet: 1388, scrap: 0, extra: 0, grandTotal: 1388,
              totalSavings: 462, splitPaid: 0, splitBalance: 0, totalDue: 1388 }
  }],
  purchaseHistory: [],
  billCounter: 15, purchaseCounter: 3,
  storeUPI: '7011013472@paytm'
};

try {
  /* ---------------------------------------------------- the old host */
  group('the old site, holding the shop\'s only copy');
  a = await launch({ egress: 'none' });
  await a.page.goto(oldHost.url, { waitUntil: 'load' });
  await a.page.evaluate(d => {
    localStorage.clear();
    localStorage.setItem('asc_catalog', JSON.stringify(d.catalog));
    localStorage.setItem('asc_customers', JSON.stringify(d.customers));
    localStorage.setItem('asc_sales_history', JSON.stringify(d.salesHistory));
    localStorage.setItem('asc_bill_no', String(d.billCounter));
    localStorage.setItem('asc_purchase_no', String(d.purchaseCounter));
    localStorage.setItem('asc_store_upi', d.storeUPI);
  }, LEGACY);
  await a.page.reload({ waitUntil: 'load' });

  const onOld = await appState(a.page);
  ok('the old site shows the shop data', onOld.customers === 2 && onOld.sales === 1,
     JSON.stringify({ c: onOld.customers, s: onOld.sales }));
  ok('and its bill counter', onOld.billNo === 'ASC-015', onOld.billNo);

  group('step 1 — press बैकअप on the old site');
  const backup = await a.page.evaluate(async () => {
    let blob = null;
    URL.createObjectURL = b => { blob = b; return 'blob:x'; };
    HTMLAnchorElement.prototype.click = function () {};
    exportDataBackup();
    return blob ? await blob.text() : null;
  });
  ok('a backup file is produced', !!backup && backup.length > 100,
     `${(backup || '').length} bytes`);
  const parsed = JSON.parse(backup);
  ok('it carries the parties', parsed.customers.length === 2, String(parsed.customers?.length));
  ok('it carries the bill history', parsed.salesHistory.length === 1, String(parsed.salesHistory?.length));
  ok('it carries the counters', parsed.billCounter === 15, String(parsed.billCounter));

  /* ---------------------------------------------------- the new host */
  group('step 2 — open the new site');
  b = await launch({ egress: 'shim' });
  await b.page.goto(newHost.url, { waitUntil: 'load' });
  await b.page.evaluate(() => localStorage.clear());
  await b.page.reload({ waitUntil: 'load' });

  const fresh = await appState(b.page);
  ok('the new site starts empty — this is why step 1 matters',
     fresh.customers === 0 && fresh.sales === 0,
     JSON.stringify({ c: fresh.customers, s: fresh.sales }));
  ok('and shows the default catalog, not his', fresh.catalog === 7, String(fresh.catalog));

  group('step 3 — import the backup file');
  await b.page.evaluate(async payload => {
    const file = new File([payload], 'backup.json', { type: 'application/json' });
    importDataBackup({ target: { files: [file] } });
    await new Promise(r => setTimeout(r, 400));
  }, backup);

  const imported = await appState(b.page);
  ok('parties arrive', imported.customers === 2, String(imported.customers));
  ok('bill history arrives', imported.sales === 1, String(imported.sales));
  ok('the catalog arrives', imported.catalog === 2, String(imported.catalog));
  ok('the bill counter continues where it left off', imported.billNo === 'ASC-015',
     imported.billNo);

  const balances = await b.page.evaluate(() => customers.map(c => ({
    name: c.name, id: c.id, opening: c.openingBal, balance: partyBalance(c)
  })));
  ok('every party has an id backfilled', balances.every(x => !!x.id), JSON.stringify(balances));
  ok('the ₹1200 outstanding is preserved',
     balances.find(x => x.name === 'पुरानी पार्टी')?.balance === 1200, JSON.stringify(balances));

  await b.page.reload({ waitUntil: 'load' });
  const afterReload = await appState(b.page);
  ok('the import persisted, it did not just load into memory',
     afterReload.customers === 2 && afterReload.sales === 1,
     JSON.stringify({ c: afterReload.customers, s: afterReload.sales }));

  group('the old site is untouched, so a failed migration is recoverable');
  const oldStill = await appState(a.page);
  ok('the old site still has everything', oldStill.customers === 2 && oldStill.sales === 1,
     JSON.stringify({ c: oldStill.customers, s: oldStill.sales }));

  /* ---------------------------------------------------- and it syncs */
  group('step 4 — log in and wait for ✅ सेव');
  await b.page.waitForFunction(() => typeof sb !== 'undefined' && sb !== null,
                               null, { timeout: 30000 });
  const login = await signIn(b.page, testCredentials());
  ok('signs in on the new site', login === 'ok', login);
  await b.page.waitForFunction(() => typeof sbUser !== 'undefined' && sbUser !== null,
                               null, { timeout: 20000 });

  await syncAndSettle(b.page);
  await cleanupTestStore(b.page);          // clear anything a prior run left
  await b.page.evaluate(() => markAllDirty());
  const before = await snapshotCounts(b.page);
  await syncAndSettle(b.page);
  const after = await snapshotCounts(b.page);

  assertDelta('the migrated bill reaches Postgres', before, after, 'documents', 1);
  assertDelta('both migrated parties reach Postgres', before, after, 'parties', 2);
  assertDelta('the migrated catalog reaches Postgres', before, after, 'products', 2);

  const remote = await readTables(b.page, {
    documents: 'doc_no,grand_total',
    party_balances: 'name,balance'
  });
  ok('the bill keeps its original number', remote.documents[0]?.doc_no === 'ASC-014',
     JSON.stringify(remote.documents));
  ok('and its total', Number(remote.documents[0]?.grand_total) === 1388,
     JSON.stringify(remote.documents));
  ok('the ₹1200 outstanding survives to the server',
     Number(remote.party_balances.find(p => p.name === 'पुरानी पार्टी')?.balance) === 1200,
     JSON.stringify(remote.party_balances));

  const chip = await b.page.evaluate(() => ({
    text: document.getElementById('syncChip').innerText, pending: dirtyCount() }));
  ok('the chip reads saved, which is the signal to stop using the old site',
     chip.pending === 0 && chip.text.includes('✅'), JSON.stringify(chip));

  assertNoPageErrors(a.errors, 'no page errors on the old site');
  assertNoPageErrors(b.errors, 'no page errors on the new site');
} catch (err) {
  fatal(err);
} finally {
  if (b) { try { console.log('  cleanup:', await cleanupTestStore(b.page)); } catch (e) {
    console.log('  cleanup failed:', e.message); } }
  oldHost.stop(); newHost.stop();
  await finish();
}
