'use strict';
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
let token = localStorage.getItem('niharo_salesman_token') || '';
let user = JSON.parse(localStorage.getItem('niharo_salesman_user') || 'null');
let state = { products: {}, parties: [], orders: [], salesmen: [] };
let cart = [];

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function money(value) { return '₹' + Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function qty(value) { return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function productKeys() { return Object.keys(state.products || {}).sort((a,b)=>a.localeCompare(b)); }
function isDelivered(o) { return String(o.status || '').toLowerCase().includes('delivered'); }
function orderTotal(o) { return (o.items || []).reduce((s,i)=>s+Number(i.qty||0)*Number(i.rate||0),0); }
function isPending(o) { return String(o.status || '').toLowerCase().includes('pending'); }
function pendingDemand(productName) { return (state.orders || []).filter(isPending).reduce((sum, order) => sum + (order.items || []).reduce((s, item) => s + (item.product === productName ? Number(item.qty || 0) : 0), 0), 0); }
function cartDemand(productName) { return cart.reduce((sum, item) => sum + (item.product === productName ? Number(item.qty || 0) : 0), 0); }
function bookableStock(productName) { return Math.max(0, Number(state.products?.[productName]?.available || 0) - pendingDemand(productName) - cartDemand(productName)); }
function productCategory(productName) { return String(state.products?.[productName]?.location || 'UNCATEGORIZED').trim().toUpperCase() || 'UNCATEGORIZED'; }
function targetQty(v) { return v && typeof v === 'object' ? Number(v.qty || v.target || 0) : Number(v || 0); }
function targetIncentive(v) { return v && typeof v === 'object' ? Number(v.incentive || 0) : 0; }
function targetDeadline(v) { return v && typeof v === 'object' ? String(v.deadline || '') : ''; }
function targetCreatedAt(v) { return v && typeof v === 'object' ? String(v.createdAt || '') : ''; }
function productNameForTarget(value) { return String(value || '').trim().toUpperCase().replace(/\s+/g, ' '); }
function targetDisplayKey(storageKey, v) { return productNameForTarget(v && typeof v === 'object' && v.key ? v.key : String(storageKey || '').split('||')[0]); }
function timeLeftLabel(deadline) { if (!deadline) return 'No time set'; const end = new Date(deadline); if (isNaN(end.getTime())) return 'Invalid time'; const diff = end.getTime() - Date.now(); if (diff <= 0) return 'Time over'; const m = Math.floor(diff / 60000); const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mins = m % 60; if (d > 0) return `${d}d ${h}h left`; if (h > 0) return `${h}h ${mins}m left`; return `${mins}m left`; }
function targetTimeClass(deadline) { if (!deadline) return 'badge-user'; const diff = new Date(deadline).getTime() - Date.now(); if (isNaN(diff)) return 'badge-user'; if (diff <= 0) return 'badge-danger'; if (diff < 86400000) return 'badge-pending'; return 'badge-success'; }
function salesmanTargetData() { const row = (state.salesmen || []).find(s => String(s.username || '').toLowerCase() === String(user?.username || '').toLowerCase()); return row?.targets || { categoryTargets: {}, productTargets: {} }; }
function completedQtyForMe(opts = {}) {
  if (!user) return 0;
  const after = opts.after ? new Date(opts.after).getTime() : 0;
  return (state.orders || []).filter(isDelivered).filter(o => String(o.salesman||'').toLowerCase() === String(user.username||'').toLowerCase()).filter(o => {
    if (!after) return true;
    const stamp = o.deliveredAt || (o.deliveredDate ? o.deliveredDate + 'T23:59:59' : '');
    const t = stamp ? new Date(stamp).getTime() : 0;
    return !t || t >= after;
  }).reduce((sum, order) => sum + (order.items || []).reduce((acc, item) => { const prod = item.product; if (opts.category && productCategory(prod) !== opts.category) return acc; if (opts.product && prod !== opts.product) return acc; return acc + Number(item.qty || 0); }, 0), 0);
}
function toast(message, type = '') { const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = message; $('toastStack').appendChild(el); setTimeout(()=>el.remove(), 3300); }
function normalizeState(raw) { raw = raw || {}; return { products: raw.warehouseStock || raw.products || {}, parties: raw.listedParties || raw.parties || [], orders: raw.partyOrders || raw.orders || [], salesmen: raw.salesmenList || raw.salesmen || [] }; }

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, { ...options, headers, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'Request failed');
  return data;
}
function setLive(ok) { $('phoneLive').innerHTML = `<span class="status-dot"></span>${ok ? 'Live' : 'Offline'}`; $('phoneLive').style.background = ok ? 'rgba(255,255,255,.18)' : 'rgba(255,180,120,.28)'; }
async function loadState() { const data = await api('/api/state'); state = normalizeState(data.data || data.state); setLive(true); renderAll(); }
function startPolling() { loadState().catch(()=>setLive(false)); setInterval(()=>loadState().catch(()=>setLive(false)), 10000); }
function showApp() { const logged = Boolean(token && user); $('loginView').style.display = logged ? 'none' : ''; $('appView').style.display = logged ? '' : 'none'; $('phoneNav').style.display = logged ? '' : 'none'; $('salesmanGreeting').textContent = logged ? `Welcome, ${String(user.username || '').toUpperCase()}` : 'Professional phone web app'; $('smAccountName').textContent = logged ? String(user.username || '').toUpperCase() : ''; }
function preserveSelect(select, html) { const value = select.value; select.innerHTML = html; if ([...select.options].some(o=>o.value===value)) select.value = value; }
function filteredParties() { const q = (($('smPartySearch')?.value || '')).trim().toLowerCase(); const parties = (state.parties || []).map(String).filter(Boolean).sort((a,b)=>a.localeCompare(b)); if (!q) return parties; return parties.filter(p => p.toLowerCase().includes(q)); }
function showPartySuggestions() {
  const box = $('smPartySuggestions');
  if (!box) return;
  const rows = filteredParties();
  box.innerHTML = rows.length ? rows.map(p => `<button type="button" class="party-suggestion-item" data-party="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('') : '<div class="party-suggestion-empty">No matching party found</div>';
  box.style.display = 'block';
}
function hidePartySuggestionsSoon() { setTimeout(() => { const box = $('smPartySuggestions'); if (box) box.style.display = 'none'; }, 180); }
function selectPartyName(name) { $('smPartySearch').value = name; const box = $('smPartySuggestions'); if (box) box.style.display = 'none'; }
function renderAll() { showApp(); renderDropdowns(); renderCart(); renderOrders(); renderTargets(); renderStock(); }
function renderDropdowns() {
  const partyList = $('smPartyList');
  if (partyList) partyList.innerHTML = (state.parties || []).map(p => `<option value="${escapeHtml(p)}"></option>`).join('');
}
function filteredProducts() {
  const q = (($('smProductSearch')?.value || '')).trim().toLowerCase();
  const products = productKeys();
  if (!q) return products;
  return products.filter(p => p.toLowerCase().includes(q) || productCategory(p).toLowerCase().includes(q));
}
function showProductSuggestions() {
  const box = $('smProductSuggestions');
  if (!box) return;
  const rows = filteredProducts();
  box.innerHTML = rows.length ? rows.map(p => `<button type="button" class="product-suggestion-item" data-product="${escapeHtml(p)}"><span>${escapeHtml(p)}</span><span class="product-suggestion-meta">Bookable ${qty(bookableStock(p))}</span></button>`).join('') : '<div class="product-suggestion-empty">No matching product found</div>';
  box.style.display = 'block';
}
function hideProductSuggestionsSoon() { setTimeout(() => { const box = $('smProductSuggestions'); if (box) box.style.display = 'none'; }, 180); }
function selectProductName(name) { $('smProductSearch').value = name; const box = $('smProductSuggestions'); if (box) box.style.display = 'none'; $('smQty').focus(); }
function renderCart() { if (!cart.length) { $('smCart').innerHTML = '<div class="empty-state" style="padding:14px">Cart empty hai.</div>'; return; } $('smCart').innerHTML = cart.map((item, idx)=>`<div class="cart-item"><div><b>${escapeHtml(item.product)}</b><div style="color:var(--muted);font-size:13px">${qty(item.qty)} pcs × ${money(item.rate)}</div></div><div style="text-align:right"><b>${money(item.qty*item.rate)}</b><br><button class="btn btn-danger btn-sm" onclick="removeCart(${idx})">Remove</button></div></div>`).join('') + `<div style="text-align:right;margin-top:10px;font-weight:900">Total: ${money(cart.reduce((s,i)=>s+i.qty*i.rate,0))}</div>`; }
window.removeCart = (idx) => { cart.splice(idx,1); renderCart(); };
function itemsHtml(order) { return (order.items||[]).map(i=>`<div class="item-line">• <b>${escapeHtml(i.product)}</b> — ${qty(i.qty)} pcs @ ${money(i.rate)}</div>`).join(''); }
function formatDateTime(order) { const date = order.date ? String(order.date).split('-').reverse().join('/') : 'N/A'; return `${date}${order.time ? ' · ' + escapeHtml(order.time) : ''}`; }
function renderOrders() {
  if (!user) return;
  const mine = (state.orders || []).filter(o => String(o.salesman || '').toLowerCase() === String(user.username || '').toLowerCase());
  $('smOrders').innerHTML = mine.map((o, idx) => {
    const status = isDelivered(o) ? '<span class="badge badge-delivered">Delivered</span>' : '<span class="badge badge-pending">Pending</span>';
    return `<details class="history-order-card">
      <summary>
        <div class="history-main">
          <b>${escapeHtml(o.party)}</b>
          <span>${formatDateTime(o)}</span>
        </div>
        <div class="history-status">${status}<span class="chev">⌄</span></div>
      </summary>
      <div class="history-details">
        ${itemsHtml(o)}
        <div class="history-total">Total: ${money(orderTotal(o))}</div>
      </div>
    </details>`;
  }).join('') || '<div class="empty-state">Abhi koi order nahi hai.</div>';
}

function renderTargets() {
  const box = $('smTargets');
  if (!box) return;
  const targets = salesmanTargetData();
  const rows = [];
  Object.entries(targets.categoryTargets || {}).forEach(([storageKey, meta]) => {
    const key = targetDisplayKey(storageKey, meta);
    const target = targetQty(meta);
    const createdAt = targetCreatedAt(meta);
    if (target > 0) rows.push({ type: 'Category', key, target, incentive: targetIncentive(meta), deadline: targetDeadline(meta), completed: completedQtyForMe({ category: key, after: createdAt }) });
  });
  Object.entries(targets.productTargets || {}).forEach(([storageKey, meta]) => {
    const key = targetDisplayKey(storageKey, meta);
    const target = targetQty(meta);
    const createdAt = targetCreatedAt(meta);
    if (target > 0) rows.push({ type: 'Product', key, target, incentive: targetIncentive(meta), deadline: targetDeadline(meta), completed: completedQtyForMe({ product: key, after: createdAt }) });
  });
  box.innerHTML = rows.map(r => {
    const remaining = Math.max(0, r.target - r.completed);
    const pct = r.target ? Math.min(100, Math.round((r.completed / r.target) * 100)) : 0;
    return `<div class="order-card"><div class="head"><div><b>${escapeHtml(r.key)}</b><div style="color:var(--muted);font-size:12px">${escapeHtml(r.type)} target</div></div><span class="badge ${remaining ? 'badge-pending' : 'badge-success'}">${remaining ? remaining + ' left' : 'Done'}</span></div><div style="height:8px;background:#eef2f7;border-radius:999px;overflow:hidden;margin:12px 0"><div style="height:100%;width:${pct}%;background:#0f6e56"></div></div><div style="display:flex;justify-content:space-between;color:var(--muted);font-size:13px"><span>Completed ${r.completed} pcs</span><span>Target ${r.target} pcs</span></div><div style="display:flex;justify-content:space-between;gap:8px;margin-top:10px;align-items:center"><span class="badge badge-user">Incentive ${r.incentive ? money(r.incentive) : '-'}</span><span class="badge ${targetTimeClass(r.deadline)}">${escapeHtml(timeLeftLabel(r.deadline))}</span></div></div>`;
  }).join('') || '<div class="empty-state">Abhi target set nahi hai.</div>';
}

function renderStock() { const q = ($('smStockSearch').value || '').toLowerCase(); $('smStock').innerHTML = productKeys().filter(p=>p.toLowerCase().includes(q)).map(p=>{ const bookable = bookableStock(p); return `<div class="order-card compact-stock-card"><div class="head"><div><b>${escapeHtml(p)}</b></div><span class="badge ${bookable > 0 ? 'badge-success' : 'badge-danger'}">Bookable ${qty(bookable)} pcs</span></div></div>`; }).join('') || '<div class="empty-state">No product found</div>'; }
function initEvents() {
  $('smLoginBtn').addEventListener('click', async () => { try { const data = await api('/api/salesman/login', { method: 'POST', body: { username: $('smLoginUser').value, password: $('smLoginPass').value } }); token = data.token; user = data.user || { role: 'salesman', username: data.username }; localStorage.setItem('niharo_salesman_token', token); localStorage.setItem('niharo_salesman_user', JSON.stringify(user)); $('smLoginPass').value = ''; toast('Login successful', 'success'); renderAll(); } catch(e) { toast(e.message, 'error'); } });
  $('smLoginPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('smLoginBtn').click(); });
  $$('#phoneNav button').forEach(btn => btn.addEventListener('click', () => { $$('#phoneNav button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); $$('.phone-screen').forEach(s=>s.style.display = 'none'); $('phone-' + btn.dataset.phone).style.display = ''; }));
  $('smPartySearch').addEventListener('focus', showPartySuggestions);
  $('smPartySearch').addEventListener('click', showPartySuggestions);
  $('smPartySearch').addEventListener('input', showPartySuggestions);
  $('smPartySearch').addEventListener('blur', hidePartySuggestionsSoon);
  const partyBox = $('smPartySuggestions');
  if (partyBox) partyBox.addEventListener('mousedown', (e) => { const btn = e.target.closest('.party-suggestion-item'); if (!btn) return; e.preventDefault(); selectPartyName(btn.dataset.party || btn.textContent); });
  $('smProductSearch').addEventListener('focus', showProductSuggestions);
  $('smProductSearch').addEventListener('click', showProductSuggestions);
  $('smProductSearch').addEventListener('input', showProductSuggestions);
  $('smProductSearch').addEventListener('blur', hideProductSuggestionsSoon);
  const productBox = $('smProductSuggestions');
  if (productBox) productBox.addEventListener('mousedown', (e) => { const btn = e.target.closest('.product-suggestion-item'); if (!btn) return; e.preventDefault(); selectProductName(btn.dataset.product || btn.textContent); });
  $('smAddItem').addEventListener('click', () => { const typedProduct = ($('smProductSearch').value || '').trim(); const matchedProduct = productKeys().find(p => p.toLowerCase() === typedProduct.toLowerCase()); const product = matchedProduct || typedProduct.toUpperCase(); const qtyValue = Number.parseFloat($('smQty').value || '0') || 0; const rate = Number.parseFloat($('smRate').value || '0') || 0; if (!matchedProduct || qtyValue <= 0) return toast('List me se valid product aur qty select karein', 'error'); const availableNow = bookableStock(product); if (qtyValue > availableNow && !confirm(`Bookable stock ${qty(availableNow)} pcs hai. Phir bhi order add karein?`)) return; const existing = cart.find(i=>i.product===product); if (existing) { existing.qty += qtyValue; existing.rate = rate; } else cart.push({ product, qty: qtyValue, rate }); $('smProductSearch').value = ''; $('smQty').value = ''; $('smRate').value = ''; renderAll(); setTimeout(() => $('smProductSearch').focus(), 50); });
  $('smSubmitOrder').addEventListener('click', async () => { const party = ($('smPartySearch').value || '').trim(); const validParty = (state.parties || []).some(p => String(p).toLowerCase() === party.toLowerCase()); if (!party || !cart.length) return toast('Party aur cart required', 'error'); if (!validParty) return toast('List me se valid party select karein', 'error'); try { const data = await api('/api/orders', { method: 'POST', body: { party, items: cart } }); state = normalizeState(data.state || data.data); cart = []; $('smPartySearch').value = ''; $('smProductSearch').value = ''; $('smQty').value = ''; $('smRate').value = ''; renderAll(); toast('Order submitted live', 'success'); } catch(e) { toast(e.message, 'error'); } });
  $('smStockSearch').addEventListener('input', renderStock);
  $('smLogoutBtn').addEventListener('click', () => { token = ''; user = null; localStorage.removeItem('niharo_salesman_token'); localStorage.removeItem('niharo_salesman_user'); cart = []; renderAll(); });
  $('installHintBtn').addEventListener('click', () => toast('Chrome menu se Install app / Add to Home Screen dabao.'));
}
setInterval(() => { if (token) renderTargets(); }, 60000);
initEvents(); showApp(); startPolling(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
