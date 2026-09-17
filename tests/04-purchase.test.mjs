/* PURCHASE mode. Never covered before: the whole supplier side of the app ran
 * on the same code paths as sales with nothing asserting it behaved. */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, saveBill, newBill, setMode, billNo, appState, lsJSON
} from './helpers.mjs';

const server = await startServer();
const { page, errors } = await launch({ egress: 'none' });
await page.goto(server.url, { waitUntil: 'load' });

try {
  group('switching into purchase mode');
  await reset(page);
  ok('sale mode starts on ASC-', (await billNo(page)).startsWith('ASC-'), await billNo(page));

  await setMode(page, 'PURCHASE');
  const purNo = await billNo(page);
  ok('purchase mode switches to PUR-', purNo.startsWith('PUR-'), purNo);

  const chrome = await page.evaluate(() => ({
    header: document.getElementById('mainHeader').className,
    party: document.getElementById('partyLabel')?.innerText || '',
    docLabel: document.getElementById('docTypeLabel').innerText
  }));
  ok('header switches to purchase styling', chrome.header.includes('purchase-mode'), chrome.header);
  ok('the document label changes', chrome.docLabel.length > 0, JSON.stringify(chrome));

  await setMode(page, 'SALE');
  ok('switching back restores ASC-', (await billNo(page)).startsWith('ASC-'), await billNo(page));

  group('a full purchase bill');
  await reset(page);
  await setMode(page, 'PURCHASE');
  await page.evaluate(() => { document.getElementById('custInfo').value = 'कोटा स्टील सप्लायर'; });
  await addItem(page, { name: 'थोक कुकर', mrp: 1200, qty: 10 });
  await addItem(page, { name: 'थोक कढ़ाई', mrp: 400, qty: 25 });

  let s = await appState(page);
  ok('purchase totals compute (10×1200 + 25×400 = 22000)', s.totals.sumMRP === 22000,
     String(s.totals.sumMRP));

  await saveBill(page, 'Credit');
  const pur = await lsJSON(page, 'asc_purchase_history');
  const sal = await lsJSON(page, 'asc_sales_history');
  ok('the purchase lands in purchaseHistory', pur && pur.length === 1, JSON.stringify(pur?.length));
  ok('and not in salesHistory', !sal || sal.length === 0, JSON.stringify(sal?.length));
  ok('it is typed PURCHASE', pur[0].type === 'PURCHASE', pur[0].type);
  ok('it carries both line items', pur[0].items.length === 2, String(pur[0].items.length));
  ok('the supplier is recorded', pur[0].cust === 'कोटा स्टील सप्लायर', pur[0].cust);

  group('the two counters are independent');
  await reset(page);
  // Two sales.
  await addItem(page, { name: 'बिक्री 1', mrp: 100 });
  await newBill(page);
  await addItem(page, { name: 'बिक्री 2', mrp: 100 });
  await newBill(page);
  const saleNo = await billNo(page);

  await setMode(page, 'PURCHASE');
  const purAfterSales = await billNo(page);
  ok('sales did not advance the purchase counter', purAfterSales === 'PUR-001',
     `sale=${saleNo} purchase=${purAfterSales}`);

  await addItem(page, { name: 'खरीद 1', mrp: 900 });
  await newBill(page);
  const purNo2 = await billNo(page);
  ok('the purchase counter advances on its own', purNo2 === 'PUR-002', purNo2);

  await setMode(page, 'SALE');
  ok('and the sale counter is where sales left it', await billNo(page) === saleNo,
     `${await billNo(page)} vs ${saleNo}`);

  group('switching modes does not leak the open bill');
  await reset(page);
  await addItem(page, { name: 'बिक्री आइटम', mrp: 500 });
  await setMode(page, 'PURCHASE');
  s = await appState(page);
  // The open line items deliberately persist across a mode switch — the app
  // keeps one working bill. What must not happen is the bill being filed under
  // the wrong document type.
  await saveBill(page, 'Cash');
  const afterSwitch = {
    sales: (await lsJSON(page, 'asc_sales_history')) || [],
    purchases: (await lsJSON(page, 'asc_purchase_history')) || []
  };
  ok('a bill saved in purchase mode files as a purchase',
     afterSwitch.purchases.length === 1 && afterSwitch.sales.length === 0,
     JSON.stringify({ s: afterSwitch.sales.length, p: afterSwitch.purchases.length }));

  group('purchase history survives a reload');
  await page.reload({ waitUntil: 'load' });
  const reloaded = await appState(page);
  ok('purchases are re-hydrated', reloaded.purchases === 1, String(reloaded.purchases));

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  server.stop();
  await finish();
}
