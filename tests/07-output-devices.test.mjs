/* Everything that leaves the app: the bill text, WhatsApp, the thermal slip,
 * the UPI QR — plus the two input paths that depend on browser APIs (OCR and
 * voice). The APIs are stubbed; our own logic around them is what is asserted. */
import {
  launch, startServer, reset, group, ok, finish, fatal, assertNoPageErrors,
  addItem, addCustomer, selectCustomer, saveBill, appState
} from './helpers.mjs';

const server = await startServer();
const { page, errors } = await launch({ egress: 'none' });
await page.goto(server.url, { waitUntil: 'load' });

try {
  group('bill text');
  await reset(page);
  await addItem(page, { name: 'कुकर 5L', mrp: 1850, qty: 2, disc: 10 });
  let text = await page.evaluate(() => buildBillText());
  ok('names the shop', text.includes('अर्पित स्टील सेंटर'), text.slice(0, 40));
  ok('lists the item with quantity', text.includes('कुकर 5L') && text.includes('2 Pcs'),
     text.slice(0, 200));
  ok('shows the grand total', text.includes('3330') || text.includes('3,330'), text.slice(0, 300));
  ok('defaults to a cash label', text.includes('नकद'), text.slice(0, 200));

  const credit = await page.evaluate(() => { setPaymentMode('Credit'); return buildBillText(); });
  ok('a credit bill is labelled उधार', credit.includes('उधार'), credit.slice(0, 200));

  const split = await page.evaluate(() => {
    setPaymentMode('Split');
    document.getElementById('splitPaidAmt').value = '1000';
    return buildBillText();
  });
  ok('a split bill shows paid and remaining', split.includes('1000') && split.includes('2330'),
     split.slice(0, 400));

  group('previous balance appears only when there is one');
  await reset(page);
  await addItem(page, { name: 'आइटम', mrp: 500 });
  const noBal = await page.evaluate(() => buildBillText());
  ok('no old-balance line for a walk-in', !noBal.includes('पिछला बकाया'), noBal.slice(0, 200));

  await addCustomer(page, { acc: '9', name: 'बकाया पार्टी', phone: '9000000009', openingBal: 700 });
  await selectCustomer(page, '[खाता: 9] बकाया पार्टी - 9000000009');
  const withBal = await page.evaluate(() => buildBillText());
  ok('old balance shown for a party that owes', withBal.includes('पिछला बकाया'), withBal.slice(0, 400));
  ok('and a combined total is given', withBal.includes('1200') || withBal.includes('1,200'),
     withBal.slice(0, 400));

  group('WhatsApp share');
  const share = await page.evaluate(() => {
    let opened = null;
    window.open = u => { opened = u; return null; };
    document.getElementById('custInfo').value = 'ग्राहक - 9876543210';
    shareOnWhatsApp();
    return opened;
  });
  ok('opens api.whatsapp.com', (share || '').includes('api.whatsapp.com'), String(share).slice(0, 60));
  ok('addresses the number with the 91 country code', (share || '').includes('phone=919876543210'),
     String(share).slice(0, 80));
  ok('the bill text is URL-encoded into the message', (share || '').includes('text='),
     String(share).slice(0, 80));

  const shareNoPhone = await page.evaluate(() => {
    let opened = null;
    window.open = u => { opened = u; return null; };
    document.getElementById('custInfo').value = 'बिना नंबर';
    shareOnWhatsApp();
    return opened;
  });
  ok('without a number it still opens a shareable message',
     (shareNoPhone || '').includes('whatsapp') && !(shareNoPhone || '').includes('phone='),
     String(shareNoPhone).slice(0, 60));

  group('thermal slip');
  const slip = await page.evaluate(() => {
    let printed = false;
    window.print = () => { printed = true; };
    printThermalSlip();
    return { printed, html: document.getElementById('printableSlip').innerHTML };
  });
  ok('calls print', slip.printed, String(slip.printed));
  ok('the slip carries the shop name and the item', slip.html.includes('अर्पित') && slip.html.includes('आइटम'),
     slip.html.slice(0, 120));

  group('clipboard');
  const copied = await page.evaluate(async () => {
    let written = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: t => { written = t; return Promise.resolve(); } }
    });
    copyBillText();
    await new Promise(r => setTimeout(r, 50));
    return written;
  });
  ok('copies the bill text to the clipboard', (copied || '').includes('अर्पित'),
     String(copied).slice(0, 60));

  group('UPI QR');
  await reset(page);
  const noItems = await page.evaluate(() => {
    let alerted = null;
    window.alert = m => { alerted = m; };
    openUPIQRModal();
    return alerted;
  });
  ok('refuses to build a QR for an empty bill', !!noItems, String(noItems));

  await addItem(page, { name: 'क्यूआर आइटम', mrp: 750 });
  const qr = await page.evaluate(() => {
    renderQRCodeImage(750);
    const img = document.querySelector('#qrCodeContainer img');
    return img ? decodeURIComponent(decodeURIComponent(img.getAttribute('src'))) : null;
  });
  ok('the QR encodes a upi:// payment intent', (qr || '').includes('upi://pay'), String(qr).slice(0, 120));
  ok('with the shop UPI id', (qr || '').includes('7011013472@paytm'), String(qr).slice(0, 140));
  ok('and the bill amount', (qr || '').includes('am=750'), String(qr).slice(0, 160));
  // Worth knowing: the image is fetched from a third party, so the amount and
  // UPI id leave the device and the QR will not render offline.
  ok('NOTE: the QR image comes from an external service',
     (qr || '').includes('api.qrserver.com'), String(qr).slice(0, 60));

  group('OCR receipt parsing');
  await reset(page);
  const ocr = await page.evaluate(() => {
    parseOCRTextToItems('कुकर 5L 1850\nकढ़ाई 850\nसस्ता सामान 5\n\nकुल 2700');
    return items.map(i => ({ name: i.name.trim(), mrp: i.mrp }));
  });
  ok('parses a priced line into an item', ocr.some(i => i.mrp === 1850), JSON.stringify(ocr));
  ok('parses a second line', ocr.some(i => i.mrp === 850), JSON.stringify(ocr));
  ok('KNOWN LIMIT: lines under ₹10 are silently dropped',
     !ocr.some(i => i.mrp === 5), JSON.stringify(ocr));
  ok('digits are stripped out of the item name',
     ocr.every(i => !/\d/.test(i.name)), JSON.stringify(ocr));

  const ocrPersisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('asc_current_items') || '[]').length);
  ok('scanned items are persisted, not just held in memory', ocrPersisted > 0, String(ocrPersisted));

  group('voice entry');
  await reset(page);
  const voice = await page.evaluate(() => {
    let started = false;
    class FakeRecognition {
      start() { started = true; setTimeout(() => this.onresult({ results: [[{ transcript: '450' }]] }), 0); }
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    startVoiceEntry();
    return new Promise(r => setTimeout(() => r({
      started, mrp: document.getElementById('itemMRP').value, count: items.length
    }), 50));
  });
  ok('a single spoken number fills the MRP and adds the item', voice.count === 1, JSON.stringify(voice));

  const voiceTwo = await page.evaluate(() => {
    class FakeRecognition {
      start() { setTimeout(() => this.onresult({ results: [[{ transcript: '900 15' }]] }), 0); }
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    startVoiceEntry();
    return new Promise(r => setTimeout(() => r({
      last: items[items.length - 1], count: items.length
    }), 50));
  });
  ok('two spoken numbers set price and discount',
     voiceTwo.last && voiceTwo.last.mrp === 900 && voiceTwo.last.disc === 15,
     JSON.stringify(voiceTwo.last));

  const voiceWords = await page.evaluate(() => {
    class FakeRecognition {
      start() { setTimeout(() => this.onresult({ results: [[{ transcript: 'स्टील कढ़ाई' }]] }), 0); }
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    const before = items.length;
    startVoiceEntry();
    return new Promise(r => setTimeout(() => r({
      name: document.getElementById('itemName').value, added: items.length - before
    }), 50));
  });
  ok('speech with no number fills the name instead',
     voiceWords.name === 'स्टील कढ़ाई' && voiceWords.added === 0, JSON.stringify(voiceWords));

  const noApi = await page.evaluate(() => {
    delete window.webkitSpeechRecognition;
    delete window.SpeechRecognition;
    let alerted = null;
    window.alert = m => { alerted = m; };
    startVoiceEntry();
    return alerted;
  });
  ok('an unsupported browser gets a clear message', !!noApi, String(noApi));

  group('calculator');
  const calc = await page.evaluate(() => {
    calcClear();
    '12+3*4'.split('').forEach(c => calcInput(c));
    calcEval();
    const result = document.getElementById('calcDisplay').value;
    calcClear();
    calcInput('9'); calcInput('/'); calcInput('0'); calcEval();
    const divZero = document.getElementById('calcDisplay').value;
    calcClear();
    calcInput('+'); calcInput('+'); calcEval();
    const broken = document.getElementById('calcDisplay').value;
    return { result, divZero, broken };
  });
  ok('evaluates with correct precedence (12+3*4 = 24)', calc.result === '24', calc.result);
  ok('division by zero does not crash', calc.divZero.length > 0, calc.divZero);
  ok('a malformed expression shows Error rather than throwing', calc.broken === 'Error', calc.broken);

  // calcInput is only reachable from digit and operator buttons, which is what
  // keeps eval() safe here.
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('[onclick^="calcInput"]')]
      .map(b => b.getAttribute('onclick').match(/calcInput\('(.+?)'\)/)?.[1]));
  ok('every calculator button feeds eval a digit or an arithmetic operator',
     buttons.every(c => /^[0-9+\-*/.]$/.test(c)), JSON.stringify(buttons));

  assertNoPageErrors(errors);
} catch (err) {
  fatal(err);
} finally {
  server.stop();
  await finish();
}
