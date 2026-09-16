# Arpit Steel Centre — billing app

Single-file billing and khata app for a steel/kitchenware shop in Kota.
Hindi UI, phone-first, built to keep working when the shop's internet doesn't.

## How it's put together

`index.html` is the whole app — markup, styles and logic in one file. That is
deliberate: it can be opened from a file, a phone, or any static host with no
build step.

Data is **local-first**. `localStorage` is what the UI reads and writes, so
billing never waits on the network; a customer at the counter shouldn't have to.
Changes are marked dirty and flushed to Supabase in the background, retrying
when connectivity returns. The sync chip in the header shows the current state
and how many records are still queued.

## Supabase

Project `arpit-steel-centre`, region ap-south-1 (Mumbai).
Schema is documented in [`supabase/schema.sql`](supabase/schema.sql).

Two constraints matter more than the rest:

* `unique (store_id, doc_type, doc_no)` on `documents` — makes it impossible for
  two devices to mint the same bill number. The local-only version reused
  numbers and silently overwrote earlier sales.
* a partial unique index on `ledger_entries(document_id)` for `BILL` rows — a
  repeated sync cannot double-post a credit sale.

Party balances come from the `party_balances` view, derived from ledger
entries. They are never a stored, hand-edited number; that is exactly what the
old `oldBal` field got wrong.

Row level security is on for every table, keyed on store membership via
`private.is_store_member()`, which lives outside the API-exposed schema.

## Still to do

* **GST.** The shop is registered but bills carry no GSTIN, HSN codes or
  CGST/SGST split, while printing as "पक्का बिल". Columns are in place
  (`products.gst_rate`, `products.hsn_code`, tax columns on `documents` and
  `document_items`); they need rates per item from the shop's accountant, then
  the bill format updated. Note prices are MRP-inclusive, so taxable value has
  to be backed out rather than added on.
* **Stock.** `products.stock_qty`, `products.track_stock` and `stock_movements`
  exist and are unused. Enabling it needs an opening count per item.
* **Pull-down sync.** Push works; the client does not yet pull server changes
  back. Fine for one device, needed before a second one.
* **Deletes.** Deleting a party or catalog item locally does not remove it on
  the server. Rows go stale rather than wrong, but it should be handled.

## Tests

See [`tests/README.md`](tests/README.md).
