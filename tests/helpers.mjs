/* Shared test infrastructure.
 *
 * Exists because the egress shim was duplicated across two suites with silent
 * behavioural divergence, the reset idiom was copy-pasted five times, and the
 * pageerror handler was registered after the assertions it was meant to watch.
 * Every suite imports this so those decisions are made in exactly one place.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH
  || '/opt/node22/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);

/* ------------------------------------------------------------------ config */
export const SHOP_EMAIL = 'arpitsteel@gmail.com';   // never used for writes
export const LIVE_URL = process.env.LIVE_URL || 'https://arpit-steel-centre.vercel.app';

export function testCredentials() {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'E2E_EMAIL and E2E_PASSWORD must be set.\n' +
      'These are the dedicated test account, NOT the shop login. See tests/README.md.');
  }
  if (email === SHOP_EMAIL) {
    throw new Error('Refusing to run: E2E_EMAIL is the shop account. Tests must not write to real data.');
  }
  return { email, password };
}

/* --------------------------------------------------------------- reporting */
let pass = 0, fail = 0;
const failures = [];
const openBrowsers = new Set();

export function group(label) { console.log(`\n--- ${label} ---`); }

export function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
  return !!cond;
}

/** Waits for a condition and asserts it as one step, so a timeout fails with
 *  this assertion's name rather than being swallowed by `.catch(() => {})`. */
export async function okEventually(name, page, fn, { timeout = 20000, arg } = {}) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
    return ok(name, true);
  } catch (err) {
    return ok(name, false, `timed out after ${timeout}ms`);
  }
}

/** Passes when `fn` rejects. Impossible to express with the old helper. */
export async function okThrows(name, fn, extra = '') {
  try { await fn(); return ok(name, false, extra || 'did not throw'); }
  catch { return ok(name, true); }
}

/** Records a thrown error as a failed assertion. Without this, an exception in
 *  a suite body is swallowed by `finally { finish() }` — the run exits with a
 *  tally that silently omits every assertion after the throw. */
export function fatal(err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  ok('suite ran to completion', false, msg.split('\n').slice(0, 3).join(' | '));
}

export async function finish() {
  for (const b of openBrowsers) { try { await b.close(); } catch {} }
  openBrowsers.clear();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (failures.length) console.log('failed: ' + failures.join(' | '));
  process.exit(fail ? 1 : 0);
}

/* ------------------------------------------------------------------ launch */
/**
 * egress: 'none'  - no external requests expected (local, offline-only suites)
 *         'shim'  - fulfil external requests through Node's fetch
 *
 * The sandboxed Chromium does not trust the egress proxy's CA, so a browser
 * proxy setting fails with ERR_CERT_AUTHORITY_INVALID. Node's fetch does trust
 * it, so requests are relayed through the host process instead. Outside the
 * sandbox 'none' works everywhere and this is a no-op cost.
 */
export async function launch({ egress = 'none' } = {}) {
  const browser = await chromium.launch();
  openBrowsers.add(browser);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Registered BEFORE any navigation, so errors during the suite body are seen.
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept(''));   // confirm -> true, prompt -> ''

  if (egress === 'shim') await installFetchShim(page);
  return { browser, ctx, page, errors };
}

export function assertNoPageErrors(errors, label = 'no uncaught page errors') {
  return ok(label, errors.length === 0, errors.join(' | '));
}

/* -------------------------------------------------------------- fetch shim */
export async function installFetchShim(page, { bypass = ['http://127.0.0.1', 'http://localhost'] } = {}) {
  await page.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    if (bypass.some(p => url.startsWith(p))) return route.continue();
    try {
      const headers = { ...req.headers() };
      delete headers['host']; delete headers['origin']; delete headers['referer'];
      const resp = await fetch(url, {
        method: req.method(),
        headers,
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData(),
        redirect: 'follow'
      });
      const body = Buffer.from(await resp.arrayBuffer());
      const out = {};
      resp.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) out[k] = v;
      });
      // NOTE: forcing these means no suite can detect a real CORS regression.
      out['access-control-allow-origin'] = '*';
      out['access-control-allow-headers'] = '*';
      out['access-control-allow-methods'] = '*';
      out['access-control-expose-headers'] = '*';
      await route.fulfill({ status: resp.status, headers: out, body });
    } catch (e) {
      // Always logged: a silent abort is the hardest failure here to diagnose.
      console.log('  route error:', url.slice(0, 70), e.message);
      await route.abort();
    }
  });
}

