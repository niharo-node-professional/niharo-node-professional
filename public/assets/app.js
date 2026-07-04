'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let state = { products: {}, parties: [], orders: [], salesmen: [], meta: {} };
let adminToken = localStorage.getItem('niharo_admin_token') || '';
let cart = [];
let editingOrderId = "";
let parsedOrder = null;
let expandedOrders = new Set();

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function money(value) { return '₹' + Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function qty(value) { return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function isAdmin() { return Boolean(adminToken); }
function isPending(order) { return String(order.status || '').toLowerCase().includes('pending'); }
function isDelivered(order) { return String(order.status || '').toLowerCase().includes('delivered'); }
function orderTotal(order) { return (order.items || []).reduce((s, i) => s + Number(i.qty || 0) * Number(i.rate || 0), 0); }
function findOrder(orderId) { return (state.orders || []).find(o => String(o.id) === String(orderId)); }
function productKeys() { return Object.keys(state.products || {}).sort((a,b)=>a.localeCompare(b)); }
function filteredText(...parts) { return parts.join(' ').toLowerCase().includes(($('globalSearch').value || '').trim().toLowerCase()); }
function toast(message, type = '') { const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = message; $('toastStack').appendChild(el); setTimeout(() => el.remove(), 3600); }

function normalizeState(raw) {
  raw = raw || {};
  const salesmenRaw = raw.salesmenList || raw.salesmen || {};
  const salesmen = Array.isArray(salesmenRaw) ? salesmenRaw : Object.keys(salesmenRaw).sort().map(username => ({ username }));
  return {
    products: raw.warehouseStock || raw.products || {},
    parties: raw.listedParties || raw.parties || [],
    orders: raw.partyOrders || raw.orders || [],
    salesmen,
    meta: raw.meta || {}
  };
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (adminToken) headers.Authorization = 'Bearer ' + adminToken;
  const res = await fetch(path, { ...options, headers, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'Request failed');
  return data;
}
async function loadState() { const data = await api('/api/state'); state = normalizeState(data.data || data.state); setLive(true); renderAll(); }
function startPolling() { loadState().catch(() => setLive(false)); setInterval(() => loadState().catch(() => setLive(false)), 6000); }
function setLive(ok) { const pill = $('liveStatus'); pill.classList.toggle('offline', !ok); pill.innerHTML = `<span class="status-dot"></span>${ok ? 'Node backend connected' : 'Backend offline'}`; }
function updateAuthUi() { $('adminLoginBtn').style.display = isAdmin() ? 'none' : ''; $('adminLogoutBtn').style.display = isAdmin() ? '' : 'none'; }
function requireAdmin() { if (!isAdmin()) { showLogin(); toast('Pehle admin login karein', 'error'); return false; } return true; }

function renderAll() {
  updateAuthUi(); renderDropdowns(); renderKpis(); renderCart(); renderRecentOrders(); renderInventory(); renderOrders(); renderMasters(); renderTargets(); renderReports();
  $('salesmanUrlFull').textContent = location.origin + '/salesman'; $('salesmanLinkText').textContent = location.origin + '/salesman';
}
function productDemand(productName) { return (state.orders || []).filter(isPending).reduce((sum, order) => sum + (order.items || []).reduce((s, item) => s + (item.product === productName ? Number(item.qty || 0) : 0), 0), 0); }
function productShortage(productName) { return Math.max(0, productDemand(productName) - Number(state.products?.[productName]?.available || 0)); }
function productCategory(productName) { return String(state.products?.[productName]?.location || 'UNCATEGORIZED').trim().toUpperCase() || 'UNCATEGORIZED'; }
function productUnit(productName) { return String(state.products?.[productName]?.unit || 'PCS').trim().toUpperCase() || 'PCS'; }
const PRODUCT_UNITS = ['PCS','KG','BOX','BAG','LITER','CARTON'];
function unitOptions(selected) { const sel = String(selected || 'PCS').toUpperCase(); return PRODUCT_UNITS.map(u => `<option value="${u}" ${u===sel?'selected':''}>${u}</option>`).join(''); }
function targetQty(v) { return v && typeof v === 'object' ? Number(v.qty || v.target || 0) : Number(v || 0); }
function targetIncentive(v) { return v && typeof v === 'object' ? Number(v.incentive || 0) : 0; }
function targetDeadline(v) { return v && typeof v === 'object' ? String(v.deadline || '') : ''; }
function targetCreatedAt(v) { return v && typeof v === 'object' ? String(v.createdAt || '') : ''; }
function targetDisplayKey(storageKey, v) { return productNameForTarget(v && typeof v === 'object' && v.key ? v.key : String(storageKey || '').split('||')[0]); }
function productNameForTarget(value) { return String(value || '').trim().toUpperCase().replace(/\s+/g, ' '); }
function timeLeftLabel(deadline) { if (!deadline) return 'No time set'; const end = new Date(deadline); if (isNaN(end.getTime())) return 'Invalid time'; const diff = end.getTime() - Date.now(); if (diff <= 0) return 'Time over'; const m = Math.floor(diff / 60000); const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mins = m % 60; if (d > 0) return `${d}d ${h}h left`; if (h > 0) return `${h}h ${mins}m left`; return `${mins}m left`; }
function targetTimeClass(deadline) { if (!deadline) return 'badge-user'; const diff = new Date(deadline).getTime() - Date.now(); if (isNaN(diff)) return 'badge-user'; if (diff <= 0) return 'badge-danger'; if (diff < 86400000) return 'badge-pending'; return 'badge-success'; }
function categories() { return Array.from(new Set(productKeys().map(productCategory))).sort((a,b)=>a.localeCompare(b)); }
function salesmanTargetData(username) { const row = (state.salesmen || []).find(s => String(s.username) === String(username)); return row?.targets || { categoryTargets: {}, productTargets: {} }; }
function completedQtyForSalesman(username, opts = {}) {
  const after = opts.after ? new Date(opts.after).getTime() : 0;
  return (state.orders || []).filter(isDelivered).filter(o => String(o.salesman||'').toLowerCase() === String(username||'').toLowerCase()).filter(o => {
    if (!after) return true;
    const stamp = o.deliveredAt || (o.deliveredDate ? o.deliveredDate + 'T23:59:59' : '');
    const t = stamp ? new Date(stamp).getTime() : 0;
    return !t || t >= after;
  }).reduce((sum, order) => sum + (order.items || []).reduce((acc, item) => { const prod = item.product; if (opts.category && productCategory(prod) !== opts.category) return acc; if (opts.product && prod !== opts.product) return acc; return acc + Number(item.qty || 0); }, 0), 0);
}
function targetRows() {
  const rows = [];
  (state.salesmen || []).forEach(sm => {
    const targets = sm.targets || {};
    Object.entries(targets.categoryTargets || {}).forEach(([storageKey, meta]) => {
      const key = targetDisplayKey(storageKey, meta);
      const target = targetQty(meta);
      const createdAt = targetCreatedAt(meta);
      if (target > 0) rows.push({ salesman: sm.username, type: 'Category', storageKey, key, target, incentive: targetIncentive(meta), deadline: targetDeadline(meta), createdAt, completed: completedQtyForSalesman(sm.username, { category: key, after: createdAt }) });
    });
    Object.entries(targets.productTargets || {}).forEach(([storageKey, meta]) => {
      const key = targetDisplayKey(storageKey, meta);
      const target = targetQty(meta);
      const createdAt = targetCreatedAt(meta);
      if (target > 0) rows.push({ salesman: sm.username, type: 'Product', storageKey, key, target, incentive: targetIncentive(meta), deadline: targetDeadline(meta), createdAt, completed: completedQtyForSalesman(sm.username, { product: key, after: createdAt }) });
    });
  });
  return rows;
}
function preserveSelect(select, html) { const value = select.value; select.innerHTML = html; if ([...select.options].some(o => o.value === value)) select.value = value; }
function renderDropdowns() {
  const partyOptions = ['<option value="">Select party</option>', ...state.parties.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)].join('');
  const productOptions = ['<option value="">Select product</option>', ...productKeys().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)].join('');
  if ($('productSuggestions')) $('productSuggestions').innerHTML = productKeys().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(productCategory(p))} | ${escapeHtml(productUnit(p))} | Stock ${Number(state.products[p]?.available || 0)}</option>`).join('');
  const salesmanNames = [...new Set([...(state.salesmen || []).map(s => s.username), ...(state.orders || []).map(o => o.salesman).filter(Boolean)])].sort();
  const salesmanOptions = ['<option value="ALL">All salesmen</option>', ...salesmanNames.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(String(s).toUpperCase())}</option>`)].join('');
  preserveSelect($('orderParty'), partyOptions); preserveSelect($('orderProduct'), productOptions); preserveSelect($('filterSalesman'), salesmanOptions); preserveSelect($('reportSalesman'), salesmanOptions);
  preserveSelect($('reportParty'), ['<option value="ALL">All parties</option>', ...state.parties.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)].join(''));
  preserveSelect($('reportProduct'), ['<option value="ALL">All products</option>', ...productKeys().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)].join(''));
  if ($('targetSalesmanFilter')) preserveSelect($('targetSalesmanFilter'), ['<option value="ALL">All salesmen</option>', ...salesmanNames.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(String(s).toUpperCase())}</option>`)].join(''));
  if ($('targetSetSalesman')) preserveSelect($('targetSetSalesman'), ['<option value="">Select salesman</option>', ...salesmanNames.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(String(s).toUpperCase())}</option>`)].join(''));
  if ($('inventoryCategoryFilter')) preserveSelect($('inventoryCategoryFilter'), ['<option value="ALL">All categories</option>', ...categories().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)].join(''));
  if ($('targetCategoryFilter')) preserveSelect($('targetCategoryFilter'), ['<option value="ALL">All categories</option>', ...categories().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)].join(''));
  if ($('targetProductFilter')) preserveSelect($('targetProductFilter'), ['<option value="ALL">All products</option>', ...productKeys().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)].join(''));
  if ($('targetCategorySelect')) preserveSelect($('targetCategorySelect'), ['<option value="">Select category</option>', ...categories().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)].join(''));
  if ($('targetProductSelect')) preserveSelect($('targetProductSelect'), ['<option value="">Select product</option>', ...productKeys().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)} (${escapeHtml(productCategory(p))})</option>`)].join(''));
  if ($('targetSetCategorySelect')) preserveSelect($('targetSetCategorySelect'), ['<option value="">Select category</option>', ...categories().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)].join(''));
  if ($('targetSetProductSelect')) preserveSelect($('targetSetProductSelect'), ['<option value="">Select product</option>', ...productKeys().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)} (${escapeHtml(productCategory(p))})</option>`)].join(''));
}
function renderKpis() { const orders = state.orders || []; const pending = orders.filter(isPending); $('kpiProducts').textContent = productKeys().length; $('kpiPending').textContent = pending.length; $('kpiShortage').textContent = productKeys().filter(p => productShortage(p) > 0).length; $('kpiRevenue').textContent = money(orders.reduce((s, o) => s + orderTotal(o), 0)); }
function renderCart() {
  const box = $('cartPreview');
  const submitBtn = $('submitOfficeOrderBtn');
  if (submitBtn) submitBtn.textContent = editingOrderId ? 'Update pending order' : 'Submit order';
  const editNote = editingOrderId ? `<div class="cart-item" style="border-color:#f59e0b;background:#fffbeb"><div><b>Pending order edit mode</b><div style="color:var(--muted);font-size:13px">Changes save karne ke liye Update pending order dabayein.</div></div><button class="btn btn-soft btn-sm" onclick="cancelOfficeOrderEdit()">Cancel edit</button></div>` : '';
  if (!cart.length) { box.innerHTML = editNote + '<div class="empty-state" style="padding:16px">Cart empty hai. Item add karein.</div>'; return; }
  box.innerHTML = editNote + cart.map((item, idx) => `<div class="cart-item"><div><b>${escapeHtml(item.product)}</b><div style="color:var(--muted);font-size:13px">${item.qty} ${escapeHtml(productUnit(item.product))} × ${money(item.rate)}</div></div><div style="text-align:right"><b>${money(item.qty * item.rate)}</b><br><button class="btn btn-danger btn-sm" onclick="removeCartItem(${idx})">Remove</button></div></div>`).join('') + `<div style="text-align:right;margin-top:10px;font-weight:900">Total: ${money(cart.reduce((s,i)=>s+i.qty*i.rate,0))}</div>`;
}
window.removeCartItem = (idx) => { cart.splice(idx, 1); renderCart(); };

