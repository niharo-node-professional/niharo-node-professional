'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
let XLSX = null;
try { XLSX = require('xlsx'); } catch (_) { XLSX = null; }

loadEnv();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';
const APP_SECRET = process.env.APP_SECRET || 'change-this-niharo-secret';
const DB_FILE = path.resolve(ROOT, process.env.DB_FILE || './data/store.json');

let storeCache = null;
let writeQueue = Promise.resolve();
const sseClients = new Set();

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

function emptyStore() {
  return {
    products: {},
    parties: [],
    orders: [],
    salesmen: {},
    meta: { app: 'Niharo WMS Pro', version: '2.0.0' }
  };
}

function productName(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
}
function username(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}
function status(value) {
  return String(value || '').toLowerCase().includes('deliver') ? 'Delivered' : 'Pending';
}
function normalizeTargetValue(v, storageKey) {
  const baseKey = String(storageKey || '').split('||')[0];
  if (v && typeof v === 'object') {
    const qty = Math.max(0, Number(v.qty || v.target || 0));
    const incentive = Math.max(0, Number(v.incentive || 0));
    const deadline = String(v.deadline || '').trim();
    const key = productName(v.key || baseKey);
    const createdAt = String(v.createdAt || '').trim();
    const id = String(v.id || '').trim();
    return qty > 0 ? { qty, incentive, deadline, key, createdAt, id } : null;
  }
  const qty = Math.max(0, Number(v || 0));
  return qty > 0 ? { qty, incentive: 0, deadline: '', key: productName(baseKey), createdAt: '', id: '' } : null;
}
function normalizeTargets(input) {
  input = input && typeof input === 'object' ? input : {};
  const out = { categoryTargets: {}, productTargets: {} };
  for (const [k, v] of Object.entries(input.categoryTargets || {})) {
    const tv = normalizeTargetValue(v, k);
    const storageKey = String(k || '').includes('||') ? String(k) : (tv && tv.key ? tv.key : productName(k));
    if (storageKey && tv) out.categoryTargets[storageKey] = tv;
  }
  for (const [k, v] of Object.entries(input.productTargets || {})) {
    const tv = normalizeTargetValue(v, k);
    const storageKey = String(k || '').includes('||') ? String(k) : (tv && tv.key ? tv.key : productName(k));
    if (storageKey && tv) out.productTargets[storageKey] = tv;
  }
  return out;
}
function today() {
  const d = new Date();
  return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 5), iso: d.toISOString() };
}

function normalizeStore(input) {
  const out = emptyStore();
  input = input && typeof input === 'object' ? input : {};

  const sourceProducts = input.products || input.warehouseStock || {};
  if (sourceProducts && typeof sourceProducts === 'object') {
    for (const [rawKey, rawItem] of Object.entries(sourceProducts)) {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      const name = productName(item.name || rawKey);
      if (!name) continue;
      out.products[name] = {
        name,
        location: productName(item.location || 'MAIN') || 'MAIN',
        available: Math.max(0, Number(item.available || item.stock || 0)),
        lastStatus: String(item.lastStatus || item.last_status || 'Imported'),
        updatedAt: item.updatedAt || item.updated_at || today().iso
      };
    }
  }

  let sourceParties = input.parties || input.listedParties || [];
  if (!Array.isArray(sourceParties) && typeof sourceParties === 'object') sourceParties = Object.values(sourceParties);
  out.parties = Array.from(new Set((Array.isArray(sourceParties) ? sourceParties : []).map((p) => String(p || '').trim()).filter(Boolean)));

  let sourceOrders = input.orders || input.partyOrders || [];
  if (!Array.isArray(sourceOrders) && typeof sourceOrders === 'object') sourceOrders = Object.values(sourceOrders);
  out.orders = (Array.isArray(sourceOrders) ? sourceOrders : []).map(normalizeOrder).filter(Boolean);

  const sourceSalesmen = input.salesmen || input.salesmenList || {};
  if (Array.isArray(sourceSalesmen)) {
    for (const item of sourceSalesmen) {
      const u = username(item && (item.username || item.user));
      if (!u) continue;
      out.salesmen[u] = {
        username: u,
        passwordHash: item.passwordHash || hashPassword(String(item.password || '1234')),
        createdAt: item.createdAt || today().iso,
        targets: normalizeTargets(item.targets || {})
      };
    }
  } else if (sourceSalesmen && typeof sourceSalesmen === 'object') {
    for (const [rawUser, rawVal] of Object.entries(sourceSalesmen)) {
      const u = username(rawUser);
      if (!u) continue;
      if (typeof rawVal === 'string') {
        out.salesmen[u] = {
          username: u,
          passwordHash: rawVal.includes(':') ? rawVal : hashPassword(rawVal),
          createdAt: today().iso,
          targets: { categoryTargets: {}, productTargets: {} }
        };
      } else if (rawVal && typeof rawVal === 'object') {
        out.salesmen[u] = {
          username: u,
          passwordHash: rawVal.passwordHash || hashPassword(String(rawVal.password || '1234')),
          createdAt: rawVal.createdAt || today().iso,
          targets: normalizeTargets(rawVal.targets || {})
        };
      }
    }
  }

  out.meta = Object.assign({}, input.meta || {}, out.meta, { savedAt: input.meta?.savedAt || today().iso });
  return out;
}

function normalizeOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const items = Array.isArray(order.items) ? order.items.map(normalizeItem).filter(Boolean) : [];
  const party = String(order.party || '').trim();
  if (!party || !items.length) return null;
  const t = today();
  return {
    id: String(order.id || crypto.randomUUID()),
    party,
    salesman: String(order.salesman || 'OFFICE ADMIN').trim() || 'OFFICE ADMIN',
    date: String(order.date || t.date).slice(0, 10),
    time: String(order.time || t.time).slice(0, 5),
    status: status(order.status),
    items,
    createdAt: order.createdAt || t.iso,
    deliveredDate: order.deliveredDate || null,
    deliveredAt: order.deliveredAt || null
  };
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const product = productName(item.product || item.name);
  const qty = Math.max(0, Number(item.qty || item.quantity || 0));
  const rate = Math.max(0, Number(item.rate || 0));
  if (!product || qty <= 0) return null;
  return { product, qty, rate };
}

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) await fsp.writeFile(DB_FILE, JSON.stringify(emptyStore(), null, 2));
}
async function loadStore() {
  await ensureStore();
  if (storeCache) return storeCache;
  try {
    const raw = await fsp.readFile(DB_FILE, 'utf8');
    storeCache = normalizeStore(JSON.parse(raw || '{}'));
  } catch (err) {
    const backup = DB_FILE + '.broken-' + Date.now();
    if (fs.existsSync(DB_FILE)) await fsp.copyFile(DB_FILE, backup);
    storeCache = emptyStore();
    await saveStore(storeCache);
  }
  return storeCache;
}
async function saveStore(store) {
  store.meta = Object.assign({}, store.meta || {}, { savedAt: today().iso });
  await fsp.mkdir(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2));
  await fsp.rename(tmp, DB_FILE);
}
function updateStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const store = await loadStore();
    const result = await mutator(store);
    storeCache = normalizeStore(store);
    await saveStore(storeCache);
    broadcastState();
    return result;
  });
  return writeQueue;
}