/* --------------------------------------------------------- static server */
async function freePort() {
  return new Promise(res => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon'
};

/** Serves `root` on a free port. Deliberately dependency-free: relying on a
 *  globally installed http-server made the suite unrunnable elsewhere. */
export async function startServer(root = process.cwd()) {
  const port = await freePort();
  const srv = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const full = path.resolve(root, rel);
    if (!full.startsWith(path.resolve(root))) { res.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(full);
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream',
                           'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  return {
    port,
    url: `http://127.0.0.1:${port}/index.html`,
    stop: () => srv.close()
  };
}

/* ----------------------------------------------------------- app control */
/** Clears storage and reloads, so in-memory globals re-hydrate from scratch. */
export async function reset(page) {
  await page.evaluate(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.addItemToList === 'function', null, { timeout: 15000 });
}

export const addItem = (page, { name, mrp, qty = 1, disc = 0, unit = 'Pcs', warranty } = {}) =>
  page.evaluate(a => {
    document.getElementById('itemName').value = a.name;
    document.getElementById('itemMRP').value = String(a.mrp);
    document.getElementById('itemQty').value = String(a.qty);
    document.getElementById('itemUnit').value = a.unit;
    document.getElementById('itemDiscount').value = String(a.disc);
    if (a.warranty) document.getElementById('itemWarranty').value = a.warranty;
    addItemToList();
  }, { name, mrp, qty, disc, unit, warranty });

export const addCustomer = (page, { acc = '', name = '', phone = '', openingBal = 0 } = {}) =>
  page.evaluate(a => {
    document.getElementById('mCustAcc').value = a.acc;
    document.getElementById('mCustName').value = a.name;
    document.getElementById('mCustPhone').value = a.phone;
    document.getElementById('mCustOldBal').value = String(a.openingBal);
    saveManualCustomer();
  }, { acc, name, phone, openingBal });

export const selectCustomer = (page, text) =>
  page.evaluate(t => { document.getElementById('custInfo').value = t; onCustInput(); }, text);

export const saveBill = (page, payMode) =>
  page.evaluate(m => { if (m) setPaymentMode(m); saveCurrentBillToHistory(); }, payMode || null);

export const newBill = page => page.evaluate(() => resetNewBill());
export const setMode = (page, mode) => page.evaluate(m => setDocMode(m), mode);
export const billNo = page => page.evaluate(() => document.getElementById('billNoDisplay').innerText);
export const lsJSON = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), key);

/** One round trip for the values suites keep re-reading. */
export const appState = page => page.evaluate(() => ({
  billNo: document.getElementById('billNoDisplay').innerText,
  items: items.length,
  sales: salesHistory.length,
  purchases: purchaseHistory.length,
  customers: customers.length,
  catalog: catalog.length,
  ledger: ledger.length,
  pending: typeof dirtyCount === 'function' ? dirtyCount() : 0,
  storeId: typeof storeId !== 'undefined' ? storeId : null,
  totals: calculateFinalBill()
}));

/* --------------------------------------------------------------- backend */
export const signIn = (page, { email, password }) =>
  page.evaluate(async c => {
    const { error } = await sb.auth.signInWithPassword({ email: c.email, password: c.password });
    return error ? error.message : 'ok';
  }, { email, password });

export const signedInAs = page =>
  page.evaluate(async () => {
    const { data } = await sb.auth.getUser();
    return data?.user?.email || null;
  });

/** Syncs and waits for it to settle. Throws on timeout rather than continuing. */
export async function syncAndSettle(page, { timeout = 30000 } = {}) {
  const err = await page.evaluate(async () => {
    try { await syncNow(true); return null; } catch (e) { return e.message || String(e); }
  });
  await page.waitForFunction(() => !syncBusy, null, { timeout });
  if (err) throw new Error('sync failed: ' + err);
}

/** readTables(page, { documents: 'doc_no,grand_total', ... }) -> { documents: [...] } */
export const readTables = (page, spec) =>
  page.evaluate(async s => {
    const out = {};
    for (const [table, cols] of Object.entries(s)) {
      const { data, error } = await sb.from(table).select(cols);
      out[table] = error ? { error: error.message } : data;
    }
    return out;
  }, spec);

/* ------------------------------------------------------- data hygiene */
const COUNTED = ['documents', 'document_items', 'ledger_entries', 'parties', 'products'];

export const snapshotCounts = page =>
  page.evaluate(async tables => {
    const out = {};
    for (const t of tables) {
      const { count } = await sb.from(t).select('*', { count: 'exact', head: true });
      out[t] = count ?? 0;
    }
    return out;
  }, COUNTED);

export function assertDelta(name, before, after, table, expected) {
  const got = (after[table] ?? 0) - (before[table] ?? 0);
  return ok(name, got === expected, `${table} delta ${got}, expected ${expected}`);
}

/**
 * Deletes everything belonging to the signed-in user's store. RLS means this
 * can only ever reach the test store. Run it from a `finally` so an aborted run
 * still leaves a clean slate — the absence of this is why the old sync suite
 * could only be run once.
 */
export async function cleanupTestStore(page) {
  return page.evaluate(async shopEmail => {
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return 'not signed in';
    if (u.user.email === shopEmail) return 'refused: shop account';

    const { data: mem } = await sb.from('store_users').select('store_id');
    const ids = (mem || []).map(m => m.store_id);
    if (!ids.length) return 'no store';

    const { data: docs } = await sb.from('documents').select('id').in('store_id', ids);
    for (const d of (docs || [])) await sb.from('document_items').delete().eq('document_id', d.id);
    await sb.from('ledger_entries').delete().in('store_id', ids);
    await sb.from('documents').delete().in('store_id', ids);
    await sb.from('parties').delete().in('store_id', ids);
    await sb.from('products').delete().in('store_id', ids);
    await sb.from('stock_movements').delete().in('store_id', ids);
    await sb.from('doc_counters').delete().in('store_id', ids);
    return 'cleaned ' + ids.length + ' store(s)';
  }, SHOP_EMAIL);
}

/** Boots a page signed in as the test account, ready to sync. */
export async function bootSignedIn(url) {
  const h = await launch({ egress: 'shim' });
  await h.page.goto(url, { waitUntil: 'load' });
  await h.page.waitForFunction(() => typeof window.supabase !== 'undefined', null, { timeout: 30000 });
  await h.page.waitForFunction(() => window.sb !== null && window.sb !== undefined, null, { timeout: 30000 });
  await reset(h.page);
  await h.page.waitForFunction(() => window.sb !== null && window.sb !== undefined, null, { timeout: 30000 });
  const who = await signIn(h.page, testCredentials());
  if (who !== 'ok') throw new Error('test sign-in failed: ' + who);
  return h;
}