window.cancelOfficeOrderEdit = () => {
  editingOrderId = '';
  cart = [];
  if ($('orderParty')) $('orderParty').value = '';
  renderCart();
  toast('Edit cancelled');
};
window.startOrderEdit = (orderId) => {
  if (!requireAdmin()) return;
  const order = findOrder(orderId);
  if (!order) return toast('Order not found', 'error');
  if (!isPending(order)) return toast('Delivered order edit nahi ho sakta', 'error');
  editingOrderId = String(order.id);
  cart = (order.items || []).map(i => ({ product: i.product, qty: Number(i.qty || 0), rate: Number(i.rate || 0) }));
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  const dashBtn = document.querySelector('.nav-btn[data-screen="dashboard"]');
  if (dashBtn) dashBtn.classList.add('active');
  $$('.screen').forEach(sec => sec.classList.remove('active'));
  if ($('screen-dashboard')) $('screen-dashboard').classList.add('active');
  if ($('pageTitle')) $('pageTitle').textContent = 'Warehouse dashboard';
  if ($('pageSubtitle')) $('pageSubtitle').textContent = 'Inventory, pending orders, dispatch aur MIS ek jagah.';
  if ($('orderParty')) $('orderParty').value = order.party || '';
  renderCart();
  setTimeout(() => $('orderParty')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  toast('Pending order edit mode open ho gaya', 'success');
};
function orderItemsHtml(order, includeStock = false) { return (order.items || []).map(i => { const unit = productUnit(i.product); const avail = Number(state.products?.[i.product]?.available || 0); const shortage = Math.max(0, Number(i.qty || 0) - avail); const status = includeStock ? (shortage ? ` <span class="badge badge-danger">Short ${qty(shortage)} ${escapeHtml(unit)}</span>` : ` <span class="badge badge-success">Avail ${qty(avail)} ${escapeHtml(unit)}</span>`) : ''; return `<div class="item-line">• <b>${escapeHtml(i.product)}</b> — ${qty(i.qty)} ${escapeHtml(unit)} @ ${money(i.rate)}${status}</div>`; }).join(''); }
function renderRecentOrders() {
  const rows = (state.orders || []).filter(isPending).slice(0, 8).map(o => {
    const expanded = expandedOrders.has(String(o.id));
    const itemsCell = `<div class="compact-order-cell" onclick="toggleOrderExpand('${o.id}')">${orderCompactHtml(o)}<button class="btn btn-soft btn-sm" type="button">${expanded ? 'Hide items' : 'View items'}</button></div>${expanded ? `<div class="order-expanded">${orderItemsHtml(o, true)}</div>` : ''}`;
    return `<tr><td><b>${escapeHtml(o.party)}</b><br><span style="color:var(--muted);font-size:12px">${escapeHtml(o.date)} ${escapeHtml(o.time || '')}</span></td><td><span class="badge badge-user">${escapeHtml(String(o.salesman || '').toUpperCase())}</span></td><td>${itemsCell}</td><td><b>${money(orderTotal(o))}</b></td><td><span class="badge badge-pending">Pending</span></td><td><button class="btn btn-warning btn-sm" onclick="startOrderEdit('${o.id}')">Edit</button></td></tr>`;
  }).join('');
  $('recentPendingBody').innerHTML = rows || '<tr><td colspan="7" class="empty-state">No pending orders</td></tr>';
}
function renderInventory() {
  const catFilter = $('inventoryCategoryFilter') ? $('inventoryCategoryFilter').value || 'ALL' : 'ALL';
  const stockFilter = $('inventoryStockFilter') ? $('inventoryStockFilter').value || 'ALL' : 'ALL';
  const sortFilter = $('inventorySortFilter') ? $('inventorySortFilter').value || 'NAME_ASC' : 'NAME_ASC';
  let items = productKeys().filter(p => {
    const prod = state.products[p] || {};
    const available = Number(prod.available || 0);
    const demand = productDemand(p);
    const short = productShortage(p);
    if (!filteredText(p, prod.location)) return false;
    if (catFilter !== 'ALL' && productCategory(p) !== catFilter) return false;
    if (stockFilter === 'POSITIVE' && available <= 0) return false;
    if (stockFilter === 'ZERO' && available !== 0) return false;
    if (stockFilter === 'NEGATIVE' && available >= 0) return false;
    if (stockFilter === 'SHORT' && short <= 0) return false;
    return true;
  });
  const metrics = p => ({ prod: state.products[p] || {}, available: Number(state.products[p]?.available || 0), demand: productDemand(p), short: productShortage(p) });
  items.sort((a, b) => {
    const ma = metrics(a), mb = metrics(b);
    if (sortFilter === 'STOCK_DESC') return mb.available - ma.available || a.localeCompare(b);
    if (sortFilter === 'STOCK_ASC') return ma.available - mb.available || a.localeCompare(b);
    if (sortFilter === 'DEMAND_DESC') return mb.demand - ma.demand || a.localeCompare(b);
    if (sortFilter === 'SHORTAGE_DESC') return mb.short - ma.short || a.localeCompare(b);
    return a.localeCompare(b);
  });
  if ($('inventorySummary')) $('inventorySummary').textContent = `${items.length} of ${productKeys().length} products`;
  const rows = items.map(p => {
    const prod = state.products[p] || {};
    const demand = productDemand(p);
    const short = productShortage(p);
    const available = Number(prod.available || 0);
    const stockColor = available < 0 ? '#b42318' : 'var(--brand)';
    const unit = productUnit(p); return `<tr><td><b>${escapeHtml(p)}</b><br><span style="color:var(--muted);font-size:12px">${escapeHtml(prod.lastStatus || '')}</span></td><td><span class="badge badge-blue">${escapeHtml(productCategory(p))}</span></td><td><select class="unit-mini" onchange="updateProductUnit('${encodeURIComponent(p)}', this.value)">${unitOptions(unit)}</select></td><td><b style="font-size:17px;color:${stockColor}">${qty(available)} ${escapeHtml(unit)}</b></td><td>${qty(demand)} ${escapeHtml(unit)}</td><td>${short ? `<span class="badge badge-danger">${qty(short)} ${escapeHtml(unit)}</span>` : '<span class="badge badge-success">OK</span>'}</td><td><div class="table-actions"><button class="btn btn-soft btn-sm" onclick="editProduct('${encodeURIComponent(p)}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteProduct('${encodeURIComponent(p)}')">Delete</button></div></td></tr>`;
  }).join('');
  $('inventoryBody').innerHTML = rows || '<tr><td colspan="7" class="empty-state">No products found</td></tr>';
}
window.editProduct = async (encoded) => { if (!requireAdmin()) return; const name = decodeURIComponent(encoded); const product = state.products[name]; const location = prompt('Category', product.location || 'MAIN'); if (location === null) return; const available = prompt('Available stock', product.available); if (available === null) return; const unit = prompt('Unit: PCS / KG / BOX / BAG / LITER / CARTON', product.unit || 'PCS'); if (unit === null) return; try { const data = await api('/api/products/' + encodeURIComponent(name), { method: 'PUT', body: { location, available, unit } }); state = normalizeState(data.state || data.data); renderAll(); toast('Product updated', 'success'); } catch (e) { toast(e.message, 'error'); } };
window.updateProductUnit = async (encoded, unit) => { if (!requireAdmin()) return; const name = decodeURIComponent(encoded); const product = state.products[name]; if (!product) return; try { const data = await api('/api/products/' + encodeURIComponent(name), { method: 'PUT', body: { location: product.location || 'MAIN', available: product.available || 0, unit } }); state = normalizeState(data.state || data.data); renderAll(); toast('Unit updated', 'success'); } catch(e) { toast(e.message, 'error'); } };
window.deleteProduct = async (encoded) => { if (!requireAdmin()) return; const name = decodeURIComponent(encoded); if (!confirm(`Delete ${name}?`)) return; try { const data = await api('/api/products/' + encodeURIComponent(name), { method: 'DELETE' }); state = normalizeState(data.state || data.data); renderAll(); toast('Product deleted', 'success'); } catch (e) { toast(e.message, 'error'); } };
function orderCompactHtml(order) {
  const items = order.items || [];
  const shortageItems = items.filter(i => Number(state.products?.[i.product]?.available || 0) < Number(i.qty || 0));
  const totalQty = items.reduce((s, i) => s + Number(i.qty || 0), 0);
  const topNames = items.slice(0, 4).map(i => escapeHtml(i.product)).join(', ');
  const shortText = shortageItems.length ? `<span class="badge badge-danger">${shortageItems.length} short</span>` : '<span class="badge badge-success">Ready</span>';
  return `<div class="order-compact"><b>${items.length} variants</b> ${shortText}<br><span>${topNames}${items.length > 4 ? ' +' + (items.length - 4) + ' more' : ''}</span></div>`;
}
function reportOrderCompactHtml(order) {
  const items = order.items || [];
  const totalQty = items.reduce((s, i) => s + Number(i.qty || 0), 0);
  const topNames = items.slice(0, 4).map(i => escapeHtml(i.product)).join(', ');
  return `<div class="order-compact"><b>${items.length} variants</b> · ${qty(totalQty)} total qty<br><span>${topNames}${items.length > 4 ? ' +' + (items.length - 4) + ' more' : ''}</span></div>`;
}
window.toggleOrderExpand = (orderId) => { const key = String(orderId); if (expandedOrders.has(key)) expandedOrders.delete(key); else expandedOrders.add(key); renderRecentOrders(); renderOrders(); renderReports(); };
function renderOrders() {
  const filterSm = $('filterSalesman').value || 'ALL';
  const filterStatus = $('filterStatus').value || 'Pending';
  const filterShort = $('filterShortage').value || 'ALL';
  const rows = (state.orders || []).filter(o => {
    if (filterSm !== 'ALL' && o.salesman !== filterSm) return false;
    if (filterStatus === 'Pending' && !isPending(o)) return false;
    if (filterStatus === 'Delivered' && !isDelivered(o)) return false;
    const hasShort = (o.items || []).some(i => Number(state.products?.[i.product]?.available || 0) < Number(i.qty || 0));
    if (filterShort === 'SHORT' && !hasShort) return false;
    if (filterShort === 'OK' && hasShort) return false;
    return filteredText(o.party, o.salesman, (o.items || []).map(i => i.product).join(' '));
  }).map(o => {
    const expanded = expandedOrders.has(String(o.id));
    const itemsCell = `<div class="compact-order-cell" onclick="toggleOrderExpand('${o.id}')">${orderCompactHtml(o)}<button class="btn btn-soft btn-sm" type="button">${expanded ? 'Hide items' : 'View items'}</button></div>${expanded ? `<div class="order-expanded">${orderItemsHtml(o, true)}</div>` : ''}`;
    return `<tr><td><b>${escapeHtml(o.party)}</b><br><span style="color:var(--muted);font-size:12px">${escapeHtml(o.date)} ${escapeHtml(o.time || '')}</span></td><td><span class="badge badge-user">${escapeHtml(String(o.salesman || '').toUpperCase())}</span></td><td>${itemsCell}</td><td><b>${money(orderTotal(o))}</b></td><td><div class="table-actions">${isPending(o) ? `<button class="btn btn-warning btn-sm" onclick="startOrderEdit('${o.id}')">Edit</button><button class="btn btn-success btn-sm" onclick="deliverOrder('${o.id}')">Deliver</button><button class="btn btn-blue btn-sm" onclick="downloadPendingOrderJpeg('${o.id}')">JPEG</button>` : '<span class="badge badge-delivered">Delivered</span>'}<button class="btn btn-danger btn-sm" onclick="deleteOrder('${o.id}')">Delete</button></div></td></tr>`;
  }).join('');
  $('ordersBody').innerHTML = rows || '<tr><td colspan="5" class="empty-state">No orders found</td></tr>';
}

function roundedRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); }
function drawTextFit(ctx, text, x, y, maxWidth) { const words = String(text || '').split(' '); let line = ''; const lines = []; for (const word of words) { const test = line ? line + ' ' + word : word; if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else line = test; } if (line) lines.push(line); lines.forEach((l, i) => ctx.fillText(l, x, y + i * 22)); return lines.length * 22; }
window.downloadPendingOrderJpeg = (orderId) => {
  const order = findOrder(orderId);
  if (!order) return toast('Order not found', 'error');
  const items = order.items || [];
  const width = 1240;
  const rowH = 58;
  const rowsH = Math.max(items.length, 1) * rowH;
  const height = 520 + rowsH;
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const pageX = 36;
  const pageY = 30;
  const pageW = width - 72;
  const pageH = height - 60;
  const navy = '#111827';
  const muted = '#64748b';
  const line = '#dbe3ee';
  const soft = '#f8fafc';
  const brand = '#0f6e56';
  const accent = '#d85a30';

  ctx.fillStyle = '#edf2f7';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  roundedRect(ctx, pageX, pageY, pageW, pageH, 22);
  ctx.fill();

  // Top premium invoice header
  ctx.fillStyle = navy;
  roundedRect(ctx, pageX, pageY, pageW, 126, 22);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(pageX + 70, pageY + 62, 35, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = brand;
  ctx.font = '900 26px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('N', pageX + 70, pageY + 72);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 32px Arial';
  ctx.fillText('NIHARO WORLD PVT LTD', pageX + 122, pageY + 55);
  ctx.font = '700 15px Arial';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText('Warehouse Delivery Challan / Invoice Copy', pageX + 124, pageY + 84);
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 28px Arial';
  ctx.textAlign = 'right';
  ctx.fillText('DELIVERY CHALLAN', pageX + pageW - 42, pageY + 55);
  ctx.font = '700 15px Arial';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText('Order ID: ' + String(order.id || '').slice(0, 10).toUpperCase(), pageX + pageW - 42, pageY + 84);
  ctx.textAlign = 'left';

  // Party and order detail cards
  const infoY = pageY + 154;
  const leftW = 670;
  const rightW = pageW - leftW - 28;
  ctx.fillStyle = soft;
  roundedRect(ctx, pageX + 28, infoY, leftW, 126, 16);
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.stroke();
  ctx.fillStyle = soft;
  roundedRect(ctx, pageX + 28 + leftW + 28, infoY, rightW, 126, 16);
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.stroke();

  ctx.fillStyle = muted;
  ctx.font = '800 14px Arial';
  ctx.fillText('BILL TO / PARTY NAME', pageX + 52, infoY + 34);
  ctx.fillStyle = navy;
  ctx.font = '900 28px Arial';
  wrapText(ctx, String(order.party || 'Party'), pageX + 52, infoY + 72, leftW - 48, 31, 2);
  ctx.fillStyle = muted;
  ctx.font = '700 14px Arial';
  ctx.fillText('Generated for pending dispatch approval', pageX + 52, infoY + 112);

  const rx = pageX + 28 + leftW + 54;
  const labelX = rx;
  const valX = rx + 158;
  ctx.fillStyle = muted;
  ctx.font = '800 14px Arial';
  ctx.fillText('DATE', labelX, infoY + 34);
  ctx.fillText('TIME', labelX, infoY + 62);
  ctx.fillText('SALESMAN', labelX, infoY + 90);
  ctx.fillStyle = navy;
  ctx.font = '900 16px Arial';
  ctx.fillText(String(order.date || '-'), valX, infoY + 34);
  ctx.fillText(String(order.time || '-'), valX, infoY + 62);
  ctx.fillText(String(order.salesman || '').toUpperCase(), valX, infoY + 90);

  // Table
  const tableX = pageX + 28;
  const tableY = infoY + 160;
  const tableW = pageW - 56;
  const tableHeadH = 52;
  ctx.fillStyle = '#eef2f7';
  roundedRect(ctx, tableX, tableY, tableW, tableHeadH, 14);
  ctx.fill();
  ctx.fillStyle = '#475569';
  ctx.font = '900 14px Arial';
  ctx.fillText('#', tableX + 22, tableY + 32);
  ctx.fillText('PRODUCT DESCRIPTION', tableX + 82, tableY + 32);
  ctx.textAlign = 'right';
  ctx.fillText('QTY', tableX + 610, tableY + 32);
  ctx.fillText('RATE', tableX + 760, tableY + 32);
  ctx.fillText('AMOUNT', tableX + 930, tableY + 32);
  ctx.fillText('STOCK STATUS', tableX + tableW - 26, tableY + 32);
  ctx.textAlign = 'left';

  let cy = tableY + tableHeadH;
  let total = 0;
  items.forEach((item, idx) => {
    const amount = Number(item.qty || 0) * Number(item.rate || 0);
    total += amount;
    const avail = Number(state.products?.[item.product]?.available || 0);
    const short = Math.max(0, Number(item.qty || 0) - avail);

    ctx.fillStyle = idx % 2 ? '#ffffff' : '#fbfdff';
    ctx.fillRect(tableX, cy, tableW, rowH);
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(tableX, cy + rowH);
    ctx.lineTo(tableX + tableW, cy + rowH);
    ctx.stroke();

    ctx.fillStyle = muted;
    ctx.font = '800 16px Arial';
    ctx.fillText(String(idx + 1), tableX + 24, cy + 36);
    ctx.fillStyle = navy;
    ctx.font = '900 18px Arial';
    ctx.fillText(String(item.product || ''), tableX + 82, cy + 36);
    ctx.textAlign = 'right';
    ctx.font = '800 17px Arial';
    ctx.fillStyle = '#334155';
    ctx.fillText(String(item.qty || 0) + ' ' + productUnit(item.product), tableX + 610, cy + 36);
    ctx.fillText(money(item.rate), tableX + 760, cy + 36);
    ctx.fillStyle = navy;
    ctx.font = '900 18px Arial';
    ctx.fillText(money(amount), tableX + 930, cy + 36);
    ctx.fillStyle = short ? '#991b1b' : '#166534';
    ctx.font = '900 15px Arial';
    ctx.fillText(short ? `SHORT ${short}` : `OK ${avail}`, tableX + tableW - 26, cy + 36);
    ctx.textAlign = 'left';
    cy += rowH;
  });

  // Summary section
  const summaryY = cy + 26;
  ctx.fillStyle = '#ffffff';
  roundedRect(ctx, tableX, summaryY, 610, 118, 16);
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.stroke();
  ctx.fillStyle = muted;
  ctx.font = '800 13px Arial';
  ctx.fillText('TERMS / NOTE', tableX + 24, summaryY + 34);
  ctx.fillStyle = '#334155';
  ctx.font = '700 15px Arial';
  ctx.fillText('1. This is a warehouse generated challan for pending order.', tableX + 24, summaryY + 62);
  ctx.fillText('2. Final stock will be deducted only after delivery/outward.', tableX + 24, summaryY + 88);

  ctx.fillStyle = '#f8fafc';
  roundedRect(ctx, tableX + tableW - 410, summaryY, 410, 118, 16);
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.stroke();
  ctx.fillStyle = muted;
  ctx.font = '800 14px Arial';
  ctx.fillText('GRAND TOTAL', tableX + tableW - 380, summaryY + 38);
  ctx.fillStyle = navy;
  ctx.font = '900 38px Arial';
  ctx.textAlign = 'right';
  ctx.fillText(money(total), tableX + tableW - 28, summaryY + 84);
  ctx.textAlign = 'left';

  // Footer with signature spaces
  const footerY = height - 100;
  ctx.strokeStyle = '#94a3b8';
  ctx.beginPath();
  ctx.moveTo(pageX + 60, footerY);
  ctx.lineTo(pageX + 300, footerY);
  ctx.moveTo(pageX + pageW - 320, footerY);
  ctx.lineTo(pageX + pageW - 60, footerY);
  ctx.stroke();
  ctx.fillStyle = muted;
  ctx.font = '800 13px Arial';
  ctx.fillText('Prepared By', pageX + 132, footerY + 24);
  ctx.fillText('Receiver Signature', pageX + pageW - 258, footerY + 24);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '700 13px Arial';
  ctx.fillText('Generated by Niharo Warehouse Dashboard', pageX + 28, height - 40);

  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/jpeg', 0.95);
  a.download = `invoice-challan-${String(order.party || 'party').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${order.date || ''}.jpg`;
  a.click();
};

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text || '').split(/\s+/);
  let line = '';
  let lines = 0;
  for (let n = 0; n < words.length; n++) {
    const test = line + words[n] + ' ';
    if (ctx.measureText(test).width > maxWidth && n > 0) {
      ctx.fillText(line.trim(), x, y);
      line = words[n] + ' ';
      y += lineHeight;
      lines++;
      if (lines >= maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line.trim(), x, y);
}
window.deliverOrder = async (id) => { if (!requireAdmin()) return; if (!confirm('Dispatch/outward mark karein? Stock auto-deduct hoga.')) return; try { const data = await api('/api/orders/' + encodeURIComponent(id) + '/deliver', { method: 'PATCH' }); state = normalizeState(data.state || data.data); renderAll(); toast('Order delivered', 'success'); } catch (e) { toast(e.message, 'error'); } };
window.deleteOrder = async (id) => { if (!requireAdmin()) return; if (!confirm('Order delete karein?')) return; try { const data = await api('/api/orders/' + encodeURIComponent(id), { method: 'DELETE' }); state = normalizeState(data.state || data.data); renderAll(); toast('Order deleted', 'success'); } catch (e) { toast(e.message, 'error'); } };
function renderMasters() { $('partiesBody').innerHTML = state.parties.filter(p => filteredText(p)).map((p, idx) => `<tr><td><b>${escapeHtml(p)}</b></td><td><div class="table-actions"><button class="btn btn-soft btn-sm" onclick="renameParty(${idx})">Rename</button><button class="btn btn-danger btn-sm" onclick="deleteParty(${idx})">Remove</button></div></td></tr>`).join('') || '<tr><td colspan="2" class="empty-state">No parties</td></tr>'; $('salesmenBody').innerHTML = (state.salesmen || []).filter(s => filteredText(s.username)).map(s => `<tr><td><b>${escapeHtml(String(s.username).toUpperCase())}</b></td><td><span class="badge badge-user">Hidden securely</span></td><td>${targetSummaryForSalesman(s.username)}</td><td><div class="table-actions"><button class="btn btn-warning btn-sm" onclick="openTargetModal('${encodeURIComponent(s.username)}')">Set target</button><button class="btn btn-soft btn-sm" onclick="resetSalesmanPassword('${encodeURIComponent(s.username)}')">Reset password</button><button class="btn btn-danger btn-sm" onclick="deleteSalesman('${encodeURIComponent(s.username)}')">Remove</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">No salesmen</td></tr>'; }
window.renameParty = async (idx) => { if (!requireAdmin()) return; const oldName = state.parties[idx]; const name = prompt('New party name', oldName); if (!name) return; try { const data = await api('/api/parties/' + idx, { method: 'PUT', body: { name } }); state = normalizeState(data.state || data.data); renderAll(); toast('Party renamed', 'success'); } catch(e) { toast(e.message, 'error'); } };
window.deleteParty = async (idx) => { if (!requireAdmin()) return; const oldName = state.parties[idx]; if (!confirm('Party remove karein?')) return; try { const data = await api('/api/parties/' + idx, { method: 'DELETE' }); state = normalizeState(data.state || data.data); renderAll(); toast('Party removed', 'success'); } catch(e) { toast(e.message, 'error'); } };
window.resetSalesmanPassword = async (encoded) => { if (!requireAdmin()) return; const username = decodeURIComponent(encoded); const password = prompt(`New password for ${username}`); if (!password) return; try { const data = await api('/api/salesmen/' + encodeURIComponent(username), { method: 'PUT', body: { password } }); state = normalizeState(data.state || data.data); renderAll(); toast('Password reset done', 'success'); } catch(e) { toast(e.message, 'error'); } };
window.deleteSalesman = async (encoded) => { if (!requireAdmin()) return; const username = decodeURIComponent(encoded); if (!confirm(`Remove salesman ${username}?`)) return; try { const data = await api('/api/salesmen/' + encodeURIComponent(username), { method: 'DELETE' }); state = normalizeState(data.state || data.data); renderAll(); toast('Salesman removed', 'success'); } catch(e) { toast(e.message, 'error'); } };
function getFilteredReportOrders() {
  const from = $('reportFrom').value;
  const to = $('reportTo').value;
  const salesman = $('reportSalesman').value || 'ALL';
  const party = $('reportParty').value || 'ALL';
  const product = $('reportProduct').value || 'ALL';
  return (state.orders || []).filter(o => {
    if (from && o.date < from) return false;
    if (to && o.date > to) return false;
    if (salesman !== 'ALL' && o.salesman !== salesman) return false;
    if (party !== 'ALL' && o.party !== party) return false;
    if (product !== 'ALL' && !(o.items || []).some(i => i.product === product)) return false;
    return filteredText(o.party, o.salesman, (o.items || []).map(i => i.product).join(' '));
  });
}
function reportFilterLabel() {
  const parts = [];
  if ($('reportFrom').value) parts.push('From: ' + $('reportFrom').value);
  if ($('reportTo').value) parts.push('To: ' + $('reportTo').value);
  if (($('reportSalesman').value || 'ALL') !== 'ALL') parts.push('Salesman: ' + $('reportSalesman').value);
  if (($('reportParty').value || 'ALL') !== 'ALL') parts.push('Party: ' + $('reportParty').value);
  if (($('reportProduct').value || 'ALL') !== 'ALL') parts.push('Product: ' + $('reportProduct').value);
  return parts.length ? parts.join(' | ') : 'All records';
}
function reportRowsForExport() {
  const rows = [];
  getFilteredReportOrders().forEach(order => {
    const items = order.items || [];
    if (!items.length) {
      rows.push({ date: order.date || '', time: order.time || '', salesman: order.salesman || '', party: order.party || '', product: '', qty: '', rate: '', amount: '', orderTotal: orderTotal(order), status: isDelivered(order) ? 'Delivered' : 'Pending' });
    } else {
      items.forEach(item => rows.push({ date: order.date || '', time: order.time || '', salesman: order.salesman || '', party: order.party || '', product: item.product || '', qty: Number(item.qty || 0), rate: Number(item.rate || 0), amount: Number(item.qty || 0) * Number(item.rate || 0), orderTotal: orderTotal(order), status: isDelivered(order) ? 'Delivered' : 'Pending' }));
    }
  });
  return rows;
}

let activeTargetSalesman = '';
function renderTargets() {
  const tbody = $('targetsBody');
  if (!tbody) return;
  const smFilter = $('targetSalesmanFilter')?.value || 'ALL';
  const catFilter = $('targetCategoryFilter')?.value || 'ALL';
  const prodFilter = $('targetProductFilter')?.value || 'ALL';
  const rows = targetRows().filter(r => {
    if (smFilter !== 'ALL' && r.salesman !== smFilter) return false;
    if (catFilter !== 'ALL' && !(r.type === 'Category' && r.key === catFilter)) return false;
    if (prodFilter !== 'ALL' && !(r.type === 'Product' && r.key === prodFilter)) return false;
    return filteredText(r.salesman, r.type, r.key);
  });
  tbody.innerHTML = rows.map(r => {
    const remaining = Math.max(0, Number(r.target || 0) - Number(r.completed || 0));
    const pct = r.target > 0 ? Math.min(100, Math.round((r.completed / r.target) * 100)) : 0;
    const t = r.type === 'Category' ? 'category' : 'product';
    return `<tr><td><span class="badge badge-user">${escapeHtml(String(r.salesman).toUpperCase())}</span></td><td>${escapeHtml(r.type)}</td><td><b>${escapeHtml(r.key)}</b><br><span style="color:var(--muted);font-size:12px">Target ${r.target} pcs</span></td><td><b>${r.completed} pcs</b></td><td><b style="color:${remaining ? 'var(--danger)' : 'var(--brand)'}">${remaining} pcs</b></td><td><b>${r.incentive ? money(r.incentive) : '-'}</b></td><td><span class="badge ${targetTimeClass(r.deadline)}">${escapeHtml(timeLeftLabel(r.deadline))}</span></td><td><span class="badge ${remaining ? 'badge-pending' : 'badge-success'}">${remaining ? pct + '% done' : 'Completed'}</span></td><td><button class="btn btn-danger btn-sm" onclick="deleteTarget('${encodeURIComponent(r.salesman)}','${t}','${encodeURIComponent(r.storageKey || r.key)}')">Remove</button></td></tr>`;
  }).join('') || '<tr><td colspan="9" class="empty-state">Abhi target set nahi hai. Upar Set salesman target form se target save karo.</td></tr>';
}
function targetSummaryForSalesman(username) {
  const rows = targetRows().filter(r => String(r.salesman) === String(username));
  if (!rows.length) return '<span class="badge badge-pending">No target</span>';
  const total = rows.reduce((s,r)=>s+Number(r.target||0),0);
  const done = rows.reduce((s,r)=>s+Math.min(Number(r.target||0), Number(r.completed||0)),0);
  const rem = Math.max(0, total - done);
  return `<span class="badge ${rem ? 'badge-pending' : 'badge-success'}">${rem} pcs left</span>`;
}
function renderTargetExistingList(username) {
  const list = $('targetExistingList');
  if (!list) return;
  const targets = salesmanTargetData(username);
  const cats = Object.entries(targets.categoryTargets || {}).filter(([,v])=>targetQty(v)>0).map(([k,v]) => { const dk = targetDisplayKey(k,v); return `<div class="cart-item"><div><b>Category: ${escapeHtml(dk)}</b><div style="color:var(--muted);font-size:12px">Incentive ${targetIncentive(v) ? money(targetIncentive(v)) : '-'} · ${escapeHtml(timeLeftLabel(targetDeadline(v)))}</div></div><div><b>${targetQty(v)} pcs</b> <button class="btn btn-danger btn-sm" onclick="deleteTarget('${encodeURIComponent(username)}','category','${encodeURIComponent(k)}')">Remove</button></div></div>`; });
  const prods = Object.entries(targets.productTargets || {}).filter(([,v])=>targetQty(v)>0).map(([k,v]) => { const dk = targetDisplayKey(k,v); return `<div class="cart-item"><div><b>Product: ${escapeHtml(dk)}</b><div style="color:var(--muted);font-size:12px">${escapeHtml(productCategory(dk))} · Incentive ${targetIncentive(v) ? money(targetIncentive(v)) : '-'} · ${escapeHtml(timeLeftLabel(targetDeadline(v)))}</div></div><div><b>${targetQty(v)} pcs</b> <button class="btn btn-danger btn-sm" onclick="deleteTarget('${encodeURIComponent(username)}','product','${encodeURIComponent(k)}')">Remove</button></div></div>`; });
  list.innerHTML = '<h4 style="margin:10px 0 6px">Current targets</h4>' + (cats.concat(prods).join('') || '<div class="empty-state" style="padding:12px">No target set</div>');
}
window.openTargetModal = (encoded) => {
  if (!requireAdmin()) return;
  activeTargetSalesman = decodeURIComponent(encoded);
  $('targetModalUser').textContent = 'Salesman: ' + activeTargetSalesman.toUpperCase();
  $('targetCategoryQty').value = '';
  if ($('targetCategoryIncentive')) $('targetCategoryIncentive').value = '';
  if ($('targetCategoryDeadline')) $('targetCategoryDeadline').value = '';
  $('targetProductQty').value = '';
  if ($('targetProductIncentive')) $('targetProductIncentive').value = '';
  if ($('targetProductDeadline')) $('targetProductDeadline').value = '';
  renderDropdowns();
  renderTargetExistingList(activeTargetSalesman);
  $('targetModal').classList.add('show');
};
async function saveTarget(type) {
  if (!requireAdmin() || !activeTargetSalesman) return;
  const key = type === 'category' ? $('targetCategorySelect').value : $('targetProductSelect').value;
  const qty = type === 'category' ? $('targetCategoryQty').value : $('targetProductQty').value;
  const incentive = type === 'category' ? ($('targetCategoryIncentive')?.value || 0) : ($('targetProductIncentive')?.value || 0);
  const deadline = type === 'category' ? ($('targetCategoryDeadline')?.value || '') : ($('targetProductDeadline')?.value || '');
  if (!key || Number(qty) < 0) return toast('Target key aur qty required', 'error');
  try {
    const data = await api('/api/salesmen/' + encodeURIComponent(activeTargetSalesman) + '/targets', { method: 'PUT', body: { type, key, qty, incentive, deadline } });
    state = normalizeState(data.state || data.data);
    renderAll();
    if (type === 'category') {
      $('targetCategorySelect').value = '';
      $('targetCategoryQty').value = '';
      if ($('targetCategoryIncentive')) $('targetCategoryIncentive').value = '';
      if ($('targetCategoryDeadline')) $('targetCategoryDeadline').value = '';
    } else {
      $('targetProductSelect').value = '';
      $('targetProductQty').value = '';
      if ($('targetProductIncentive')) $('targetProductIncentive').value = '';
      if ($('targetProductDeadline')) $('targetProductDeadline').value = '';
    }
    renderTargetExistingList(activeTargetSalesman);
    toast('Target saved. Fields reset ho gaye.', 'success');
  } catch(e) { toast(e.message, 'error'); }
}
async function saveTargetFromTargets(type) {
  if (!requireAdmin()) return;
  const username = $('targetSetSalesman')?.value || '';
  const key = type === 'category' ? $('targetSetCategorySelect').value : $('targetSetProductSelect').value;
  const qty = type === 'category' ? $('targetSetCategoryQty').value : $('targetSetProductQty').value;
  const incentive = type === 'category' ? ($('targetSetCategoryIncentive')?.value || 0) : ($('targetSetProductIncentive')?.value || 0);
  const deadline = type === 'category' ? ($('targetSetCategoryDeadline')?.value || '') : ($('targetSetProductDeadline')?.value || '');
  if (!username) return toast('Pehle salesman select karo', 'error');
  if (!key || Number(qty) < 0) return toast('Target aur qty required', 'error');
  try {
    const data = await api('/api/salesmen/' + encodeURIComponent(username) + '/targets', { method: 'PUT', body: { type, key, qty, incentive, deadline } });
    state = normalizeState(data.state || data.data);
    $('targetSalesmanFilter').value = username;
    renderAll();
    if (type === 'category') {
      $('targetSetCategorySelect').value = '';
      $('targetSetCategoryQty').value = '';
      if ($('targetSetCategoryIncentive')) $('targetSetCategoryIncentive').value = '';
      if ($('targetSetCategoryDeadline')) $('targetSetCategoryDeadline').value = '';
    } else {
      $('targetSetProductSelect').value = '';
      $('targetSetProductQty').value = '';
      if ($('targetSetProductIncentive')) $('targetSetProductIncentive').value = '';
      if ($('targetSetProductDeadline')) $('targetSetProductDeadline').value = '';
    }
    toast('Warehouse target saved. Fields reset ho gaye.', 'success');
  } catch(e) { toast(e.message, 'error'); }
}
window.deleteTarget = async (encodedUser, type, encodedKey) => {
  if (!requireAdmin()) return;
  const u = decodeURIComponent(encodedUser), key = decodeURIComponent(encodedKey);
  try {
    const data = await api('/api/salesmen/' + encodeURIComponent(u) + '/targets', { method: 'PUT', body: { type, key, qty: 0 } });
    state = normalizeState(data.state || data.data);
    renderAll();
    renderTargetExistingList(u);
    toast('Target removed', 'success');
  } catch(e) { toast(e.message, 'error'); }
};

function renderReports() {
  const filtered = getFilteredReportOrders();
  $('reportOrderCount').textContent = filtered.length;
  $('reportTotal').textContent = money(filtered.reduce((s,o)=>s+orderTotal(o),0));
  $('reportPending').textContent = filtered.filter(isPending).length;
  $('reportDelivered').textContent = filtered.filter(isDelivered).length;
  $('reportBody').innerHTML = filtered.map(o => {
    const expanded = expandedOrders.has(String(o.id));
    const itemsCell = `<div class="compact-order-cell" onclick="toggleOrderExpand('${o.id}')">${reportOrderCompactHtml(o)}<button class="btn btn-soft btn-sm" type="button">${expanded ? 'Hide items' : 'View items'}</button></div>${expanded ? `<div class="order-expanded">${orderItemsHtml(o, false)}</div>` : ''}`;
    return `<tr><td>${escapeHtml(o.date)} ${escapeHtml(o.time || '')}</td><td><span class="badge badge-user">${escapeHtml(String(o.salesman || '').toUpperCase())}</span></td><td><b>${escapeHtml(o.party)}</b></td><td>${itemsCell}</td><td><b>${money(orderTotal(o))}</b></td><td>${isDelivered(o) ? '<span class="badge badge-delivered">Delivered</span>' : '<span class="badge badge-pending">Pending</span>'}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty-state">No report data</td></tr>';
}
function exportReportXls() {
  if (!requireAdmin()) return;
  const rows = reportRowsForExport();
  if (!rows.length) return toast('Report me data nahi hai', 'error');
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <table border="1">
    <tr><th colspan="10" style="font-size:18px">NIHARO WORLD PVT LTD - MIS REPORT</th></tr>
    <tr><td colspan="10">${escapeHtml(reportFilterLabel())}</td></tr>
    <tr><th>Date</th><th>Time</th><th>Salesman</th><th>Party</th><th>Product</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Order Total</th><th>Status</th></tr>
    ${rows.map(r => `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.time)}</td><td>${escapeHtml(r.salesman)}</td><td>${escapeHtml(r.party)}</td><td>${escapeHtml(r.product)}</td><td>${r.qty}</td><td>${r.rate}</td><td>${r.amount}</td><td>${r.orderTotal}</td><td>${escapeHtml(r.status)}</td></tr>`).join('')}
    <tr><th colspan="7">Grand Total</th><th>${total}</th><th colspan="2"></th></tr>
  </table></body></html>`;
  const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'niharo-mis-report-' + new Date().toISOString().slice(0,10) + '.xls';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('XLS export downloaded', 'success');
}
function exportReportPdf() {
  if (!requireAdmin()) return;
  const rows = reportRowsForExport();
  if (!rows.length) return toast('Report me data nahi hai', 'error');
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const win = window.open('', '_blank');
  if (!win) return toast('Popup blocked hai. Browser me popup allow karein.', 'error');
  win.document.write(`<!doctype html><html><head><title>Niharo MIS Report</title><style>
    body{font-family:Arial,sans-serif;color:#111827;margin:28px} .head{display:flex;justify-content:space-between;border-bottom:3px solid #111827;padding-bottom:14px;margin-bottom:18px} h1{margin:0;font-size:24px}.muted{color:#64748b;font-size:12px} table{width:100%;border-collapse:collapse;margin-top:16px} th{background:#f1f5f9;text-transform:uppercase;font-size:11px;color:#475569} th,td{border:1px solid #dbe3ee;padding:8px;text-align:left;font-size:12px}.right{text-align:right}.total{font-weight:bold;background:#f8fafc}@media print{button{display:none} body{margin:18px}}
  </style></head><body><button onclick="window.print()" style="padding:10px 16px;margin-bottom:14px">Print / Save PDF</button><div class="head"><div><h1>NIHARO WORLD PVT LTD</h1><div class="muted">MIS Report</div></div><div class="muted">Generated: ${new Date().toLocaleString('en-IN')}<br>${escapeHtml(reportFilterLabel())}</div></div><table><thead><tr><th>Date</th><th>Time</th><th>Salesman</th><th>Party</th><th>Product</th><th class="right">Qty</th><th class="right">Rate</th><th class="right">Amount</th><th>Status</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.time)}</td><td>${escapeHtml(r.salesman)}</td><td>${escapeHtml(r.party)}</td><td>${escapeHtml(r.product)}</td><td class="right">${r.qty}</td><td class="right">${money(r.rate)}</td><td class="right">${money(r.amount)}</td><td>${escapeHtml(r.status)}</td></tr>`).join('')}<tr class="total"><td colspan="7" class="right">Grand Total</td><td class="right">${money(total)}</td><td></td></tr></tbody></table><script>setTimeout(()=>window.print(),400)<\/script></body></html>`);
  win.document.close();
}
window.exportReportXls = exportReportXls;
window.exportReportPdf = exportReportPdf;

