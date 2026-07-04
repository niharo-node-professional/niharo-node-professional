'use strict';
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
let token = localStorage.getItem('niharo_salesman_token') || '';
let user = JSON.parse(localStorage.getItem('niharo_salesman_user') || 'null');
let state = { products: {}, parties: [], orders: [], salesmen: [] };
let cart = [];
let editingOrderId = null;

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function jsString(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' '); }
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
function activeSalesmanExists() {
  if (!user || !user.username) return false;
  return (state.salesmen || []).some(s => String(s.username || '').toLowerCase() === String(user.username || '').toLowerCase());
}
function forceSalesmanLogout(message) {
  token = '';
  user = null;
  cart = [];
  editingOrderId = null;
  localStorage.removeItem('niharo_salesman_token');
  localStorage.removeItem('niharo_salesman_user');
  showApp();
  if (message) toast(message, 'error');
}
async function loadState() {
  const data = await api('/api/state');
  state = normalizeState(data.data || data.state);
  setLive(true);
  if (token && user && !activeSalesmanExists()) {
    forceSalesmanLogout('Account reset/delete ho gaya. Dobara login karein.');
    return;
  }
  renderAll();
}
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
function resetOrderForm() {
  editingOrderId = null;
  cart = [];
  $('smPartySearch').value = '';
  $('smProductSearch').value = '';
  $('smQty').value = '';
  $('smRate').value = '';
  const btn = $('smSubmitOrder');
  if (btn) btn.textContent = 'Submit order';
  const cancelBtn = $('smCancelEdit');
  if (cancelBtn) cancelBtn.style.display = 'none';
  renderCart();
}
function enterOrderEdit(orderId) {
  const order = (state.orders || []).find(o => o.id === orderId);
  if (!order) return toast('Order not found', 'error');
  if (isDelivered(order)) return toast('Delivered order edit nahi ho sakta', 'error');
  editingOrderId = orderId;
  $('smPartySearch').value = order.party || '';
  cart = (order.items || []).map(i => ({ product: i.product, qty: Number(i.qty || 0), rate: Number(i.rate || 0) }));
  $('smProductSearch').value = '';
  $('smQty').value = '';
  $('smRate').value = '';
  $('smSubmitOrder').textContent = 'Update pending order';
  const cancelBtn = $('smCancelEdit');
  if (cancelBtn) cancelBtn.style.display = '';
  $$('#phoneNav button').forEach(b=>b.classList.remove('active'));
  const orderBtn = $$('#phoneNav button').find(b=>b.dataset.phone === 'order');
  if (orderBtn) orderBtn.classList.add('active');
  $$('.phone-screen').forEach(s=>s.style.display = 'none');
  $('phone-order').style.display = '';
  renderCart();
  toast('Pending order edit mode open', 'success');
}
window.enterOrderEdit = enterOrderEdit;
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

