/* The counter workflow: entering items, pricing them, and numbering the bill.
 * No network. */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, saveBill, newBill, billNo, appState, lsJSON
} from './helpers.mjs';

const server = await startServer();
const { page, errors } = await launch({ egress: 'none' });
await page.goto(server.url, { waitUntil: 'load' });

try {
  /* ------------------------------------------------------------ line items */
  group('line items');
  await reset(page);
  await addItem(page, { name: 'कुकर 5L', mrp: 1850, qty: 2, disc: 10 });
  let s = await appState(page);
  ok('item added', s.items === 1, JSON.stringify(s.items));
  ok('2 × ₹1850 = ₹3700 MRP', s.totals.sumMRP === 3700, String(s.totals.sumMRP));
  ok('10% off → ₹3330', s.totals.grandTotal === 3330, String(s.totals.grandTotal));

  await addItem(page, { name: 'गैस स्टोव 2B', mrp: 2600 });
  s = await appState(page);
  ok('second item accumulates MRP', s.totals.sumMRP === 6300, String(s.totals.sumMRP));

  // editItemInList pulls the row back into the form AND splices it out, so the
  // list shrinks by one until it is re-added.
  await page.evaluate(() => editItemInList(0));
  s = await appState(page);
  ok('editing removes the row from the list', s.items === 1, String(s.items));
  const formValue = await page.evaluate(() => document.getElementById('itemName').value);
  ok('editing loads the row into the form', formValue === 'कुकर 5L', formValue);

  await page.evaluate(() => addItemToList());
  await page.evaluate(() => deleteItem(0));
  s = await appState(page);
  ok('deleteItem removes exactly one row', s.items === 1, String(s.items));

  group('rejects unusable input');
  await reset(page);
  await addItem(page, { name: 'बिना दाम', mrp: 0 });
  s = await appState(page);
  ok('MRP of 0 is rejected', s.items === 0, String(s.items));

  /* ------------------------------------------------------------ gram unit */
  group('gram unit is priced per kilo');
  await reset(page);
  await addItem(page, { name: 'स्टील स्क्रैप', mrp: 280, qty: 500, unit: 'Gram' });
  s = await appState(page);
  // effectiveQty = 500/1000 = 0.5, so 280 × 0.5 = 140.
  ok('500 g at ₹280/kg = ₹140', s.totals.sumMRP === 140, String(s.totals.sumMRP));
  const gramRow = await page.evaluate(() => ({ qty: items[0].qty, unit: items[0].unit }));
  ok('the row still records 500 Gram, not 0.5', gramRow.qty === 500 && gramRow.unit === 'Gram',
     JSON.stringify(gramRow));

  /* ------------------------------------------------------------- warranty */
  group('warranty');
  await reset(page);
  await addItem(page, { name: 'मिक्सर ग्राइंडर', mrp: 2800, warranty: '2 वर्ष' });
  await saveBill(page);
  const withWarranty = await lsJSON(page, 'asc_sales_history');
  ok('warranty is carried into history', withWarranty[0].items[0].warranty === '2 वर्ष',
     withWarranty[0].items[0].warranty);

  /* ------------------------------------------- discounts and deductions */
  group('discounts, scrap and round-off');
  await reset(page);
  await addItem(page, { name: 'आइटम', mrp: 1000 });
  await page.evaluate(() => applyExtraPercent(10));
  s = await appState(page);
  ok('applyExtraPercent(10) deducts ₹100 of ₹1000', s.totals.extra === 100, String(s.totals.extra));
  ok('grand total falls to ₹900', s.totals.grandTotal === 900, String(s.totals.grandTotal));

  await page.evaluate(() => {
    document.getElementById('extraDiscount').value = '0';
    document.getElementById('scrapDeduction').value = '150';
    saveDeductions();
  });
  s = await appState(page);
  ok('scrap deduction comes off the total', s.totals.grandTotal === 850, String(s.totals.grandTotal));

  // A known design trap worth pinning: scrap exists both as a catalog line item
  // and as a deduction field, so entering both subtracts it twice.
  await page.evaluate(() => {
    document.getElementById('itemName').value = 'स्टील स्क्रैप / पुराना';
    document.getElementById('itemMRP').value = '150';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemDiscount').value = '0';
    addItemToList();
  });
  s = await appState(page);
  ok('KNOWN QUIRK: scrap line + scrap field both subtract (₹1000 + ₹150 − ₹150 field = ₹1000)',
     s.totals.grandTotal === 1000, String(s.totals.grandTotal));

  group('round-off');
  await reset(page);
  await addItem(page, { name: 'विषम', mrp: 1000, disc: 7.5 });
  const rounded = await page.evaluate(() => {
    document.getElementById('autoRoundOff').checked = true;
    const on = calculateFinalBill().grandTotal;
    document.getElementById('autoRoundOff').checked = false;
    const off = calculateFinalBill().grandTotal;
    return { on, off };
  });
  ok('round-off yields a whole rupee value', Number.isInteger(rounded.on), JSON.stringify(rounded));

  /* -------------------------------------------------------- payment modes */
  group('payment modes');
  for (const mode of ['Cash', 'UPI', 'Credit']) {
    await reset(page);
    await addItem(page, { name: 'टेस्ट', mrp: 500 });
    await saveBill(page, mode);
    const h = await lsJSON(page, 'asc_sales_history');
    ok(`${mode} bill records its mode`, h[0].payMode === mode, h[0].payMode);
  }

  await reset(page);
  await addItem(page, { name: 'स्प्लिट', mrp: 1000 });
  await page.evaluate(() => {
    setPaymentMode('Split');
    document.getElementById('splitPaidAmt').value = '400';
  });
  s = await appState(page);
  ok('split records what was paid', s.totals.splitPaid === 400, String(s.totals.splitPaid));
  ok('split computes the remaining ₹600', s.totals.splitBalance === 600, String(s.totals.splitBalance));

  /* ------------------------------------------------------- bill numbering */
  group('bill numbering');
  await reset(page);
  await addItem(page, { name: 'कुकर 5L', mrp: 1850 });
  const first = await billNo(page);
  await saveBill(page);                       // shopkeeper prints, then closes the app
  await page.reload({ waitUntil: 'load' });
  const second = await billNo(page);
  ok('number advances on first save, without pressing New', first !== second, `${first} -> ${second}`);

  await addItem(page, { name: 'गैस स्टोव 2B', mrp: 2600 });
  await saveBill(page);
  const hist = await lsJSON(page, 'asc_sales_history');
  ok('both sales retained, neither overwritten', hist.length === 2, `length=${hist.length}`);
  ok('bill numbers are distinct', hist[0].billNo !== hist[1].billNo,
     JSON.stringify(hist.map(h => h.billNo)));

  await reset(page);
  await addItem(page, { name: 'आइटम A', mrp: 100 });
  const before = await billNo(page);
  await newBill(page);
  const after = await billNo(page);
  ok('counter advances exactly once across save + New',
     parseInt(after.split('-')[1]) === parseInt(before.split('-')[1]) + 1, `${before} -> ${after}`);

  // An open bill keeps its number until New: adding more and re-saving edits it.
  await reset(page);
  await addItem(page, { name: 'पहला', mrp: 100 });
  await saveBill(page);
  await addItem(page, { name: 'दूसरा', mrp: 200 });
  await saveBill(page);
  const edited = await lsJSON(page, 'asc_sales_history');
  ok('re-saving an open bill edits it rather than creating a second',
     edited.length === 1 && edited[0].items.length === 2,
     `bills=${edited.length} items=${edited[0]?.items.length}`);

  /* --------------------------------------------------- keyboard focus chain */
  group('keyboard focus chain');
  await reset(page);
  const chain = await page.evaluate(async () => {
    const press = id => {
      const el = document.getElementById(id);
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return document.activeElement.id;
    };
    document.getElementById('itemName').value = 'चेन टेस्ट';
    document.getElementById('itemMRP').value = '100';
    return {
      cust: press('custInfo'),
      name: press('itemName'),
      qty: press('itemQty'),
      mrp: press('itemMRP')
    };
  });
  ok('customer → item name', chain.cust === 'itemName', chain.cust);
  ok('item name → qty', chain.name === 'itemQty', chain.qty);
  ok('qty → MRP', chain.qty === 'itemMRP', chain.qty);
  ok('MRP → discount', chain.mrp === 'itemDiscount', chain.mrp);

  const added = await page.evaluate(() => {
    const el = document.getElementById('itemDiscount');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return items.length;
  });
  ok('Enter on discount adds the item', added === 1, String(added));

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  server.stop();
  await finish();
}
