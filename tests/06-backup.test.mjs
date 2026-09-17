/* Backup and restore. This is the shop's only recovery path if a phone is lost
 * or its storage is cleared, so the round trip has to be exercised for real,
 * not approximated. */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, addCustomer, selectCustomer, saveBill, appState, lsJSON
} from './helpers.mjs';

const server = await startServer();
const { page, errors } = await launch({ egress: 'none' });
await page.goto(server.url, { waitUntil: 'load' });

const captureBackup = async () => {
  await page.evaluate(() => {
    window.__blob = null;
    URL.createObjectURL = b => { window.__blob = b; return 'blob:captured'; };
    HTMLAnchorElement.prototype.click = function () { window.__name = this.download; };
  });
  await page.evaluate(() => exportDataBackup());
  return page.evaluate(async () => ({
    json: window.__blob ? JSON.parse(await window.__blob.text()) : null,
    name: window.__name || null
  }));
};

/* importDataBackup reads event.target.files[0], so a synthetic event is enough. */
const importBackup = (text) => page.evaluate(async payload => {
  const file = new File([payload], 'backup.json', { type: 'application/json' });
  importDataBackup({ target: { files: [file] } });
  await new Promise(r => setTimeout(r, 300));   // FileReader is async
}, text);

try {
  group('export captures the whole dataset');
  await reset(page);
  await addCustomer(page, { acc: '7', name: 'बैकअप पार्टी', phone: '9998887770', openingBal: 250 });
  await selectCustomer(page, '[खाता: 7] बैकअप पार्टी - 9998887770');
  await addItem(page, { name: 'बैकअप आइटम', mrp: 1500 });
  await saveBill(page, 'Credit');

  const exported = await captureBackup();
  // Asserted against the real exportDataBackup() output, not a literal rebuilt
  // in the test — the previous version of this check could not have failed.
  for (const key of ['catalog', 'customers', 'salesHistory', 'purchaseHistory',
                     'ledger', 'custSeq', 'ledgerSeq', 'billCounter',
                     'purchaseCounter', 'storeUPI', 'schemaVersion']) {
    ok(`export carries ${key}`, key in exported.json, Object.keys(exported.json).join(','));
  }
  ok('the credit sale is in the exported ledger',
     exported.json.ledger.some(e => e.type === 'BILL' && e.amount === 1500),
     JSON.stringify(exported.json.ledger));
  ok('the backup filename is dated', (exported.name || '').includes('Backup'), String(exported.name));

  group('exporting stamps the backup age');
  const stamped = await page.evaluate(() => localStorage.getItem('asc_last_backup'));
  ok('last-backup timestamp recorded', !!stamped && Number(stamped) > 0, String(stamped));
  const nagHidden = await page.evaluate(() =>
    document.getElementById('backupNagBar').style.display);
  ok('the nag bar is hidden right after a backup', nagHidden === 'none', nagHidden);

  group('the nag bar reappears as a backup ages');
  const nag = await page.evaluate(() => {
    const out = {};
    localStorage.setItem('asc_last_backup', String(Date.now() - 6 * 86400000));
    checkBackupAge(); out.sixDays = document.getElementById('backupNagBar').style.display;
    localStorage.setItem('asc_last_backup', String(Date.now() - 8 * 86400000));
    checkBackupAge(); out.eightDays = document.getElementById('backupNagBar').style.display;
    localStorage.removeItem('asc_last_backup');
    checkBackupAge(); out.never = document.getElementById('backupNagBar').style.display;
    return out;
  });
  ok('silent at 6 days', nag.sixDays === 'none', nag.sixDays);
  ok('warns at 8 days', nag.eightDays === 'block', nag.eightDays);
  ok('warns when no backup was ever taken', nag.never === 'block', nag.never);

  group('full round trip');
  const payload = JSON.stringify(exported.json);
  await reset(page);                       // wipe everything, as a new phone would be
  let s = await appState(page);
  ok('starting from an empty app', s.customers === 0 && s.sales === 0,
     JSON.stringify({ c: s.customers, s: s.sales }));

  await importBackup(payload);
  s = await appState(page);
  ok('customers restored', s.customers === 1, String(s.customers));
  ok('sales restored', s.sales === 1, String(s.sales));
  ok('ledger restored', s.ledger === 1, String(s.ledger));

  const bal = await page.evaluate(() => partyBalance(customers[0]));
  ok('the khata balance rebuilds to ₹250 + ₹1500', bal === 1750, String(bal));

  await page.reload({ waitUntil: 'load' });
  const after = await appState(page);
  ok('the restore persisted, not just loaded into memory',
     after.customers === 1 && after.sales === 1,
     JSON.stringify({ c: after.customers, s: after.sales }));

  group('restoring a pre-ledger backup');
  await reset(page);
  // What a backup taken from the old Netlify build looks like: oldBal only,
  // no party ids, no ledger, no sequences.
  const legacy = JSON.stringify({
    catalog: [{ name: 'पुराना आइटम', mrp: 100, disc: 0 }],
    customers: [{ acc: '3', name: 'पुरानी पार्टी', phone: '9000000001', oldBal: 800 }],
    salesHistory: [], purchaseHistory: [], billCounter: 12, purchaseCounter: 4,
    storeUPI: '7011013472@paytm'
  });
  await importBackup(legacy);
  const legacyState = await page.evaluate(() => ({
    id: customers[0]?.id ?? null,
    openingBal: customers[0]?.openingBal ?? null,
    balance: partyBalance(customers[0])
  }));
  ok('a party id is backfilled immediately, not on the next reload',
     legacyState.id !== null && legacyState.id !== undefined, JSON.stringify(legacyState));
  ok('the old oldBal becomes the opening balance', legacyState.openingBal === 800,
     JSON.stringify(legacyState));
  ok('so the balance still reads ₹800', legacyState.balance === 800, String(legacyState.balance));
  ok('bill counters come across', (await lsJSON(page, 'asc_bill_no')) === 12 ||
     (await page.evaluate(() => billCounter)) === 12, 'billCounter');

  group('a malformed backup is refused without damage');
  await reset(page);
  await addCustomer(page, { acc: '1', name: 'सुरक्षित', phone: '9000000002', openingBal: 10 });
  let alerted = null;
  await page.evaluate(() => { window.alert = m => { window.__alerted = m; }; });
  await importBackup('{ this is not json');
  alerted = await page.evaluate(() => window.__alerted || null);
  const survived = await appState(page);
  ok('an alert is shown', !!alerted, String(alerted));
  ok('existing data is untouched', survived.customers === 1, String(survived.customers));

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  server.stop();
  await finish();
}