function sanitize(store) {
  return {
    products: store.products || {},
    parties: store.parties || [],
    orders: store.orders || [],
    salesmen: Object.keys(store.salesmen || {}).sort().map((u) => ({ username: u, createdAt: store.salesmen[u].createdAt || null, targets: normalizeTargets(store.salesmen[u].targets || {}) })),
    meta: store.meta || {}
  };
}
async function currentState() {
  return sanitize(await loadStore());
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(String(password), s, 100000, 32, 'sha256').toString('hex');
  return s + ':' + h;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  if (typeof stored !== 'string') stored = String(stored.passwordHash || stored.password || '');
  const parts = stored.split(':');
  if (parts.length !== 2) return String(password) === stored;
  const candidate = hashPassword(password, parts[0]);
  try { return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(stored)); } catch (_) { return false; }
}
function tokenSign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function tokenVerify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) { return null; }
}
function makeToken(role, user) {
  return tokenSign({ role, user, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 });
}
function auth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return tokenVerify(header.slice(7));
}
function need(req, res, roles) {
  const a = auth(req);
  if (!a || !roles.includes(a.role)) {
    json(res, 401, { error: 'Login required' });
    return null;
  }
  return a;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 15 * 1024 * 1024) reject(new Error('Payload too large')); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function spreadsheetRowsFromBase64(base64, filename) {
  if (!XLSX) throw new Error('Excel parser missing. package.json dependencies install hone dein, phir redeploy karein.');
  const clean = String(base64 || '').replace(/^data:.*?;base64,/, '');
  if (!clean) throw new Error('File data missing');
  const buffer = Buffer.from(clean, 'base64');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames && wb.SheetNames[0];
  if (!sheetName) throw new Error('Excel sheet blank hai');
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return rows.map(r => (Array.isArray(r) ? r.map(c => String(c ?? '').trim()) : [])).filter(r => r.some(Boolean));
}
function findHeaderIndex(rows, requiredWords) {
  for (let i = 0; i < rows.length; i++) {
    const joined = rows[i].map(c => String(c || '').toLowerCase()).join(' | ');
    if (requiredWords.every(w => joined.includes(w))) return i;
  }
  return rows.length && rows[0].length > 1 ? 0 : -1;
}
function productsFromRows(rows) {
  const idx = findHeaderIndex(rows, ['product']);
  const start = idx >= 0 ? idx + 1 : 0;
  const out = [];
  for (const r of rows.slice(start)) {
    const first = String(r[0] || '').trim();
    if (!first || /^niharo/i.test(first) || /^product\s*name$/i.test(first)) continue;
    out.push({ name: first, location: r[1] || 'MAIN', available: r[2] || 0 });
  }
  return out;
}
function partiesFromRows(rows) {
  const idx = findHeaderIndex(rows, ['party']);
  const start = idx >= 0 ? idx + 1 : 0;
  const out = [];
  for (const r of rows.slice(start)) {
    const first = String(r[0] || '').trim();
    if (!first || /^niharo/i.test(first) || /^party\s*name$/i.test(first)) continue;
    out.push(first);
  }
  return out;
}

async function okState(res) {
  json(res, 200, { ok: true, state: await currentState() });
}
function notFound(res) { json(res, 404, { error: 'Not found' }); }
function bad(res, msg) { json(res, 400, { error: msg || 'Bad request' }); }

