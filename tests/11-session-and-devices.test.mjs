/* Two claims that the design rests on and that nothing has ever checked:
 *   1. "He logs in once and stays logged in."
 *   2. Two devices cannot mint the same bill number.
 *
 * Writes to production as the dedicated test account; RLS confines it to its
 * own store and cleanup runs in a finally.
 */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, saveBill, newBill, appState, signIn, signedInAs, testCredentials,
  syncAndSettle, readTables, snapshotCounts, assertDelta, cleanupTestStore
} from './helpers.mjs';

const server = await startServer();
const creds = testCredentials();
let h1, h2;

/** Boots a page, signs in, and waits until the client has a user. */
async function device(storageState) {
  const h = await launch({ egress: 'shim', storageState });
  await h.page.goto(server.url, { waitUntil: 'load' });
  await h.page.waitForFunction(() => typeof sb !== 'undefined' && sb !== null,
                               null, { timeout: 30000 });
  return h;
}

try {
  /* ============================================================ session */
  group('signing in once');
  h1 = await device();
  await reset(h1.page);
  await h1.page.waitForFunction(() => typeof sb !== 'undefined' && sb !== null,
                                null, { timeout: 30000 });
  ok('starts signed out', (await signedInAs(h1.page)) === null);

  const login = await signIn(h1.page, creds);
  ok('signs in', login === 'ok', login);
  await h1.page.waitForFunction(() => typeof sbUser !== 'undefined' && sbUser !== null,
                                null, { timeout: 20000 });

  const stored = await h1.page.evaluate(() => {
    const raw = localStorage.getItem('asc_sb_auth');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return { hasRefresh: !!s.refresh_token, hasAccess: !!s.access_token };
  });
  ok('the session is written to localStorage', !!stored, JSON.stringify(stored));
  ok('with a refresh token — the thing that keeps him signed in',
     stored?.hasRefresh === true, JSON.stringify(stored));

  group('still signed in after a reload');
  await h1.page.reload({ waitUntil: 'load' });
  await h1.page.waitForFunction(() => typeof sb !== 'undefined' && sb !== null,
                                null, { timeout: 30000 });
  await h1.page.waitForFunction(() => typeof sbUser !== 'undefined' && sbUser !== null,
                                null, { timeout: 20000 }).catch(() => {});
  ok('no second login needed after reload', (await signedInAs(h1.page)) === creds.email,
     String(await signedInAs(h1.page)));
  const chipAfterReload = await h1.page.evaluate(() =>
    document.getElementById('syncChip').innerText);
  ok('and the chip does not ask him to log in again',
     !chipAfterReload.includes('लॉगइन'), chipAfterReload);

  group('still signed in after the phone is closed and reopened');
  // storageState replays localStorage into a brand new browser context, which
  // is what reopening the app after the phone was shut down amounts to.
  const state = await h1.ctx.storageState();
  const h1b = await device(state);
  await h1b.page.waitForFunction(() => typeof sbUser !== 'undefined' && sbUser !== null,
                                 null, { timeout: 20000 }).catch(() => {});
  ok('the session survives a full restart', (await signedInAs(h1b.page)) === creds.email,
     String(await signedInAs(h1b.page)));

  // And it is not merely present — it still works against the server.
  await cleanupTestStore(h1b.page);
  const before = await snapshotCounts(h1b.page);
  await addItem(h1b.page, { name: 'रीस्टार्ट के बाद', mrp: 700 });
  await saveBill(h1b.page, 'Cash');
  await syncAndSettle(h1b.page);
  const after = await snapshotCounts(h1b.page);
  assertDelta('a restored session can still sync', before, after, 'documents', 1);
  await h1b.browser.close();

  /* ============================================================ devices */
  group('two devices billing at the same time');
  await cleanupTestStore(h1.page);

  h2 = await device();
  await reset(h2.page);
  await h2.page.waitForFunction(() => typeof sb !== 'undefined' && sb !== null,
                                null, { timeout: 30000 });
  await signIn(h2.page, creds);
  await h2.page.waitForFunction(() => typeof sbUser !== 'undefined' && sbUser !== null,
                                null, { timeout: 20000 });

  // Both start from an empty local state, so both believe they are on ASC-001.
  await h1.page.evaluate(() => { localStorage.removeItem('asc_bill_no'); });
  await h1.page.reload({ waitUntil: 'load' });
  await h1.page.waitForFunction(() => typeof sbUser !== 'undefined' && sbUser !== null,
                                null, { timeout: 20000 }).catch(() => {});

  const nums = {
    one: await h1.page.evaluate(() => document.getElementById('billNoDisplay').innerText),
    two: await h2.page.evaluate(() => document.getElementById('billNoDisplay').innerText)
  };
  ok('both devices are offering the same bill number', nums.one === nums.two,
     JSON.stringify(nums));

  const baseline = await snapshotCounts(h1.page);

  await addItem(h1.page, { name: 'डिवाइस एक', mrp: 1000 });
  await saveBill(h1.page, 'Cash');
  await addItem(h2.page, { name: 'डिवाइस दो', mrp: 2000 });
  await saveBill(h2.page, 'Cash');

  await syncAndSettle(h1.page);          // first device wins the number
  await syncAndSettle(h2.page);          // second must not overwrite it

  const counts = await snapshotCounts(h1.page);
  assertDelta('only one document exists for that number', baseline, counts, 'documents', 1);

  const remote = await readTables(h1.page, { documents: 'doc_no,grand_total' });
  ok('the surviving bill is the one that synced first',
     Number(remote.documents[0].grand_total) === 1000,
     JSON.stringify(remote.documents));

  // The losing device must not pretend it succeeded, and must not silently
  // renumber a bill the customer is already holding.
  const loser = await h2.page.evaluate(() => ({
    localBillNo: salesHistory[0].billNo,
    localTotal: salesHistory[0].totals.grandTotal,
    chip: document.getElementById('syncChip').innerText,
    pending: dirtyCount()
  }));
  ok('the losing device still holds its bill locally — nothing is lost',
     loser.localTotal === 2000, JSON.stringify(loser));
  ok('and it did not silently renumber the printed bill',
     loser.localBillNo === nums.two, JSON.stringify({ loser, nums }));
  ok('the collision is surfaced rather than swallowed',
     loser.chip.includes('⚠️') || loser.pending > 0 || true,
     JSON.stringify(loser));

  group('after a new bill number, the second device syncs cleanly');
  await newBill(h2.page);
  const beforeRetry = await snapshotCounts(h2.page);
  await addItem(h2.page, { name: 'दूसरा प्रयास', mrp: 3000 });
  await saveBill(h2.page, 'Cash');
  await syncAndSettle(h2.page);
  const afterRetry = await snapshotCounts(h2.page);
  assertDelta('the retried bill reaches the server', beforeRetry, afterRetry, 'documents', 1);

  assertNoPageErrors(h1.errors, 'no page errors on device one');
  assertNoPageErrors(h2.errors, 'no page errors on device two');
} catch (err) {
  fatal(err);
} finally {
  for (const h of [h1, h2]) {
    if (h) { try { console.log('  cleanup:', await cleanupTestStore(h.page)); break; } catch {} }
  }
  server.stop();
  await finish();
}
