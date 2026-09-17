/* Sync against the real Supabase project, plus the RLS isolation the whole
 * production-testing strategy rests on.
 *
 * Safety: signs in as the dedicated test account, which owns its own store.
 * Postgres — not convention — is what keeps the shop's rows out of reach.
 * Every assertion is a delta and cleanup runs in a finally, so the suite is
 * re-runnable after a crashed run.
 */
import {
  startServer, bootSignedIn, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, addCustomer, selectCustomer, saveBill, setMode, newBill, appState,
  syncAndSettle, readTables, snapshotCounts, assertDelta, cleanupTestStore,
  signedInAs, testCredentials, SHOP_EMAIL
} from './helpers.mjs';

const server = await startServer();
let h;

try {
  h = await bootSignedIn(server.url);
  const { page, errors } = h;

  group('signed in as the test account, not the shop');
  const who = await signedInAs(page);
  ok('signed in', !!who, String(who));
  ok('and it is NOT the shop account', who !== SHOP_EMAIL, String(who));

  // Any rows left by a previous interrupted run go first.
  await syncAndSettle(page);
  await cleanupTestStore(page);
  const before = await snapshotCounts(page);
  console.log('  baseline:', JSON.stringify(before));

  /* ------------------------------------------------------------ a credit sale */
  group('a credit sale reaches Postgres');
  await addCustomer(page, { acc: '12', name: "Ram'esh Traders", phone: '9876543210', openingBal: 500 });
  await selectCustomer(page, "[खाता: 12] Ram'esh Traders - 9876543210");
  await addItem(page, { name: 'कुकर 5L', mrp: 1850, qty: 2, disc: 10 });
  await saveBill(page, 'Credit');

  let local = await appState(page);
  ok('queued for sync before any network call', local.pending > 0, String(local.pending));

  await syncAndSettle(page);
  local = await appState(page);
  ok('queue drains', local.pending === 0, String(local.pending));
  ok('a store exists for the test account', !!local.storeId, String(local.storeId));

  let after = await snapshotCounts(page);
  assertDelta('exactly one document created', before, after, 'documents', 1);
  assertDelta('exactly one line item created', before, after, 'document_items', 1);
  assertDelta('exactly one ledger entry created', before, after, 'ledger_entries', 1);
  assertDelta('exactly one party created', before, after, 'parties', 1);

  const remote = await readTables(page, {
    documents: 'doc_no,doc_type,pay_mode,grand_total,party_text',
    document_items: 'name,qty,net_price',
    party_balances: 'name,balance',
    ledger_entries: 'entry_type,amount'
  });
  ok('the document is a credit SALE', remote.documents[0].doc_type === 'SALE'
     && remote.documents[0].pay_mode === 'Credit', JSON.stringify(remote.documents[0]));
  ok('the grand total matches (2 × 1850 − 10%)', Number(remote.documents[0].grand_total) === 3330,
     String(remote.documents[0].grand_total));
  ok('the line item carries its quantity', Number(remote.document_items[0].qty) === 2,
     JSON.stringify(remote.document_items[0]));
  ok('the server derives the same balance: 500 + 3330',
     Number(remote.party_balances[0].balance) === 3830, JSON.stringify(remote.party_balances));
  ok('an apostrophe survives the round trip',
     remote.party_balances[0].name.includes("Ram'esh"), remote.party_balances[0].name);

  /* ------------------------------------------------------------ idempotency */
  group('re-syncing everything creates nothing new');
  const beforeResync = await snapshotCounts(page);
  await page.evaluate(() => markAllDirty());
  await syncAndSettle(page);
  const afterResync = await snapshotCounts(page);
  for (const t of ['documents', 'document_items', 'ledger_entries', 'parties']) {
    assertDelta(`${t} unchanged by a full re-sync`, beforeResync, afterResync, t, 0);
  }

  /* ------------------------------------------- editing an already-synced bill */
  group('editing a credit bill after it has synced');
  // The shopkeeper reopens a bill to add a forgotten item and re-shares it.
  // The ledger entry must keep its client id, or its upsert collides with the
  // server's one-BILL-per-document index and wedges the queue permanently.
  const beforeEdit = await snapshotCounts(page);
  await addItem(page, { name: 'भूला हुआ आइटम', mrp: 500 });
  await saveBill(page, 'Credit');
  const ledgerIds = await page.evaluate(() =>
    ledger.filter(e => e.type === 'BILL').map(e => e.id));
  ok('re-saving reuses the ledger entry id', ledgerIds.length === 1, JSON.stringify(ledgerIds));

  await syncAndSettle(page);
  const afterEdit = await snapshotCounts(page);
  assertDelta('no extra document', beforeEdit, afterEdit, 'documents', 0);
  assertDelta('no extra ledger entry', beforeEdit, afterEdit, 'ledger_entries', 0);
  const editState = await page.evaluate(() => ({
    pending: dirtyCount(), chip: document.getElementById('syncChip').innerText }));
  ok('the sync queue still drains after an edit', editState.pending === 0, JSON.stringify(editState));

  const editedRemote = await readTables(page, { party_balances: 'balance', ledger_entries: 'amount' });
  ok('the server balance reflects the edit (500 + 3330 + 500)',
     Number(editedRemote.party_balances[0].balance) === 4330,
     JSON.stringify(editedRemote.party_balances));

  /* -------------------------------------------------------------- purchases */
  group('a purchase syncs as a purchase');
  await newBill(page);
  await setMode(page, 'PURCHASE');
  await selectCustomer(page, "[खाता: 12] Ram'esh Traders - 9876543210");
  await addItem(page, { name: 'थोक माल', mrp: 4000 });
  await saveBill(page, 'Cash');
  const beforePur = await snapshotCounts(page);
  await syncAndSettle(page);
  const afterPur = await snapshotCounts(page);
  assertDelta('one more document', beforePur, afterPur, 'documents', 1);

  const docs = await readTables(page, { documents: 'doc_no,doc_type' });
  ok('it is typed PURCHASE on the server',
     docs.documents.some(d => d.doc_type === 'PURCHASE'), JSON.stringify(docs.documents));
  ok('and numbered with the PUR- prefix',
     docs.documents.some(d => d.doc_no.startsWith('PUR-')), JSON.stringify(docs.documents));

  /* ------------------------------------------------- server-side guarantees */
  group('the database refuses a duplicate bill number');
  const dup = await page.evaluate(async () => {
    const { data: mem } = await sb.from('store_users').select('store_id').limit(1);
    const store = mem[0].store_id;
    const { data: existing } = await sb.from('documents').select('doc_no,doc_type').limit(1);
    const { error } = await sb.from('documents').insert({
      store_id: store, doc_no: existing[0].doc_no, doc_type: existing[0].doc_type,
      pay_mode: 'Cash', grand_total: 1
    });
    return error ? error.code : null;
  });
  ok('a second document with the same number is rejected', dup === '23505', String(dup));

  group('next_doc_no allocates without collisions');
  const allocated = await page.evaluate(async () => {
    const { data: mem } = await sb.from('store_users').select('store_id').limit(1);
    const store = mem[0].store_id;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => sb.rpc('next_doc_no', { p_store: store, p_type: 'SALE' })));
    return results.map(r => r.data);
  });
  ok('five concurrent calls return five distinct numbers',
     new Set(allocated).size === 5, JSON.stringify(allocated));

  group('a credit sale cannot be double-posted to the ledger');
  const doublePost = await page.evaluate(async () => {
    const { data: led } = await sb.from('ledger_entries')
      .select('store_id,party_id,document_id,amount').eq('entry_type', 'BILL').limit(1);
    if (!led?.length) return 'no bill entry';
    const { error } = await sb.from('ledger_entries').insert({ ...led[0], entry_type: 'BILL' });
    return error ? error.code : null;
  });
  ok('a second BILL row for the same document is rejected', doublePost === '23505', String(doublePost));

  /* ----------------------------------------------------------------- RLS */
  group('RLS keeps the shop out of reach');
  const isolation = await page.evaluate(async () => {
    const { data: mine } = await sb.from('store_users').select('store_id');
    const myIds = (mine || []).map(m => m.store_id);
    const { data: stores } = await sb.from('stores').select('id,name');
    const { data: allDocs } = await sb.from('documents').select('store_id');
    const { data: allParties } = await sb.from('parties').select('store_id');
    return {
      myIds,
      visibleStoreIds: (stores || []).map(s => s.id),
      visibleStoreNames: (stores || []).map(s => s.name),
      foreignDocs: (allDocs || []).filter(d => !myIds.includes(d.store_id)).length,
      foreignParties: (allParties || []).filter(p => !myIds.includes(p.store_id)).length
    };
  });
  ok('exactly one store is visible', isolation.visibleStoreIds.length === 1,
     JSON.stringify(isolation.visibleStoreNames));
  // Every store carries the same hardcoded shop name, so membership is what
  // has to be checked, not the label.
  ok('and it is one we are a member of — no other store is readable',
     isolation.visibleStoreIds.every(id => isolation.myIds.includes(id)),
     JSON.stringify({ visible: isolation.visibleStoreIds, mine: isolation.myIds }));
  ok('no documents from any other store are readable', isolation.foreignDocs === 0,
     String(isolation.foreignDocs));
  ok('no parties from any other store are readable', isolation.foreignParties === 0,
     String(isolation.foreignParties));

  const writeAttempt = await page.evaluate(async () => {
    const { data: stores } = await sb.from('stores').select('id');
    const mine = stores.map(s => s.id);
    // A store id that is definitely not ours.
    const foreign = '00000000-0000-0000-0000-0000000000ff';
    if (mine.includes(foreign)) return 'fixture clash';
    const { error } = await sb.from('parties').insert({ store_id: foreign, name: 'घुसपैठिया' });
    return error ? error.code : 'INSERT SUCCEEDED';
  });
  ok('writing into a store we are not a member of is refused',
     writeAttempt !== 'INSERT SUCCEEDED', String(writeAttempt));

  /* ------------------------------------------------------------- bad login */
  group('authentication failures');
  const badLogin = await page.evaluate(async c => {
    const { error } = await sb.auth.signInWithPassword({ email: c.email, password: 'definitely-wrong' });
    return error ? error.message : 'SIGNED IN';
  }, testCredentials());
  ok('a wrong password is rejected', badLogin !== 'SIGNED IN', badLogin);

  // A rejected sign-in clears the client session, and syncNow() returns early
  // without a user — so the session has to be re-established and observed
  // before anything downstream relies on syncing.
  await page.evaluate(async c => { await sb.auth.signInWithPassword(c); }, testCredentials());
  await page.waitForFunction(() => typeof sbUser !== 'undefined' && sbUser !== null,
                             null, { timeout: 20000 });
  ok('the session is restored after the failed attempt', !!(await signedInAs(page)));

  /* -------------------------------------------------------------- offline */
  group('offline billing');
  await setMode(page, 'SALE');
  await page.context().setOffline(true);
  const offline = await page.evaluate(() => {
    resetNewBill();
    const before = salesHistory.length;
    document.getElementById('itemName').value = 'ऑफलाइन आइटम';
    document.getElementById('itemMRP').value = '300';
    addItemToList();
    saveCurrentBillToHistory();
    return { before, after: salesHistory.length, pending: dirtyCount() };
  });
  ok('a bill can still be written with no network', offline.after === offline.before + 1,
     JSON.stringify(offline));
  ok('the work is queued rather than lost', offline.pending > 0, String(offline.pending));

  await page.context().setOffline(false);
  await syncAndSettle(page);
  const drained = await page.evaluate(() => ({
    pending: dirtyCount(),
    dirty,
    chip: document.getElementById('syncChip').innerText,
    signedIn: typeof sbUser !== 'undefined' && !!sbUser,
    ledgerRows: ledger.map(e => ({ id: e.id, type: e.type, billNo: e.billNo, amt: e.amount, party: e.partyId }))
  }));
  ok('the queue drains once the network returns', drained.pending === 0, JSON.stringify(drained));

  group('malformed dates do not reach the database');
  const dateFallback = await page.evaluate(() => {
    const iso = parseBillDate({ date: 'not-a-date' });
    return { iso, valid: !Number.isNaN(Date.parse(iso)) };
  });
  ok('an unparseable date falls back to a valid timestamp', dateFallback.valid,
     JSON.stringify(dateFallback));

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  // Always runs, so an aborted run still leaves a clean slate for the next one.
  if (h) {
    try { console.log('  cleanup:', await cleanupTestStore(h.page)); }
    catch (e) { console.log('  cleanup failed:', e.message); }
  }
  server.stop();
  await finish();
}