async function handleApi(req, res, url) {
  const m = req.method;
  const p = decodeURIComponent(url.pathname);

  if (m === 'GET' && p === '/api/health') return json(res, 200, { ok: true, app: 'Niharo WMS Pro', time: new Date().toISOString() });
  if (m === 'GET' && p === '/api/state') return json(res, 200, { state: await currentState() });
  if (m === 'GET' && p === '/api/events') return openEvents(req, res);

  if (m === 'POST' && p === '/api/admin/login') {
    const b = await body(req);
    if (String(b.password || '') !== ADMIN_PASSWORD) return json(res, 403, { error: 'Wrong admin password' });
    return json(res, 200, { token: makeToken('admin', 'admin') });
  }

  if (m === 'POST' && p === '/api/salesman/login') {
    const b = await body(req);
    const u = username(b.username);
    const pass = String(b.password || '');
    const store = await loadStore();
    const account = store.salesmen[u];
    if (!account || !verifyPassword(pass, account.passwordHash)) return json(res, 403, { error: 'Wrong username or password' });
    return json(res, 200, { token: makeToken('salesman', u), user: { username: u } });
  }

  if (m === 'POST' && p === '/api/products/stock') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    const name = productName(b.name);
    const qty = Math.max(0, Number(b.qty ?? 0));
    const location = productName(b.location || 'MAIN') || 'MAIN';
    const type = String(b.type || 'IN').toUpperCase();
    if (!name || Number.isNaN(qty) || qty < 0) return bad(res, 'Product and valid quantity required');
    await updateStore((store) => {
      if (!store.products[name]) store.products[name] = { name, location, available: 0, lastStatus: '', updatedAt: today().iso };
      store.products[name].location = location;
      if (type === 'OUT') {
        store.products[name].available = Math.max(0, Number(store.products[name].available || 0) - qty);
        store.products[name].lastStatus = '-' + qty + ' Out';
      } else {
        store.products[name].available = Math.max(0, Number(store.products[name].available || 0) + qty);
        store.products[name].lastStatus = '+' + qty + ' In';
      }
      store.products[name].updatedAt = today().iso;
    });
    return okState(res);
  }


  if (m === 'POST' && p === '/api/products/import-file') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    let products = [];
    try { products = productsFromRows(spreadsheetRowsFromBase64(b.base64, b.filename)); }
    catch (e) { return bad(res, e.message || 'Excel read nahi ho paayi'); }
    if (!products.length) return bad(res, 'Product rows nahi mili. Columns: Product Name, Category, Available Stock');
    await updateStore((store) => {
      for (const raw of products) {
        const name = productName(raw.name || raw.product || raw['Product Name']);
        if (!name) continue;
        const location = productName(raw.location || raw.Location || raw.category || raw.Category || 'MAIN') || 'MAIN';
        const available = Math.max(0, Number(raw.available ?? raw.stock ?? raw['Available Stock'] ?? 0));
        store.products[name] = { name, location, available, lastStatus: 'Imported from Excel', updatedAt: today().iso };
      }
    });
    return json(res, 200, { ok: true, imported: products.length, state: await currentState() });
  }

  if (m === 'POST' && p === '/api/parties/import-file') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    let parties = [];
    try { parties = partiesFromRows(spreadsheetRowsFromBase64(b.base64, b.filename)); }
    catch (e) { return bad(res, e.message || 'Excel read nahi ho paayi'); }
    if (!parties.length) return bad(res, 'Party rows nahi mili. Column: Party Name');
    await updateStore((store) => {
      for (const raw of parties) {
        const name = String(raw || '').trim();
        if (name && !store.parties.includes(name)) store.parties.push(name);
      }
    });
    return json(res, 200, { ok: true, imported: parties.length, state: await currentState() });
  }


  if (m === 'POST' && p === '/api/products/bulk') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    const products = Array.isArray(b.products) ? b.products : [];
    if (!products.length) return bad(res, 'Products list required');
    await updateStore((store) => {
      for (const raw of products) {
        const name = productName(raw.name || raw.product || raw['Product Name']);
        if (!name) continue;
        const location = productName(raw.location || raw.Location || raw.category || raw.Category || 'MAIN') || 'MAIN';
        const available = Math.max(0, Number(raw.available ?? raw.stock ?? raw['Available Stock'] ?? 0));
        store.products[name] = {
          name,
          location,
          available,
          lastStatus: 'Imported from Excel',
          updatedAt: today().iso
        };
      }
    });
    return okState(res);
  }

  const productMatch = p.match(/^\/api\/products\/(.+)$/);
  if (productMatch) {
    if (!need(req, res, ['admin'])) return;
    const name = productName(productMatch[1]);
    if (!name) return bad(res, 'Product required');
    if (m === 'PUT') {
      const b = await body(req);
      await updateStore((store) => {
        if (!store.products[name]) throw new Error('Product not found');
        store.products[name].location = productName(b.location || 'MAIN') || 'MAIN';
        store.products[name].available = Math.max(0, Number(b.available ?? 0));
        store.products[name].lastStatus = 'Manual edit';
        store.products[name].updatedAt = today().iso;
      });
      return okState(res);
    }
    if (m === 'DELETE') {
      await updateStore((store) => { delete store.products[name]; });
      return okState(res);
    }
  }


  if (m === 'POST' && p === '/api/parties/bulk') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    const parties = Array.isArray(b.parties) ? b.parties : [];
    if (!parties.length) return bad(res, 'Parties list required');
    await updateStore((store) => {
      for (const raw of parties) {
        const name = String(raw && typeof raw === 'object' ? (raw.name || raw.party || raw['Party Name']) : raw || '').trim();
        if (name && !store.parties.includes(name)) store.parties.push(name);
      }
    });
    return okState(res);
  }

  if (m === 'POST' && p === '/api/parties') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    const name = String(b.name || '').trim();
    if (!name) return bad(res, 'Party name required');
    await updateStore((store) => { if (!store.parties.includes(name)) store.parties.push(name); });
    return okState(res);
  }
  const partyMatch = p.match(/^\/api\/parties\/(\d+)$/);
  if (partyMatch) {
    if (!need(req, res, ['admin'])) return;
    const idx = Number(partyMatch[1]);
    if (m === 'PUT') {
      const b = await body(req);
      const name = String(b.name || '').trim();
      if (!name) return bad(res, 'Party name required');
      await updateStore((store) => {
        const old = store.parties[idx];
        if (old === undefined) throw new Error('Party not found');
        store.parties[idx] = name;
        store.orders.forEach((o) => { if (o.party === old) o.party = name; });
      });
      return okState(res);
    }
    if (m === 'DELETE') {
      await updateStore((store) => { if (idx >= 0) store.parties.splice(idx, 1); });
      return okState(res);
    }
  }

  if (m === 'POST' && p === '/api/salesmen') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    const u = username(b.username);
    const pass = String(b.password || '');
    if (!u || !pass) return bad(res, 'Username and password required');
    await updateStore((store) => {
      if (store.salesmen[u]) throw new Error('Salesman already exists');
      store.salesmen[u] = { username: u, passwordHash: hashPassword(pass), createdAt: today().iso, targets: { categoryTargets: {}, productTargets: {} } };
    });
    return okState(res);
  }

  const salesmanTargetMatch = p.match(/^\/api\/salesmen\/([^/]+)\/targets$/);
  if (salesmanTargetMatch && m === 'PUT') {
    if (!need(req, res, ['admin'])) return;
    const u = username(salesmanTargetMatch[1]);
    const b = await body(req);
    const type = String(b.type || '').toLowerCase();
    const key = productName(b.key);
    const qty = Math.max(0, Number(b.qty || 0));
    const incentive = Math.max(0, Number(b.incentive || 0));
    const deadline = String(b.deadline || '').trim();
    if (!u || !key || !['category','product'].includes(type)) return bad(res, 'Salesman, target type and key required');
    await updateStore((store) => {
      if (!store.salesmen[u]) throw new Error('Salesman not found');
      if (!store.salesmen[u].targets) store.salesmen[u].targets = { categoryTargets: {}, productTargets: {} };
      const bucket = type === 'category' ? 'categoryTargets' : 'productTargets';
      if (!store.salesmen[u].targets[bucket]) store.salesmen[u].targets[bucket] = {};
      if (qty > 0) {
        const id = crypto.randomUUID();
        const storageKey = key + '||' + id;
        store.salesmen[u].targets[bucket][storageKey] = { id, key, qty, incentive, deadline, createdAt: today().iso };
      } else {
        delete store.salesmen[u].targets[bucket][key];
      }
      store.salesmen[u].updatedAt = today().iso;
    });
    return okState(res);
  }

  const salesmanMatch = p.match(/^\/api\/salesmen\/(.+)$/);
  if (salesmanMatch) {
    if (!need(req, res, ['admin'])) return;
    const u = username(salesmanMatch[1]);
    if (!u) return bad(res, 'Username required');
    if (m === 'PUT') {
      const b = await body(req);
      const pass = String(b.password || '');
      if (!pass) return bad(res, 'Password required');
      await updateStore((store) => {
        if (!store.salesmen[u]) throw new Error('Salesman not found');
        store.salesmen[u].passwordHash = hashPassword(pass);
        store.salesmen[u].updatedAt = today().iso;
      });
      return okState(res);
    }
    if (m === 'DELETE') {
      await updateStore((store) => { delete store.salesmen[u]; });
      return okState(res);
    }
  }

  if (m === 'POST' && p === '/api/orders') {
    const a = need(req, res, ['admin', 'salesman']);
    if (!a) return;
    const b = await body(req);
    const party = String(b.party || '').trim();
    const items = Array.isArray(b.items) ? b.items.map(normalizeItem).filter(Boolean) : [];
    if (!party || !items.length) return bad(res, 'Party and cart items required');
    await updateStore((store) => {
      if (a.role === 'salesman' && !store.salesmen[username(a.user)]) throw new Error('Salesman account reset/delete ho gaya. Dobara login karein.');
      const t = today();
      const bookedBy = a.role === 'salesman' ? username(a.user) : String(b.salesman || 'OFFICE ADMIN').trim() || 'OFFICE ADMIN';
      for (const item of items) {
        if (!store.products[item.product]) store.products[item.product] = { name: item.product, location: 'MAIN', available: 0, lastStatus: 'Auto added from order', updatedAt: t.iso };
      }
      if (!store.parties.includes(party)) store.parties.push(party);
      store.orders.unshift({ id: crypto.randomUUID(), party, salesman: bookedBy, date: t.date, time: t.time, status: 'Pending', items, createdAt: t.iso, deliveredDate: null });
    });
    return okState(res);
  }

  const deliverMatch = p.match(/^\/api\/orders\/([^/]+)\/deliver$/);
  if (deliverMatch && m === 'PATCH') {
    if (!need(req, res, ['admin'])) return;
    const id = deliverMatch[1];
    await updateStore((store) => {
      const order = store.orders.find((o) => o.id === id);
      if (!order) throw new Error('Order not found');
      if (status(order.status) === 'Delivered') return;
      for (const item of order.items || []) {
        if (!store.products[item.product]) store.products[item.product] = { name: item.product, location: 'MAIN', available: 0, lastStatus: '', updatedAt: today().iso };
        store.products[item.product].available = Math.max(0, Number(store.products[item.product].available || 0) - Number(item.qty || 0));
        store.products[item.product].lastStatus = 'Delivered outward';
        store.products[item.product].updatedAt = today().iso;
      }
      order.status = 'Delivered';
      const deliveredNow = today();
      order.deliveredDate = deliveredNow.date;
      order.deliveredAt = deliveredNow.iso;
    });
    return okState(res);
  }
  const orderMatch = p.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && m === 'DELETE') {
    if (!need(req, res, ['admin'])) return;
    const id = orderMatch[1];
    await updateStore((store) => { store.orders = store.orders.filter((o) => o.id !== id); });
    return okState(res);
  }

  if (m === 'GET' && p === '/api/export') {
    if (!need(req, res, ['admin'])) return;
    return json(res, 200, { store: await loadStore() });
  }
  if (m === 'POST' && p === '/api/import') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    await updateStore((store) => {
      const imported = normalizeStore(b.store || b.data || b);
      store.products = imported.products;
      store.parties = imported.parties;
      store.orders = imported.orders;
      store.salesmen = imported.salesmen;
      store.meta = Object.assign({}, store.meta || {}, { importedAt: today().iso });
    });
    return okState(res);
  }
  if (m === 'POST' && p === '/api/reset') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    if (b.confirm !== 'DELETE') return bad(res, 'Confirmation required');
    await updateStore((store) => {
      const clean = emptyStore();
      store.products = clean.products;
      store.parties = clean.parties;
      store.orders = clean.orders;
      store.salesmen = clean.salesmen;
      store.meta = Object.assign({}, clean.meta, { resetAt: today().iso });
    });
    return okState(res);
  }

  return notFound(res);
}

function openEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const client = res;
  sseClients.add(client);
  currentState().then((state) => sendEvent(client, state)).catch(() => {});
  const keep = setInterval(() => { try { client.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(keep); sseClients.delete(client); });
}
function sendEvent(client, state) {
  client.write('event: state\n');
  client.write('data: ' + JSON.stringify(state) + '\n\n');
}
async function broadcastState() {
  if (!sseClients.size) return;
  const state = await currentState();
  for (const client of sseClients) {
    try { sendEvent(client, state); } catch (_) { sseClients.delete(client); }
  }
}

async function staticFile(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/salesman') p = '/salesman.html';
  const clean = path.normalize(p).replace(/^\.+[\\/]/, '');
  const full = path.join(PUBLIC_DIR, clean);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const stat = await fsp.stat(full);
    if (!stat.isFile()) throw new Error('not file');
    const ext = path.extname(full).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ['.html','.js','.css'].includes(ext) || p.endsWith('service-worker.js') ? 'no-store' : 'public, max-age=3600' });
    fs.createReadStream(full).pipe(res);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await staticFile(req, res, url);
  } catch (err) {
    json(res, 500, { error: err.message || 'Server error' });
  }
});

ensureStore().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Niharo WMS Pro running');
    console.log('Dashboard: http://localhost:' + PORT + '/');
    console.log('Salesman web: http://localhost:' + PORT + '/salesman');
    if (APP_SECRET.includes('change-this')) console.log('Warning: set APP_SECRET in .env before public hosting.');
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
