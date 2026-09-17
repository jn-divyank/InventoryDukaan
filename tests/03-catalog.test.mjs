/* The item catalog: chips, the directory modal, and the autosave that learns
 * new items as they are typed at the counter. */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, appState, lsJSON
} from './helpers.mjs';

const server = await startServer();
const { page, errors } = await launch({ egress: 'none' });
await page.goto(server.url, { waitUntil: 'load' });

const addCatalogItem = (name, mrp, disc = 0) => page.evaluate(a => {
  document.getElementById('mCatName').value = a.name;
  document.getElementById('mCatMRP').value = String(a.mrp);
  document.getElementById('mCatDisc').value = String(a.disc);
  saveManualCatalogItem();
}, { name, mrp, disc });

try {
  group('seeded catalog');
  await reset(page);
  let s = await appState(page);
  ok('a new shop starts with the 7 default items', s.catalog === 7, String(s.catalog));

  group('autosave learns items typed on a bill');
  await addItem(page, { name: 'नया आइटम', mrp: 640, disc: 5 });
  const saved = await lsJSON(page, 'asc_catalog');
  ok('the typed item is persisted to the catalog',
     saved.some(c => c.name === 'नया आइटम' && c.mrp === 640), JSON.stringify(saved.slice(0, 2)));
  ok('it is placed at the front for quick reuse', saved[0].name === 'नया आइटम', saved[0].name);

  // Re-typing the same name at a new price updates rather than duplicating.
  await addItem(page, { name: 'नया आइटम', mrp: 700, disc: 5 });
  const afterRepeat = await lsJSON(page, 'asc_catalog');
  ok('re-entering a known item does not duplicate it',
     afterRepeat.filter(c => c.name === 'नया आइटम').length === 1,
     String(afterRepeat.filter(c => c.name === 'नया आइटम').length));
  ok('and its price is updated', afterRepeat[0].mrp === 700, String(afterRepeat[0].mrp));

  // Case-insensitive dedupe.
  await addItem(page, { name: 'Steel Plate', mrp: 300 });
  await addItem(page, { name: 'steel plate', mrp: 320 });
  const cased = await lsJSON(page, 'asc_catalog');
  ok('dedupe ignores case',
     cased.filter(c => c.name.toLowerCase() === 'steel plate').length === 1,
     JSON.stringify(cased.filter(c => c.name.toLowerCase() === 'steel plate')));

  // Placeholder names must not pollute the catalog.
  await page.evaluate(() => {
    document.getElementById('itemName').value = '';
    document.getElementById('itemMRP').value = '99';
    addItemToList();
  });
  const withPlaceholder = await lsJSON(page, 'asc_catalog');
  ok('auto-generated "आइटम #n" names are not learned',
     !withPlaceholder.some(c => c.name.startsWith('आइटम #')),
     JSON.stringify(withPlaceholder.filter(c => c.name.startsWith('आइटम #'))));

  group('free text with quotes and markup renders safely');
  await reset(page);
  await addItem(page, { name: "Mother's Pride कढ़ाई", mrp: 850 });
  const chip = await page.evaluate(() => {
    renderCatalog();
    const el = [...document.querySelectorAll('.chip-btn')].find(b => b.textContent.includes('Mother'));
    if (!el) return { found: false };
    el.click();
    return { found: true, filled: document.getElementById('itemName').value };
  });
  ok('an apostrophe does not break the chip', chip.found, JSON.stringify(chip));
  ok('clicking the chip fills the item name', chip.filled === "Mother's Pride कढ़ाई", chip.filled);

  const injected = await page.evaluate(() => {
    catalog.unshift({ name: '<img src=x onerror="window.__pwned=1">', mrp: 5, disc: 0 });
    renderCatalog();
    renderModalCatList();
    return { pwned: !!window.__pwned,
             chipText: document.getElementById('chipsContainer').textContent.includes('<img') };
  });
  ok('markup in an item name does not execute', injected.pwned === false, JSON.stringify(injected));
  ok('it is shown as literal text instead', injected.chipText === true, JSON.stringify(injected));

  group('catalog directory');
  await reset(page);
  await addCatalogItem('हाथ से जोड़ा', 1234, 12);
  s = await appState(page);
  ok('manual add grows the catalog', s.catalog === 8, String(s.catalog));

  await page.reload({ waitUntil: 'load' });
  const persisted = await lsJSON(page, 'asc_catalog');
  ok('manual add survives a reload',
     persisted.some(c => c.name === 'हाथ से जोड़ा'),
     JSON.stringify(persisted.map(c => c.name)));

  await addCatalogItem('', 500);
  ok('an empty name is rejected', (await appState(page)).catalog === 8);
  await addCatalogItem('कोई दाम नहीं', 0);
  ok('a zero MRP is rejected', (await appState(page)).catalog === 8);

  group('deleting a catalog item persists');
  const before = (await appState(page)).catalog;
  await page.evaluate(() => deleteCatalogItem(0));
  ok('item removed from memory', (await appState(page)).catalog === before - 1);
  await page.reload({ waitUntil: 'load' });
  const after = (await appState(page)).catalog;
  ok('deletion survives a reload', after === before - 1, `expected ${before - 1}, got ${after}`);

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  server.stop();
  await finish();
}