function titleCaseText(value) {
  return String(value || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}
function cleanWhatsAppProductName(name) {
  const raw = String(name || '').trim();
  const compact = raw.replace(/\s+/g, '');
  const mOil = compact.match(/^M(\d+(?:\.\d+)?)$/i);
  if (mOil) return mOil[1];
  return raw;
}
function cleanWhatsAppQty(value) {
  const n = Number(value || 0);
  if (Number.isInteger(n) && n >= 0 && n < 10) return String(n).padStart(2, '0');
  return String(n).replace(/\.0+$/, '');
}
function cleanWhatsAppRate(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 100) / 100).replace(/\.0+$/, '');
}
function whatsappCategoryName(category) {
  const c = String(category || '').trim();
  const u = c.toUpperCase();
  if (u.includes('OIL')) return 'Oil';
  if (u.includes('FLOUR') || u.includes('FLOOR') || u.includes('ATTA')) return 'Atta';
  return titleCaseText(c || 'Products');
}
function whatsappUnitForCategory(category) {
  const u = String(category || '').toUpperCase();
  if (u.includes('FLOUR') || u.includes('FLOOR') || u.includes('ATTA')) return 'Bag';
  return 'Box';
}
function splitPartyForWhatsApp(party) {
  const raw = String(party || '').trim();
  if (!raw) return ['Party'];
  const parts = raw.split(/[-,]/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [raw];
}
function orderPlainText(order) {
  const lines = [];
  const partyLines = splitPartyForWhatsApp(order.party);
  lines.push('Ram Ram ji');
  lines.push(...partyLines);
  lines.push('');

  const groups = {};
  (order.items || []).forEach(item => {
    const category = productCategory(item.product) || item.category || 'Products';
    const key = whatsappCategoryName(category);
    if (!groups[key]) groups[key] = { category, items: [], totalQty: 0 };
    groups[key].items.push(item);
    groups[key].totalQty += Number(item.qty || 0);
  });

  Object.keys(groups).forEach((groupName, groupIndex) => {
    const group = groups[groupName];
    lines.push(groupName);
    group.items.forEach(item => {
      lines.push(`${cleanWhatsAppProductName(item.product)}=${cleanWhatsAppQty(item.qty)}=${cleanWhatsAppRate(item.rate)}`);
    });
    lines.push(`Total=${cleanWhatsAppQty(group.totalQty)} ${whatsappUnitForCategory(group.category)}`);
    if (groupIndex < Object.keys(groups).length - 1) lines.push('');
  });

  lines.push('');
  lines.push('Delivery 🚛🚛');
  return lines.join('\n');
}
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.focus();
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}
window.copyOrderWhatsApp = async (orderId) => {
  const order = (state.orders || []).find(o => String(o.id) === String(orderId));
  if (!order) return toast('Order not found', 'error');
  try {
    await copyText(orderPlainText(order));
    toast('Order text copied. WhatsApp me paste kar do.', 'success');
  } catch (e) {
    toast('Copy nahi hua. WhatsApp button use karo.', 'error');
  }
};
window.openOrderWhatsApp = (orderId) => {
  const order = (state.orders || []).find(o => String(o.id) === String(orderId));
  if (!order) return toast('Order not found', 'error');
  window.open('https://wa.me/?text=' + encodeURIComponent(orderPlainText(order)), '_blank');
};
function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
window.downloadEstimatedChallan = (orderId) => {
  const order = (state.orders || []).find(o => String(o.id) === String(orderId));
  if (!order) return toast('Order not found', 'error');
  const items = order.items || [];
  const canvas = document.createElement('canvas');
  const width = 1080;
  const rowH = 64;
  const height = Math.max(1180, 520 + items.length * rowH);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  drawRoundedRect(ctx, 36, 36, width - 72, height - 72, 26);
  ctx.fill();
  ctx.strokeStyle = '#dbe3ee';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#0f6e56';
  drawRoundedRect(ctx, 66, 66, 78, 78, 22);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 42px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('N', 105, 119);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#111827';
  ctx.font = '900 34px Arial';
  ctx.fillText('Niharo WMS Pro', 166, 94);
  ctx.font = '700 17px Arial';
  ctx.fillStyle = '#64748b';
  ctx.fillText('Salesman estimated challan for party confirmation', 166, 124);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ef4444';
  ctx.font = '900 28px Arial';
  ctx.fillText('ESTIMATE', width - 66, 92);
  ctx.font = '700 16px Arial';
  ctx.fillStyle = '#64748b';
  ctx.fillText('Not final invoice', width - 66, 120);
  ctx.textAlign = 'left';
  const infoY = 170;
  ctx.fillStyle = '#eefcf4';
  drawRoundedRect(ctx, 66, infoY, width - 132, 146, 22);
  ctx.fill();
  ctx.strokeStyle = '#bbf7d0';
  ctx.stroke();
  ctx.fillStyle = '#475569';
  ctx.font = '800 15px Arial';
  ctx.fillText('PARTY', 94, infoY + 38);
  ctx.fillText('DATE / TIME', 94, infoY + 92);
  ctx.fillText('SALESMAN', 590, infoY + 92);
  ctx.fillStyle = '#111827';
  ctx.font = '900 28px Arial';
  ctx.fillText(String(order.party || '-'), 94, infoY + 66);
  ctx.font = '800 21px Arial';
  ctx.fillText(String(order.date || '-') + (order.time ? '  ' + order.time : ''), 94, infoY + 120);
  ctx.fillText(String(order.salesman || user?.username || '').toUpperCase(), 590, infoY + 120);
  const tableX = 66;
  const tableY = 360;
  const tableW = width - 132;
  ctx.fillStyle = '#111827';
  drawRoundedRect(ctx, tableX, tableY, tableW, 54, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 16px Arial';
  ctx.fillText('PRODUCT', tableX + 22, tableY + 34);
  ctx.textAlign = 'right';
  ctx.fillText('QTY', tableX + 610, tableY + 34);
  ctx.fillText('RATE', tableX + 760, tableY + 34);
  ctx.fillText('AMOUNT', tableX + tableW - 22, tableY + 34);
  ctx.textAlign = 'left';
  let y = tableY + 54;
  items.forEach((item, idx) => {
    ctx.fillStyle = idx % 2 ? '#ffffff' : '#f8fafc';
    ctx.fillRect(tableX, y, tableW, rowH);
    ctx.strokeStyle = '#e5e7eb';
    ctx.beginPath();
    ctx.moveTo(tableX, y + rowH);
    ctx.lineTo(tableX + tableW, y + rowH);
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.font = '800 21px Arial';
    ctx.fillText(String(item.product || ''), tableX + 22, y + 39);
    ctx.textAlign = 'right';
    ctx.font = '700 19px Arial';
    ctx.fillText(qty(item.qty), tableX + 610, y + 39);
    ctx.fillText(money(item.rate), tableX + 760, y + 39);
    ctx.font = '900 20px Arial';
    ctx.fillText(money(Number(item.qty || 0) * Number(item.rate || 0)), tableX + tableW - 22, y + 39);
    ctx.textAlign = 'left';
    y += rowH;
  });
  const totalY = y + 34;
  ctx.fillStyle = '#fef3c7';
  drawRoundedRect(ctx, width - 430, totalY, 364, 74, 18);
  ctx.fill();
  ctx.strokeStyle = '#fde68a';
  ctx.stroke();
  ctx.fillStyle = '#92400e';
  ctx.font = '800 16px Arial';
  ctx.fillText('ESTIMATED TOTAL', width - 402, totalY + 27);
  ctx.fillStyle = '#111827';
  ctx.font = '900 28px Arial';
  ctx.fillText(money(orderTotal(order)), width - 402, totalY + 58);
  ctx.fillStyle = '#64748b';
  ctx.font = '700 16px Arial';
  ctx.fillText('Note: Final delivery and stock will be confirmed by warehouse.', 66, height - 100);
  ctx.fillText('Generated from Niharo Salesman App', 66, height - 72);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/jpeg', 0.95);
  a.download = `estimated-challan-${String(order.party || 'party').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${order.date || ''}.jpg`;
  a.click();
  toast('Estimated challan JPEG downloaded', 'success');
};
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
        <div class="history-actions">
          ${isDelivered(o) ? '' : `<button class="btn btn-warning btn-sm" onclick="enterOrderEdit('${jsString(o.id)}')">Edit</button>`}
          <button class="btn btn-soft btn-sm" onclick="copyOrderWhatsApp('${jsString(o.id)}')">Copy WhatsApp</button>
          <button class="btn btn-success btn-sm" onclick="openOrderWhatsApp('${jsString(o.id)}')">Open WhatsApp</button>
          <button class="btn btn-blue btn-sm" onclick="downloadEstimatedChallan('${jsString(o.id)}')">Estimate JPEG</button>
        </div>
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
  $('smSubmitOrder').addEventListener('click', async () => { const party = ($('smPartySearch').value || '').trim(); const validParty = (state.parties || []).some(p => String(p).toLowerCase() === party.toLowerCase()); if (!party || !cart.length) return toast('Party aur cart required', 'error'); if (!validParty) return toast('List me se valid party select karein', 'error'); try { const data = await api(editingOrderId ? `/api/orders/${encodeURIComponent(editingOrderId)}` : '/api/orders', { method: editingOrderId ? 'PATCH' : 'POST', body: { party, items: cart } }); state = normalizeState(data.state || data.data); resetOrderForm(); renderAll(); toast(editingOrderId ? 'Order updated live' : 'Order submitted live', 'success'); } catch(e) { toast(e.message, 'error'); } });
  const cancelEditBtn = $('smCancelEdit');
  if (cancelEditBtn) cancelEditBtn.addEventListener('click', () => { resetOrderForm(); toast('Edit cancelled'); });
  $('smStockSearch').addEventListener('input', renderStock);
  $('smLogoutBtn').addEventListener('click', () => { forceSalesmanLogout('Logged out'); });
  $('installHintBtn').addEventListener('click', () => toast('Chrome menu se Install app / Add to Home Screen dabao.'));
}
setInterval(() => { if (token) renderTargets(); }, 60000);
initEvents(); showApp(); startPolling(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
