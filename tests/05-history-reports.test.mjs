/* Bill history, the daily report, and the CSV exports the accountant receives. */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, saveBill, newBill, setMode, appState
} from './helpers.mjs';

const server = await startServer();
const { page, errors } = await launch({ egress: 'none' });
await page.goto(server.url, { waitUntil: 'load' });

/* Downloads go through Blob + an anchor click. Capture the Blob instead of
 * letting the browser save it. */
const captureDownload = async fn => {
  await page.evaluate(() => {
    window.__blob = null;
    if (!window.__origCreate) window.__origCreate = URL.createObjectURL;
    URL.createObjectURL = b => { window.__blob = b; return 'blob:captured'; };
    if (!window.__origClick) window.__origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__lastDownloadName = this.download; };
  });
  await page.evaluate(fn);
  return page.evaluate(async () => ({
    text: window.__blob ? await window.__blob.text() : null,
    // text() strips a leading BOM, so the first bytes are checked separately.
    head: window.__blob
      ? Array.from(new Uint8Array((await window.__blob.arrayBuffer()).slice(0, 3)))
      : null,
    name: window.__lastDownloadName || null
  }));
};

const billFor = async (name, mrp, mode, cust) => {
  if (cust !== undefined) await page.evaluate(c => { document.getElementById('custInfo').value = c; }, cust);
  await addItem(page, { name, mrp });
  await saveBill(page, mode);
  await newBill(page);
};

try {
  group('history list, tabs and search');
  await reset(page);
  await billFor('कुकर 5L', 1850, 'Cash', 'रमेश');
  await billFor('गैस स्टोव', 2600, 'Credit', 'सुरेश');
  await setMode(page, 'PURCHASE');
  await billFor('थोक माल', 5000, 'Cash', 'सप्लायर एक');
  await setMode(page, 'SALE');

  const saleRows = await page.evaluate(() => {
    setHistTab('SALE');
    return document.getElementById('historyListContainer').innerText;
  });
  ok('sale tab lists both sales', saleRows.includes('कुकर') && saleRows.includes('गैस'), saleRows.slice(0, 80));
  ok('sale tab excludes the purchase', !saleRows.includes('थोक माल'), saleRows.slice(0, 80));

  const purRows = await page.evaluate(() => {
    setHistTab('PURCHASE');
    return document.getElementById('historyListContainer').innerText;
  });
  ok('purchase tab lists the purchase', purRows.includes('थोक माल'), purRows.slice(0, 80));

  const searched = await page.evaluate(() => {
    setHistTab('SALE');
    document.getElementById('historySearchInput').value = 'सुरेश';
    renderHistoryList();
    return document.getElementById('historyListContainer').innerText;
  });
  ok('search narrows to the matching party', searched.includes('सुरेश') && !searched.includes('रमेश'),
     searched.slice(0, 80));

  const empty = await page.evaluate(() => {
    document.getElementById('historySearchInput').value = 'कोईनहीं';
    renderHistoryList();
    return document.getElementById('historyListContainer').innerText;
  });
  ok('a search with no hits shows an empty state', empty.trim().length > 0, empty.slice(0, 60));

  group('reprint and reshare a saved bill');
  const reprint = await page.evaluate(() => {
    document.getElementById('historySearchInput').value = '';
    renderHistoryList();
    let printed = false, opened = null;
    window.print = () => { printed = true; };
    window.open = u => { opened = u; return null; };
    // Both take a bill NUMBER plus the history type, not a list index.
    const no = salesHistory[0].billNo;
    reprintSavedBill(no, 'SALE');
    reshareSavedBill(no, 'SALE');
    return { printed, opened: opened ? opened.slice(0, 40) : null,
             no, slip: document.getElementById('printableSlip').innerHTML.length };
  });
  ok('reprint renders a slip and calls print', reprint.printed && reprint.slip > 0, JSON.stringify(reprint));
  ok('reshare opens a WhatsApp link', (reprint.opened || '').includes('whatsapp'), String(reprint.opened));

  /* ------------------------------------------------------------ daily report */
  group('daily report');
  await reset(page);
  await billFor('नकद', 1000, 'Cash');
  await billFor('यूपीआई', 2000, 'UPI');
  await billFor('उधार', 3000, 'Credit');
  await page.evaluate(() => {
    document.getElementById('itemName').value = 'स्प्लिट';
    document.getElementById('itemMRP').value = '1000';
    addItemToList();
    setPaymentMode('Split');
    document.getElementById('splitPaidAmt').value = '400';
    saveCurrentBillToHistory();
    resetNewBill();
  });
  await setMode(page, 'PURCHASE');
  await billFor('खरीद', 7000, 'Cash');
  await setMode(page, 'SALE');

  const report = await page.evaluate(() => {
    openDailyReportModal();
    return document.getElementById('dailyReportContent').innerText;
  });
  // Cash 1000 + split-paid 400 = 1400; UPI 2000; credit 3000 + split-balance 600 = 3600.
  ok('cash total includes the paid part of a split', report.includes('1,400'), report.replace(/\n/g, ' | '));
  ok('UPI total is separate', report.includes('2,000'), report.replace(/\n/g, ' | '));
  ok('credit total includes the unpaid part of a split', report.includes('3,600'), report.replace(/\n/g, ' | '));
  ok('purchases are reported too', report.includes('7,000'), report.replace(/\n/g, ' | '));

  /* -------------------------------------------------------------- CSV export */
  group('CSV exports');
  const daily = await captureDownload(() => exportDailyExcelCSV());
  const dailyLines = (daily.text || '').replace(/^\uFEFF/, '').trim().split('\n');
  ok('daily CSV has a header row', dailyLines[0].startsWith('Type,Bill No'), dailyLines[0]);
  // header + 4 sales + 1 purchase
  ok('daily CSV has a row per document booked today', dailyLines.length === 6, `lines=${dailyLines.length}`);
  ok('daily CSV now also covers purchases, matching the daily report',
     (daily.text || '').includes('"PURCHASE"'), (daily.text || '').slice(0, 200));
  ok('daily CSV filename is dated', (daily.name || '').includes('Daily_Report'), String(daily.name));
  const all = await captureDownload(() => exportAllBillsCSV());
  ok('complete ledger includes both sales and purchases',
     (all.text || '').includes('"SALE"') && (all.text || '').includes('"PURCHASE"'),
     (all.text || '').slice(0, 120));

  group('CSV quoting and encoding');
  await reset(page);
  await page.evaluate(() => { document.getElementById('custInfo').value = 'Ram "Bhai" Traders'; });
  await addItem(page, { name: 'आइटम', mrp: 100 });
  await saveBill(page, 'Cash');
  const quoted = await captureDownload(() => exportAllBillsCSV());
  const row = (quoted.text || '').replace(/^\uFEFF/, '').split('\n')[1] || '';
  // Proper CSV doubles an embedded quote. The app interpolates it raw, so the
  // field terminates early and every later column shifts.
  ok('a double quote in a party name is doubled, per RFC 4180',
     row.includes('"Ram ""Bhai"" Traders"'), row.slice(0, 140));

  ok('CSV starts with a UTF-8 BOM so Excel renders Hindi correctly',
     JSON.stringify(quoted.head) === JSON.stringify([0xEF, 0xBB, 0xBF]),
     'first bytes ' + JSON.stringify(quoted.head));

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  server.stop();
  await finish();
}
