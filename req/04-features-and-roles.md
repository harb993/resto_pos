# 04 — Features & Roles

## Permission matrix

| Feature / Action | Cashier | Owner |
|---|---|---|
| Log in (PIN or password) | ✅ own account | ✅ own account |
| Create & submit orders | ✅ | ✅ |
| Print receipts | ✅ | ✅ |
| View own shift's order history | ✅ | — |
| View **all** order history, all cashiers | ❌ | ✅ |
| Apply a discount | ✅ up to an owner-set limit | ✅ unlimited |
| Void a completed order | ⚠️ owner PIN required | ✅ |
| Add / edit / delete menu items | ❌ | ✅ |
| View stock levels | ✅ read-only (in-stock / out) | ✅ full detail |
| Restock / adjust inventory | ❌ | ✅ |
| View analytics dashboard | ❌ | ✅ |
| View cost price / profit margin | ❌ | ✅ |
| Create/deactivate user accounts | ❌ | ✅ |
| Change settings (tax rate, receipt header) | ❌ | ✅ |
| Export reports | ❌ | ✅ |

**Why voids are PIN-gated for cashiers, not just hidden:** a completed sale that any cashier can silently delete or void is a straightforward way to skim cash — ring up a sale, take the cash, void the order, the books never show it happened. Requiring the owner's PIN for a void (and logging who requested it and why, per the `orders.voided_by` / `void_reason` columns in the schema) doesn't stop every possible dishonesty, but it closes the easiest version of it, and it's close to free to build. This is standard practice in real POS systems for exactly this reason.

## Cashier — screens and flow

**Login screen.** Large PIN pad, 4–6 digits. Fast is the whole point — a full username/password field on a touchscreen at the counter is friction the cashier will resent by hour two.

**POS / Order screen** (the one screen a cashier lives in):
- Category tabs across the top (Buckets, Sandwiches, Sides, Drinks...), large touch-friendly item buttons below
- Tap an item → adds to the cart on the side; tap again or use +/− to adjust quantity
- Cart shows running subtotal, tax, and total live as items are added
- Optional per-item notes (e.g., "no spice") if you want that from day one — otherwise defer it
- Checkout button → payment method (cash/card) → confirm → receipt prints, cart clears, ready for the next order
- If an item's stock hits zero mid-shift, it should visibly grey out / show "sold out" on this screen automatically — the cashier shouldn't be the one who discovers this by trying to ring it up

**Order history (own shift only).** A simple list of the current shift's orders, mostly useful for "did that last order actually go through" reassurance and for finding an order to void (which still requires the owner PIN to complete).

## Owner — screens and flow

**Dashboard (landing screen after login).** The summary cards and trend chart from `05-analytics-dashboard.md` — this is what the owner should see within one second of logging in, not something they have to navigate to find.

**Menu management.** List of items grouped by category, add/edit modal (name, price, cost price, category, description, photo, active toggle), and a one-tap "86 this item" for when something runs out mid-service without deleting it outright.

**Inventory.** Stock list with a clear visual flag on anything at or below its reorder level, a restock action (add quantity + a reason, logged to `stock_transactions`), and a manual adjustment action for waste/spoilage/counting corrections — also logged, also with a reason, because "the numbers don't match what's on the shelf" is a when, not an if, and you want a trail when it happens.

**Analytics.** Covered in full in `05-analytics-dashboard.md`.

**Users.** Create/deactivate cashier accounts, reset a forgotten PIN. Deactivate, don't delete — a departed cashier's historical orders should stay attributed to them.

**Settings.** Tax rate, receipt header/footer text (business name, address, phone — whatever prints on the receipt), default printer, currency symbol, discount limit for cashiers, backup folder location.
