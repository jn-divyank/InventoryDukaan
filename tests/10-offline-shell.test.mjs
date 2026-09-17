/* The offline shell.
 *
 * The point of the feature: the shop's connection drops, he opens the app, and
 * it works. The data was always on the device; until now the app was not.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  launch, startServer, group, ok, finish, fatal, assertNoPageErrors, swActivated
} from './helpers.mjs';

const server = await startServer();
const { page, ctx, errors } = await launch({ egress: 'shim' });

try {
  group('manifest');
  const manifest = await (await fetch(`http://127.0.0.1:${server.port}/manifest.json`)).json();
  ok('manifest parses', !!manifest.name, JSON.stringify(Object.keys(manifest)));
  ok('installs as a standalone app, not a browser tab',
     manifest.display === 'standalone', manifest.display);
  ok('has a 192px icon', manifest.icons.some(i => i.sizes === '192x192'));
  ok('has a 512px icon', manifest.icons.some(i => i.sizes === '512x512'));
  ok('has a maskable icon for Android home screens',
     manifest.icons.some(i => i.purpose === 'maskable'));
  ok('start_url is the app root', manifest.start_url === '/', manifest.start_url);
  ok('theme colour matches the app header', manifest.theme_color === '#1e3a8a',
     manifest.theme_color);

  const iconRes = await fetch(`http://127.0.0.1:${server.port}/icons/icon-192.png`);
  const iconBytes = Buffer.from(await iconRes.arrayBuffer());
  ok('the icon is served and is a real PNG',
     iconRes.ok && iconBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
     `status=${iconRes.status} bytes=${iconBytes.length}`);

  group('the page links it');
  await page.goto(server.url, { waitUntil: 'load' });
  const links = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
    theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')
  }));
  ok('the manifest is linked', links.manifest === 'manifest.json', String(links.manifest));
  ok('the theme colour is declared', links.theme === '#1e3a8a', String(links.theme));
  ok('an apple-touch-icon is declared for iPhones', !!links.apple, String(links.apple));

  group('service worker registration');
  const reg = await swActivated(page);
  ok('the worker activates', reg.state === 'activated', reg.state);
  ok('its scope covers the whole app', reg.scope.endsWith('/'), reg.scope);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const c = await caches.open(names.find(n => n.startsWith('asc-shell-')));
    const keys = await c.keys();
    return { names, urls: keys.map(r => r.url) };
  });
  ok('a versioned shell cache exists',
     cached.names.some(n => /^asc-shell-v\d+$/.test(n)), JSON.stringify(cached.names));
  ok('the app itself is cached',
     cached.urls.some(u => u.endsWith('/index.html') || u.endsWith('/')), JSON.stringify(cached.urls));
  ok('supabase-js is cached, so sync still initialises offline',
     cached.urls.some(u => u.includes('supabase-js')), JSON.stringify(cached.urls));
  ok('tesseract is cached too', cached.urls.some(u => u.includes('tesseract')),
     JSON.stringify(cached.urls));
  ok('no third-party origin is required to start',
     cached.urls.every(u => u.startsWith('http://127.0.0.1')), JSON.stringify(cached.urls));
  ok('the icons are cached', cached.urls.some(u => u.includes('icon-192')));

  /* ------------------------------------------------------------------
     The real test. The shop's internet is gone: the static server is stopped
     AND the context is offline, so nothing can answer except the worker.
     ------------------------------------------------------------------ */
  group('opening the app with no connection at all');
  server.stop();
  await ctx.setOffline(true);

  const reloaded = await page.reload({ waitUntil: 'load' }).then(r => r?.status() ?? 'no-response')
                                                           .catch(e => 'THREW: ' + e.message);
  const offlineState = await page.evaluate(() => ({
    title: document.title,
    hasBillButton: !!document.getElementById('billNoDisplay'),
    supabaseLib: typeof window.supabase !== 'undefined',
    addItem: typeof addItemToList === 'function'
  })).catch(e => ({ error: e.message }));

  ok('the page loads with the network gone', offlineState.hasBillButton === true,
     JSON.stringify({ reloaded, offlineState }));
  ok('it is the real app, not an error page', (offlineState.title || '').includes('अर्पित'),
     String(offlineState.title));
  ok('supabase-js came from cache', offlineState.supabaseLib === true,
     JSON.stringify(offlineState));

  group('billing works offline');
  const billed = await page.evaluate(() => {
    localStorage.clear();
    document.getElementById('itemName').value = 'बिना नेट आइटम';
    document.getElementById('itemMRP').value = '450';
    addItemToList();
    saveCurrentBillToHistory();
    return { items: items.length, saved: salesHistory.length,
             total: calculateFinalBill().grandTotal };
  });
  ok('an item can be added with no connection', billed.items === 1, JSON.stringify(billed));
  ok('and the bill is saved locally', billed.saved === 1, JSON.stringify(billed));
  ok('with the right total', billed.total === 450, String(billed.total));

  await ctx.setOffline(false);

  /* ------------------------------------------------------------------
     A cached shell that never updates is worse than no cache: a deploy would
     silently never reach the shop. Served from a scratch copy so the repo is
     untouched while the "deploy" is simulated.
     ------------------------------------------------------------------ */
  group('a new deploy replaces the cached build');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'asc-deploy-'));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of ['index.html', 'sw.js', 'manifest.json',
                     'vendor/supabase-js.min.js', 'vendor/tesseract.min.js',
                     'icons/icon-192.png', 'icons/icon-512.png']) {
    await fs.mkdir(path.join(tmp, path.dirname(rel)), { recursive: true });
    await fs.copyFile(path.join(repo, rel), path.join(tmp, rel));
  }

  const deploy = await startServer(tmp);
  const h2 = await launch({ egress: 'none' });
  await h2.page.goto(deploy.url, { waitUntil: 'load' });
  const firstReg = await swActivated(h2.page);
  ok('the first build installs', firstReg.state === 'activated', firstReg.state);

  const before = await h2.page.evaluate(() => caches.keys());

  // "Deploy": change the app and bump the worker's cache version.
  const html = await fs.readFile(path.join(tmp, 'index.html'), 'utf8');
  await fs.writeFile(path.join(tmp, 'index.html'),
                     html.replace('</body>', '<div id="deployMarker">v2</div></body>'));
  const sw = await fs.readFile(path.join(tmp, 'sw.js'), 'utf8');
  await fs.writeFile(path.join(tmp, 'sw.js'),
                     sw.replace("CACHE_VERSION = 'v1'", "CACHE_VERSION = 'v2'"));

  // Browsers check for a worker update on navigation; skipWaiting + claim mean
  // the swap needs a further load to be the one serving the document.
  let marker = null, names = [];
  for (let i = 0; i < 5; i++) {
    await h2.page.reload({ waitUntil: 'load' });
    await swActivated(h2.page);
    // Force the update check the app also performs on load, rather than
    // waiting on the browser's own schedule.
    await h2.page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      try { await reg.update(); } catch {}
    });
    marker = await h2.page.evaluate(() => document.getElementById('deployMarker')?.textContent || null);
    names = await h2.page.evaluate(() => caches.keys());
    if (marker === 'v2' && names.includes('asc-shell-v2') && !names.includes('asc-shell-v1')) break;
  }

  ok('the new build is served, not the cached old one', marker === 'v2', String(marker));
  ok('the new cache version exists', names.includes('asc-shell-v2'), JSON.stringify(names));
  ok('the old cache is deleted rather than left to grow',
     !names.includes('asc-shell-v1'), JSON.stringify({ before, after: names }));

  deploy.stop();
  await fs.rm(tmp, { recursive: true, force: true });

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  try { server.stop(); } catch {}
  await finish();
}