function downloadTextFile(filename, content, mime = 'application/vnd.ms-excel') {
  const blob = new Blob(['\ufeff' + content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function excelCell(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function htmlExcelTable(title, headers, rows) {
  const head = headers.map(h => `<th style="background:#e2e8f0;border:1px solid #94a3b8;padding:8px;font-weight:bold;">${excelCell(h)}</th>`).join('');
  const body = rows.map(r => `<tr>${r.map(c => `<td style="border:1px solid #cbd5e1;padding:8px;">${excelCell(c)}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><table><tr><th colspan="${headers.length}" style="font-size:16px;text-align:left;padding:10px;background:#0f172a;color:#fff;">${excelCell(title)}</th></tr><tr>${head}</tr>${body}</table></body></html>`;
}
function downloadProductFormat() {
  const rows = productKeys().map(p => [p, state.products[p]?.location || 'MAIN', Number(state.products[p]?.available || 0), state.products[p]?.unit || 'PCS']);
  if (!rows.length) rows.push(['OIL 700','OIL','100','BOX']);
  const html = htmlExcelTable('NIHARO PRODUCT MASTER FORMAT', ['Product Name','Category','Available Stock','Unit'], rows);
  downloadTextFile('niharo-product-master-format.xls', html, 'application/vnd.ms-excel');
  toast('Product Excel format downloaded with Product, Category, Stock, Unit columns', 'success');
}
function downloadPartyFormat() {
  const rows = state.parties.map(p => [p]);
  if (!rows.length) rows.push(['ABC TRADERS']);
  const html = htmlExcelTable('NIHARO PARTY MASTER FORMAT', ['Party Name'], rows);
  downloadTextFile('niharo-party-master-format.xls', html, 'application/vnd.ms-excel');
  toast('Party Excel format downloaded', 'success');
}
function decodeHtmlCell(cell) {
  const div = document.createElement('div');
  div.innerHTML = String(cell || '');
  return (div.textContent || div.innerText || '').trim();
}
function parseDelimitedLine(line) {
  const sep = line.includes('\t') ? '\t' : ',';
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur.trim()); cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.map(cell => cell.replace(/^"|"$/g, '').trim());
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function isExcelWorkbook(file) {
  return /\.xlsx$/i.test(file.name || '') || (/\.xls$/i.test(file.name || '') && !/format/i.test(file.name || ''));
}

function parseSheetText(text) {
  const raw = String(text || '');
  if (/<table[\s\S]*<\/table>/i.test(raw) || /<tr[\s>]/i.test(raw)) {
    const rows = [];
    const trMatches = raw.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    trMatches.forEach(tr => {
      const cells = [];
      const cellMatches = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      cellMatches.forEach(c => {
        const inner = c.replace(/^<t[dh][^>]*>/i, '').replace(/<\/t[dh]>$/i, '');
        cells.push(decodeHtmlCell(inner.replace(/<br\s*\/?/gi, ' ')).trim());
      });
      if (cells.some(Boolean)) rows.push(cells);
    });
    return rows.filter(r => !/^NIHARO .* FORMAT$/i.test(String(r[0] || '')));
  }
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.map(parseDelimitedLine);
}
async function importProductsFromFile(file) {
  if (/\.xlsx$/i.test(file.name || '')) {
    const data = await api('/api/products/import-file', { method: 'POST', body: { filename: file.name, base64: await fileToBase64(file) } });
    state = normalizeState(data.state || data.data);
    renderAll();
    toast((data.imported || 0) + ' products imported/updated', 'success');
    return;
  }
  const rows = parseSheetText(await file.text());
  if (rows.length < 2) throw new Error('File blank hai. Pehle format download karke fill karein.');
  const headerIdx = rows.findIndex(r => String(r.join(' ')).toLowerCase().includes('product'));
  const dataRows = rows.slice(headerIdx >= 0 ? headerIdx + 1 : 1);
  const products = dataRows.map(r => ({ name: r[0], location: r[1] || 'MAIN', available: r[2] || 0, unit: r[3] || 'PCS' })).filter(p => String(p.name || '').trim() && !/^NIHARO/i.test(String(p.name || '')));
  if (!products.length) throw new Error('Product rows nahi mili. Columns: Product Name, Category, Available Stock, Unit');
  const data = await api('/api/products/bulk', { method: 'POST', body: { products } });
  state = normalizeState(data.state || data.data);
  renderAll();
  toast(products.length + ' products imported/updated', 'success');
}
async function importPartiesFromFile(file) {
  if (/\.xlsx$/i.test(file.name || '')) {
    const data = await api('/api/parties/import-file', { method: 'POST', body: { filename: file.name, base64: await fileToBase64(file) } });
    state = normalizeState(data.state || data.data);
    renderAll();
    toast((data.imported || 0) + ' parties imported/updated', 'success');
    return;
  }
  const rows = parseSheetText(await file.text());
  if (rows.length < 2) throw new Error('File blank hai. Pehle format download karke fill karein.');
  const headerIdx = rows.findIndex(r => String(r.join(' ')).toLowerCase().includes('party'));
  const parties = rows.slice(headerIdx >= 0 ? headerIdx + 1 : 1).map(r => r[0]).filter(p => String(p || '').trim() && !/^NIHARO/i.test(String(p || '')));
  if (!parties.length) throw new Error('Party rows nahi mili. Column: Party Name');
  const data = await api('/api/parties/bulk', { method: 'POST', body: { parties } });
  state = normalizeState(data.state || data.data);
  renderAll();
  toast(parties.length + ' parties imported/updated', 'success');
}
function handleStockNameInput() {
  const input = $('stockName');
  let typed = input.value.toUpperCase();
  if (input.value !== typed) input.value = typed;
  const key = typed.trim().replace(/\s+/g, ' ');
  const exact = state.products && state.products[key];
  if (exact) {
    $('stockLocation').value = exact.location || 'MAIN';
  } else {
    const firstMatch = productKeys().find(p => p.startsWith(key));
    if (firstMatch && !$('stockLocation').value) $('stockLocation').value = state.products[firstMatch]?.location || 'MAIN';
  }
}

function showLogin() { $('loginModal').classList.add('show'); setTimeout(() => $('adminPassword').focus(), 50); }
function hideLogin() { $('loginModal').classList.remove('show'); $('adminPassword').value = ''; }
function parseWhatsApp(text) { const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean); let party = ''; const items = []; for (const line of lines) { if (line.includes('=')) { const parts = line.split('=').map(p => p.trim()); const product = String(parts[0] || '').toUpperCase(); const qty = Number.parseFloat(parts[1] || '0') || 0; const rate = Number.parseFloat(parts[2] || '0') || 0; if (product && qty > 0) items.push({ product, qty, rate }); } else if (!party && !/ram ram|niharo|order/i.test(line)) party = line; } const matched = state.parties.find(p => p.toLowerCase().includes(party.toLowerCase()) || party.toLowerCase().includes(p.toLowerCase())); return { party: matched || party, items }; }
setInterval(() => { if (document.getElementById('targetsBody')) renderTargets(); }, 60000);
function initEvents() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => { $$('.nav-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); $$('.screen').forEach(s => s.classList.remove('active')); $('screen-' + btn.dataset.screen).classList.add('active'); const titles = { dashboard: ['Warehouse dashboard','Inventory, pending orders, dispatch aur MIS ek jagah.'], inventory: ['Inventory','Stock master aur shortage planning.'], orders: ['Orders','Pending aur completed orders tracker.'], masters: ['Master data','Parties aur salesman login management.'], targets: ['Targets','Salesman category/product target tracker.'], reports: ['MIS report','Business report aur filters.'], settings: ['Settings','Backup, restore aur phone web app link.'] }; $('pageTitle').textContent = titles[btn.dataset.screen][0]; $('pageSubtitle').textContent = titles[btn.dataset.screen][1]; document.body.classList.remove('nav-open'); renderAll(); }));
  $('drawerBtn').addEventListener('click', () => document.body.classList.toggle('nav-open')); $('globalSearch').addEventListener('input', renderAll); ['filterSalesman','filterStatus','filterShortage','inventoryCategoryFilter','inventoryStockFilter','inventorySortFilter','reportFrom','reportTo','reportSalesman','reportParty','reportProduct','targetSalesmanFilter','targetCategoryFilter','targetProductFilter'].forEach(id => { if ($(id)) $(id).addEventListener('change', renderAll); }); $('exportReportXls').addEventListener('click', exportReportXls); $('exportReportPdf').addEventListener('click', exportReportPdf); $('clearReportFilters').addEventListener('click', () => { ['reportFrom','reportTo'].forEach(id => $(id).value = ''); ['reportSalesman','reportParty','reportProduct'].forEach(id => $(id).value = 'ALL'); renderAll(); });
  if ($('closeTargetModalBtn')) $('closeTargetModalBtn').addEventListener('click', () => $('targetModal').classList.remove('show')); if ($('saveCategoryTargetBtn')) $('saveCategoryTargetBtn').addEventListener('click', () => saveTarget('category')); if ($('saveProductTargetBtn')) $('saveProductTargetBtn').addEventListener('click', () => saveTarget('product')); if ($('saveTargetSetCategoryBtn')) $('saveTargetSetCategoryBtn').addEventListener('click', () => saveTargetFromTargets('category')); if ($('saveTargetSetProductBtn')) $('saveTargetSetProductBtn').addEventListener('click', () => saveTargetFromTargets('product')); $('adminLoginBtn').addEventListener('click', showLogin); $('closeLoginBtn').addEventListener('click', hideLogin); $('doLoginBtn').addEventListener('click', async () => { try { const data = await api('/api/admin/login', { method: 'POST', body: { password: $('adminPassword').value } }); adminToken = data.token; localStorage.setItem('niharo_admin_token', adminToken); hideLogin(); toast('Admin login successful', 'success'); renderAll(); } catch (e) { toast(e.message, 'error'); } }); $('adminPassword').addEventListener('keydown', e => { if (e.key === 'Enter') $('doLoginBtn').click(); }); $('adminLogoutBtn').addEventListener('click', () => { adminToken = ''; localStorage.removeItem('niharo_admin_token'); renderAll(); toast('Logged out'); });
  $('stockName').addEventListener('input', handleStockNameInput);
  $('downloadProductFormatBtn').addEventListener('click', () => { if (!requireAdmin()) return; downloadProductFormat(); });
  $('downloadPartyFormatBtn').addEventListener('click', () => { if (!requireAdmin()) return; downloadPartyFormat(); });
  $('importProductsBtn').addEventListener('click', () => { if (!requireAdmin()) return; $('productImportFile').click(); });
  $('importPartiesBtn').addEventListener('click', () => { if (!requireAdmin()) return; $('partyImportFile').click(); });
  $('productImportFile').addEventListener('change', async e => { const file = e.target.files[0]; if (!file) return; try { await importProductsFromFile(file); } catch(err) { toast(err.message, 'error'); } e.target.value = ''; });
  $('partyImportFile').addEventListener('change', async e => { const file = e.target.files[0]; if (!file) return; try { await importPartiesFromFile(file); } catch(err) { toast(err.message, 'error'); } e.target.value = ''; });
  $('stockForm').addEventListener('submit', async e => { e.preventDefault(); if (!requireAdmin()) return; try { const data = await api('/api/products/stock', { method: 'POST', body: { name: $('stockName').value, location: $('stockLocation').value || 'MAIN', qty: $('stockQty').value, type: $('stockType').value } }); state = normalizeState(data.state || data.data); e.target.reset(); $('stockType').value = 'IN'; renderAll(); setTimeout(() => $('stockName').focus(), 50); toast('Stock updated', 'success'); } catch (err) { toast(err.message, 'error'); } });
  $('orderItemForm').addEventListener('submit', e => { e.preventDefault(); const product = $('orderProduct').value; const qty = Number.parseFloat($('orderQty').value || '0') || 0; const rate = Number.parseFloat($('orderRate').value || '0') || 0; if (!product || qty <= 0) return toast('Product aur quantity required', 'error'); const existing = cart.find(i => i.product === product); if (existing) { existing.qty += qty; existing.rate = rate; } else cart.push({ product, qty, rate }); $('orderQty').value = ''; $('orderRate').value = ''; renderCart(); });
  $('submitOfficeOrderBtn').addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const party = $('orderParty').value;
    if (!party || !cart.length) return toast('Party aur cart items required', 'error');
    try {
      const method = editingOrderId ? 'PATCH' : 'POST';
      const url = editingOrderId ? '/api/orders/' + encodeURIComponent(editingOrderId) : '/api/orders';
      const body = editingOrderId ? { party, items: cart } : { party, items: cart, salesman: 'OFFICE ADMIN' };
      const data = await api(url, { method, body });
      state = normalizeState(data.state || data.data);
      editingOrderId = '';
      cart = [];
      renderAll();
      toast(method === 'PATCH' ? 'Pending order updated' : 'Order submitted', 'success');
    } catch(e) { toast(e.message, 'error'); }
  });
  $('partyForm').addEventListener('submit', async e => { e.preventDefault(); if (!requireAdmin()) return; try { const data = await api('/api/parties', { method: 'POST', body: { name: $('partyName').value } }); state = normalizeState(data.state || data.data); $('partyName').value = ''; renderAll(); toast('Party added', 'success'); } catch(e) { toast(e.message, 'error'); } });
  $('salesmanForm').addEventListener('submit', async e => { e.preventDefault(); if (!requireAdmin()) return; try { const data = await api('/api/salesmen', { method: 'POST', body: { username: $('salesmanName').value, password: $('salesmanPass').value } }); state = normalizeState(data.state || data.data); $('salesmanName').value = ''; $('salesmanPass').value = ''; renderAll(); toast('Salesman created', 'success'); } catch(e) { toast(e.message, 'error'); } });
  $('openParserBtn').addEventListener('click', () => { if (!requireAdmin()) return; $('parserModal').classList.add('show'); $('parserPreview').innerHTML = ''; $('importParsedBtn').style.display = 'none'; parsedOrder = null; }); $('closeParserBtn').addEventListener('click', () => $('parserModal').classList.remove('show')); $('parseBtn').addEventListener('click', () => { parsedOrder = parseWhatsApp($('parserText').value); if (!parsedOrder.items.length) return toast('Valid item lines nahi mili', 'error'); $('parserPreview').innerHTML = `<div class="card" style="box-shadow:none"><b>Party:</b> ${escapeHtml(parsedOrder.party || 'Not found')}<br><br>${parsedOrder.items.map(i => `• ${escapeHtml(i.product)} — ${qty(i.qty)} ${escapeHtml(productUnit(i.product))} @ ${money(i.rate)}`).join('<br>')}</div>`; $('importParsedBtn').style.display = ''; }); $('importParsedBtn').addEventListener('click', async () => { if (!parsedOrder) return; if (parsedOrder.party && !state.parties.includes(parsedOrder.party)) { if (confirm(`Party "${parsedOrder.party}" listed nahi hai. Add karein?`)) { try { const data = await api('/api/parties', { method: 'POST', body: { name: parsedOrder.party } }); state = normalizeState(data.state || data.data); } catch(e) { toast(e.message, 'error'); return; } } else return; } $('orderParty').value = parsedOrder.party; cart = parsedOrder.items; renderCart(); $('parserModal').classList.remove('show'); toast('Imported to cart', 'success'); });
  $('exportBtn').addEventListener('click', async () => { if (!requireAdmin()) return; try { const data = await api('/api/export'); const blob = new Blob([JSON.stringify(data.store || data.data || data.state, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'niharo-backup-' + new Date().toISOString().slice(0,10) + '.json'; a.click(); URL.revokeObjectURL(a.href); } catch(e) { toast(e.message, 'error'); } });
  $('importFile').addEventListener('change', async e => { if (!requireAdmin()) return; const file = e.target.files[0]; if (!file) return; if (!confirm('Backup import karne se current data replace ho sakta hai. Continue?')) return; try { const raw = JSON.parse(await file.text()); const data = await api('/api/import', { method: 'POST', body: raw }); state = normalizeState(data.state || data.data); renderAll(); toast('Backup imported', 'success'); } catch(err) { toast(err.message, 'error'); } e.target.value = ''; });
  $('resetBtn').addEventListener('click', async () => { if (!requireAdmin()) return; const val = prompt('Full reset ke liye DELETE type karein'); if (val !== 'DELETE') return; try { const data = await api('/api/reset', { method: 'POST', body: { confirm: 'DELETE' } }); state = normalizeState(data.state || data.data); renderAll(); toast('Database reset', 'success'); } catch(e) { toast(e.message, 'error'); } });
}
initEvents();
startPolling();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
