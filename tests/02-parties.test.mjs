/* Parties and the khata ledger. Balances must be derived, never hand-held. */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, addCustomer, selectCustomer, saveBill, setMode, appState, lsJSON
} from './helpers.mjs';

const server = await startServer();
const { page, errors } = await launch({ egress: 'none' });
await page.goto(server.url, { waitUntil: 'load' });

const RAMESH = "[खाता: 12] Ram'esh Traders - 9876543210";
const seedParty = async (openingBal = 500) => {
  await addCustomer(page, { acc: '12', name: "Ram'esh Traders", phone: '9876543210', openingBal });
  await selectCustomer(page, RAMESH);
};
const balance = () => page.evaluate(() => partyBalance(customers[0]));

try {
  group('party creation and matching');
  await reset(page);
  await seedParty();
  let s = await appState(page);
  ok('party saved', s.customers === 1, String(s.customers));
  ok('opening balance shows as the current balance', await balance() === 500, String(await balance()));

  const matched = await page.evaluate(() => {
    const byAcc = findCustomerByInfo('[खाता: 12] whoever');
    const byPhone = findCustomerByInfo('कोई भी - 9876543210');
    const none = findCustomerByInfo('अजनबी');
    return { byAcc: byAcc?.id ?? null, byPhone: byPhone?.id ?? null, none };
  });
  ok('party matched by खाता number', matched.byAcc !== null, JSON.stringify(matched));
  ok('party matched by phone', matched.byPhone !== null, JSON.stringify(matched));
  ok('unknown text matches nobody', matched.none === null, JSON.stringify(matched));

  group('editing a party preserves its identity');
  const idBefore = await page.evaluate(() => customers[0].id);
  await addCustomer(page, { acc: '12', name: 'Ramesh Traders Ltd', phone: '9876543210', openingBal: 500 });
  const idAfter = await page.evaluate(() => customers[0].id);
  ok('id survives an edit, so ledger entries stay linked', idBefore === idAfter,
     `${idBefore} -> ${idAfter}`);
  ok('no duplicate party created', (await appState(page)).customers === 1);

  group('credit sales post to the khata');
  await reset(page);
  await seedParty();
  await addItem(page, { name: 'मिक्सर ग्राइंडर', mrp: 2800 });
  await saveBill(page, 'Credit');
  ok('₹500 opening + ₹2800 credit = ₹3300', await balance() === 3300, String(await balance()));

  await saveBill(page, 'Credit');
  ok('re-saving the same bill does not double-post', await balance() === 3300, String(await balance()));

  await page.reload({ waitUntil: 'load' });
  ok('balance survives a reload because it is derived', await balance() === 3300, String(await balance()));

  group('cash sales do not touch the khata');
  await reset(page);
  await seedParty();
  await addItem(page, { name: 'नकद आइटम', mrp: 900 });
  await saveBill(page, 'Cash');
  ok('a cash sale leaves the balance at the opening ₹500', await balance() === 500, String(await balance()));

  group('split sales post only the unpaid part');
  await reset(page);
  await seedParty(0);
  await addItem(page, { name: 'स्प्लिट आइटम', mrp: 1000 });
  await page.evaluate(() => {
    setPaymentMode('Split');
    document.getElementById('splitPaidAmt').value = '400';
    saveCurrentBillToHistory();
  });
  ok('only the ₹600 balance is owed, not the full ₹1000', await balance() === 600, String(await balance()));

  group('purchases on credit mean the shop owes the supplier');
  await reset(page);
  await seedParty(0);
  await setMode(page, 'PURCHASE');
  await selectCustomer(page, RAMESH);
  await addItem(page, { name: 'थोक माल', mrp: 5000 });
  await saveBill(page, 'Credit');
  ok('a credit purchase posts a negative balance', await balance() === -5000, String(await balance()));

  group('recording a payment');
  await reset(page);
  await seedParty();
  await addItem(page, { name: 'उधार आइटम', mrp: 2800 });
  await saveBill(page, 'Credit');

  // recordPayment reads its amount from prompt(); drive it directly.
  await page.evaluate(() => { window.prompt = () => '1300'; recordPayment(0); });
  ok('payment reduces the balance to ₹2000', await balance() === 2000, String(await balance()));

  await page.evaluate(() => { window.prompt = () => '0'; recordPayment(0); });
  ok('a zero payment is rejected', await balance() === 2000, String(await balance()));

  await page.evaluate(() => { window.prompt = () => '-500'; recordPayment(0); });
  ok('a negative payment is rejected', await balance() === 2000, String(await balance()));

  await page.evaluate(() => { window.prompt = () => 'abcd'; recordPayment(0); });
  ok('a non-numeric payment is rejected', await balance() === 2000, String(await balance()));

  await page.evaluate(() => { window.prompt = () => null; recordPayment(0); });
  ok('cancelling the prompt records nothing', await balance() === 2000, String(await balance()));

  const led = await lsJSON(page, 'asc_ledger');
  ok('exactly one BILL and one PAYMENT entry stored',
     led.filter(e => e.type === 'BILL').length === 1 && led.filter(e => e.type === 'PAYMENT').length === 1,
     JSON.stringify(led.map(e => e.type)));

  group('deleting a party persists');
  await reset(page);
  await seedParty();
  await page.evaluate(() => deleteCustomer(0));
  ok('party removed from memory', (await appState(page)).customers === 0);
  await page.reload({ waitUntil: 'load' });
  const afterReload = await appState(page);
  ok('deletion survives a reload', afterReload.customers === 0, `customers=${afterReload.customers}`);

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  server.stop();
  await finish();
}
