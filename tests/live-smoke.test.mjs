import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const LIVE = 'https://arpit-steel-centre.vercel.app';
let pass=0, fail=0;
const ok=(n,c,x='')=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+(x?'  -> '+x:''));} };

const browser = await chromium.launch();
const page = await browser.newPage();
const errs=[]; page.on('pageerror', e=>errs.push(e.message));
// Sandbox Chromium distrusts the egress proxy CA; fulfil every request via Node fetch.
await page.route('**/*', async route => {
  const req=route.request();
  try {
    const h={...req.headers()}; delete h['host']; delete h['origin']; delete h['referer'];
    const r=await fetch(req.url(), { method:req.method(), headers:h,
      body:['GET','HEAD'].includes(req.method())?undefined:req.postData(), redirect:'follow' });
    const b=Buffer.from(await r.arrayBuffer()); const out={};
    r.headers.forEach((v,k)=>{ if(!['content-encoding','content-length','transfer-encoding'].includes(k)) out[k]=v; });
    out['access-control-allow-origin']='*'; out['access-control-allow-headers']='*';
    out['access-control-allow-methods']='*'; out['access-control-expose-headers']='*';
    await route.fulfill({ status:r.status, headers:out, body:b });
  } catch(e){ await route.abort(); }
});

await page.goto(LIVE, { waitUntil:'load' });
await page.waitForTimeout(4000);

ok('live page loads', await page.title() !== '');
ok('supabase-js present', await page.evaluate(()=>typeof window.supabase!=='undefined'));
ok('sync chip rendered', await page.evaluate(()=>!!document.getElementById('syncChip')));
console.log('  chip reads:', await page.evaluate(()=>document.getElementById('syncChip').innerText));

console.log('\n--- sign in with the real shop credentials ---');
const login = await page.evaluate(async () => {
  const { error } = await sb.auth.signInWithPassword({ email:'arpitsteel@gmail.com', password:'arpitsteel' });
  return error ? error.message : 'ok';
});
ok('login succeeds', login==='ok', login);

// Let the store bootstrap run. No bills are created: this is production.
await page.evaluate(()=>syncNow(true));
await page.waitForFunction(()=>!syncBusy, {timeout:20000}).catch(()=>{});
const st = await page.evaluate(()=>({ store:storeId, chip:document.getElementById('syncChip').innerText, pending:dirtyCount() }));
console.log('  state:', JSON.stringify(st));
ok('store bootstrapped', !!st.store, String(st.store));
ok('nothing left queued', st.pending===0, String(st.pending));

const remote = await page.evaluate(async ()=>{
  const { data:s }=await sb.from('stores').select('name,phone,upi_id');
  const { data:d }=await sb.from('documents').select('doc_no');
  return { stores:s, docs:d };
});
console.log('  remote:', JSON.stringify(remote));
ok('store row exists with shop details', remote.stores?.length===1, JSON.stringify(remote.stores));
ok('no stray test bills in production', remote.docs?.length===0, JSON.stringify(remote.docs));
ok('no uncaught page errors', errs.length===0, errs.join(' | '));

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await browser.close();
process.exit(fail?1:0);
