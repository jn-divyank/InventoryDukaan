/* What happens when the phone runs out of room, or storage is unavailable.
 *
 * persist() has always had a catch and a warning; neither had ever executed.
 * On a full phone this is the difference between the shopkeeper seeing a
 * warning and quietly losing the day's bills.
 */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, saveBill, appState, fillStorage, freeStorage
} from './helpers.mjs';

const server = await startServer();
const { page, errors } = await launch({ egress: 'none' });
await page.goto(server.url, { waitUntil: 'load' });

try {
  group('a full phone is reported, not ignored');
  await reset(page);
  await page.evaluate(() => {
    window.__alerts = [];
    window.alert = m => window.__alerts.push(m);
  });

  const filled = await fillStorage(page);
  ok('localStorage is genuinely full — even a one-byte write fails',
     filled.blocks > 0 && filled.stillWritable === false, JSON.stringify(filled));

  const attempt = await page.evaluate(() => {
    const wrote = persist('asc_probe', { hello: 'world' });
    return { wrote, alerts: window.__alerts.length, latched: storageFull };
  });
  ok('persist() reports failure rather than returning success',
     attempt.wrote === false, JSON.stringify(attempt));
  ok('the shopkeeper is warned', attempt.alerts === 1, JSON.stringify(attempt));
  ok('the warning names the backup button as the way out',
     await page.evaluate(() => window.__alerts[0].includes('बैकअप')),
     await page.evaluate(() => window.__alerts[0] || ''));
  ok('the full-storage state latches', attempt.latched === true, JSON.stringify(attempt));

  group('the warning does not repeat on every keystroke');
  const repeated = await page.evaluate(() => {
    for (let i = 0; i < 20; i++) persist('asc_probe_' + i, { i });
    return window.__alerts.length;
  });
  ok('still only one alert after twenty more failed writes', repeated === 1, String(repeated));

  group('a bill that could not be saved is not reported as saved');
  const billed = await page.evaluate(() => {
    document.getElementById('itemName').value = 'भरी मेमोरी';
    document.getElementById('itemMRP').value = '500';
    addItemToList();
    const inMemory = items.length;
    const onDisk = JSON.parse(localStorage.getItem('asc_current_items') || '[]').length;
    return { inMemory, onDisk };
  });
  // The honest outcome: the item is in memory and visibly on screen, but the
  // write failed — and the shopkeeper has been told.
  ok('the item is still usable on screen', billed.inMemory === 1, JSON.stringify(billed));
  ok('and the failed write is visible rather than silent',
     billed.onDisk !== billed.inMemory, JSON.stringify(billed));

  group('writes resume once space is freed');
  const freed = await freeStorage(page);
  ok('padding removed', freed > 0, String(freed));
  const resumed = await page.evaluate(() => {
    storageFull = false;               // the app clears this on reload
    const wrote = persist('asc_probe', { ok: true });
    return { wrote, readBack: JSON.parse(localStorage.getItem('asc_probe') || 'null') };
  });
  ok('persist() succeeds again', resumed.wrote === true, JSON.stringify(resumed));
  ok('and the value round-trips', resumed.readBack?.ok === true, JSON.stringify(resumed));

  group('billing works normally after recovery');
  await reset(page);
  await addItem(page, { name: 'रिकवरी के बाद', mrp: 900 });
  await saveBill(page, 'Cash');
  const s = await appState(page);
  ok('a bill saves once there is room', s.sales === 1, String(s.sales));

  /* ------------------------------------------------------------------
     Private mode, or a browser with site data blocked: localStorage throws on
     read. The app reads it at init, before any guard, so this checks it still
     renders rather than dying on a blank screen.
     ------------------------------------------------------------------ */
  group('storage blocked entirely (private mode)');
  const blocked = await launch({ egress: 'none' });
  await blocked.page.addInitScript(() => {
    const boom = () => { throw new DOMException('denied', 'SecurityError'); };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 }; }
    });
  });
  const blockedErrors = [];
  blocked.page.on('pageerror', e => blockedErrors.push(e.message));
  await blocked.page.goto(server.url, { waitUntil: 'load' });

  /* Asserting only that the page "renders" would pass on a completely dead
     app — the markup is static. What matters is whether he can bill. */
  const usable = await blocked.page.evaluate(() => {
    const out = {};
    try { out.catalogReady = Array.isArray(catalog) && catalog.length > 0; }
    catch (e) { out.catalogReady = 'THREW: ' + e.message; }
    try { out.itemsReady = Array.isArray(items); }
    catch (e) { out.itemsReady = 'THREW: ' + e.message; }
    try {
      document.getElementById('itemName').value = 'निजी मोड आइटम';
      document.getElementById('itemMRP').value = '250';
      document.getElementById('itemQty').value = '2';
      addItemToList();
      out.added = items.length;
      out.total = calculateFinalBill().grandTotal;
    } catch (e) { out.added = 'THREW: ' + e.message; }
    try { out.billText = buildBillText().includes('निजी मोड आइटम'); }
    catch (e) { out.billText = 'THREW: ' + e.message; }
    out.storageFlag = typeof storageUsable !== 'undefined' ? storageUsable : 'undefined';
    return out;
  }).catch(e => ({ error: e.message }));

  ok('the item catalog still initialises', usable.catalogReady === true, JSON.stringify(usable));
  ok('the bill list still initialises', usable.itemsReady === true, JSON.stringify(usable));
  ok('an item can actually be added', usable.added === 1, JSON.stringify(usable));
  ok('totals compute (2 × ₹250)', usable.total === 500, JSON.stringify(usable));
  ok('a bill can still be produced to print or share', usable.billText === true,
     JSON.stringify(usable));
  ok('the app knows storage is unusable', usable.storageFlag === false, JSON.stringify(usable));
  ok('no uncaught error while storage is blocked', blockedErrors.length === 0,
     blockedErrors.slice(0, 2).join(' | '));
  await blocked.browser.close();

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  server.stop();
  await finish();
}
