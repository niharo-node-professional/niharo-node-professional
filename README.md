# Niharo Node Professional v13

Changes in v13:

- Salesman Product Stock screen simplified.
- Now stock list shows only Product Name and Bookable quantity.
- Category, Warehouse, Pending and Cart details are hidden from salesman stock view to avoid confusion.
- Existing v11 changes continue: searchable Party input, warehouse target set tab, salesman target view-only, category-based products, MIS export, import formats.

Update steps:

1. Stop old server with Ctrl + C.
2. Extract this folder.
3. Copy your old data/store.json into this folder's data/store.json.
4. Run start-windows.bat.
5. Press Ctrl + F5 on dashboard.
6. On mobile open /salesman?v=12 or clear Chrome cache/PWA if old screen appears.

Salesman Product Stock screen:

- Search product name.
- Card will show Product Name on left.
- Right side will show Bookable stock only.
- Category/Warehouse/Pending details are not shown in this screen.


## v13 update
- Target save hone ke baad category/product select aur qty fields auto-reset ho jayenge.
- Salesman filter selected rahega taki saved target turant list mein dikhe.


## v15 changes
- Target form me Incentive Rs. aur Target Time fields add kiye gaye.
- Dashboard Targets panel aur Salesman Target panel dono par incentive/time-left show hota hai.
- Countdown live update hota rahega; time over hone par warning badge dikh jayega.


## v15 changes
- Targets screen layout simplified: separate Category target and Product target cards.
- Target incentive/time fields reset correctly after save.
- Cache bumped to v15.


## v16 changes
- Same salesman/category/product target dobara save karne par ab purana target edit nahi hota; naya separate target row banega.
- Har target row ke saamne admin Remove button rahega, jisse exact target delete hoga.
- Naye targets ka completed/remaining calculation target banne ke baad delivered orders se count hoga.
- Delivered orders me deliveredAt timestamp add kiya gaya hai, future target tracking zyada accurate rahegi.
- Cache bumped to v16.
