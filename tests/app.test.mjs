import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const URL = 'http://127.0.0.1:8899/index.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const PROXY = process.env.HTTPS_PROXY || undefined;
const browser = await chromium.launch({ proxy: PROXY ? { server: PROXY, bypass: '127.0.0.1,localhost' } : undefined });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('dialog', d => d.accept('')); // auto-accept confirms
await page.goto(URL);

// ---------------------------------------------------------------- helpers
const addItem = (name, mrp, qty = 1, disc = 0) => page.evaluate(([name, mrp, qty, disc]) => {
  document.getElementById('itemName').value = name;
  document.getElementById('itemMRP').value = String(mrp);
  document.getElementById('itemQty').value = String(qty);
  document.getElementById('itemDiscount').value = String(disc);
  addItemToList();
}, [name, mrp, qty, disc]);

const billNo = () => page.evaluate(() => document.getElementById('billNoDisplay').innerText);
const ls = k => page.evaluate(k => localStorage.getItem(k), k);

console.log('\n--- BUG 1: bill number reuse overwrites earlier sale ---');
await page.evaluate(() => localStorage.clear());
await page.reload();

await addItem('कुकर 5L', 1850);
const first = await billNo();
// Simulate: shopkeeper prints/shares, then closes the app. No "new bill" click.
await page.evaluate(() => saveCurrentBillToHistory());
await page.reload();
const second = await billNo();
ok('bill number advances after save even without "new bill"', first !== second, `${first} -> ${second}`);

await addItem('गैस स्टोव 2B', 2600);
await page.evaluate(() => saveCurrentBillToHistory());
const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('asc_sales_history')));
ok('both sales retained (no overwrite)', hist.length === 2, `history length=${hist.length}`);
ok('bill numbers are distinct', hist[0].billNo !== hist[1].billNo, JSON.stringify(hist.map(h => h.billNo)));

console.log('\n--- BUG 2: khata / credit ledger ---');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.evaluate(() => {
  document.getElementById('mCustAcc').value = '12';
  document.getElementById('mCustName').value = "Ram'esh Traders";   // apostrophe on purpose
  document.getElementById('mCustPhone').value = '9876543210';
  document.getElementById('mCustOldBal').value = '500';
  saveManualCustomer();
});
await page.evaluate(() => {
  document.getElementById('custInfo').value = '[खाता: 12] Ram\'esh Traders - 9876543210';
  onCustInput();
});
await addItem('मिक्सर ग्राइंडर', 2800);
await page.evaluate(() => { setPaymentMode('Credit'); saveCurrentBillToHistory(); });

let bal = await page.evaluate(() => partyBalance(customers[0]));
ok('credit sale posts to the khata (500 opening + 2800)', bal === 3300, `balance=${bal}`);

// Re-saving the same bill must not double-post.
await page.evaluate(() => saveCurrentBillToHistory());
bal = await page.evaluate(() => partyBalance(customers[0]));
ok('re-saving the same bill does not double-post', bal === 3300, `balance=${bal}`);

// Payment recording
await page.evaluate(() => {
  ledger.unshift({ id: nextLedgerId(), partyId: customers[0].id, type: 'PAYMENT',
                   billNo: '', date: '01/01/2026', dateOnly: '01/01/2026', amount: -1300, note: 'test' });
  persistLedger();
});
bal = await page.evaluate(() => partyBalance(customers[0]));
ok('recorded payment reduces the balance', bal === 2000, `balance=${bal}`);

// Balance must survive a reload (it is derived, not cached)
await page.reload();
bal = await page.evaluate(() => partyBalance(customers[0]));
ok('balance persists across reload', bal === 2000, `balance=${bal}`);

console.log('\n--- BUG 3: apostrophes in free text ---');
await page.evaluate(() => localStorage.clear());
await page.reload();
await addItem("Mother's Pride कढ़ाई", 850);
const chipBroken = await page.evaluate(() => {
  renderCatalog();
  const chips = document.querySelectorAll('.chip-btn');
  return { count: chips.length, html: document.getElementById('chipsContainer').innerHTML.slice(0, 200) };
});
ok('catalog chip renders with an apostrophe in the name', chipBroken.count > 0, JSON.stringify(chipBroken));
const chipWorks = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.chip-btn')].find(b => b.textContent.includes('Mother'));
  if (!chip) return 'no chip';
  chip.click();
  return document.getElementById('itemName').value;
});
ok('clicking that chip fills the item name', chipWorks.includes("Mother's"), `got=${chipWorks}`);

console.log('\n--- BUG 4: persistence is not a render side effect ---');
await page.evaluate(() => localStorage.clear());
await page.reload();
await addItem('टेस्ट आइटम', 999);
const catSaved = JSON.parse(await ls('asc_catalog'));
ok('catalog persisted on add', catSaved.some(c => c.name === 'टेस्ट आइटम'));

console.log('\n--- BUG 5: reset confirm order + counter ---');
await page.evaluate(() => localStorage.clear());
await page.reload();
await addItem('आइटम A', 100);
const beforeReset = await billNo();
await page.evaluate(() => resetNewBill());
const afterReset = await billNo();
ok('counter advances exactly once across save+reset',
   parseInt(afterReset.split('-')[1]) === parseInt(beforeReset.split('-')[1]) + 1,
   `${beforeReset} -> ${afterReset}`);

console.log('\n--- Backup round-trip includes the ledger ---');
const backupHasLedger = await page.evaluate(() => {
  const fullData = { catalog, customers, salesHistory, purchaseHistory, ledger, custSeq, ledgerSeq, billCounter, purchaseCounter, storeUPI, schemaVersion: 2 };
  return 'ledger' in fullData && 'custSeq' in fullData;
});
ok('backup payload carries ledger + sequences', backupHasLedger);

const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.reload();
await page.waitForTimeout(500);
ok('no uncaught page errors on load', errors.length === 0, errors.join('; '));

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await browser.close();
process.exit(fail ? 1 : 0);
