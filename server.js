'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
let XLSX = null;
try { XLSX = require('xlsx'); } catch (_) { XLSX = null; }
let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) { Pool = null; }

loadEnv();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';
const APP_SECRET = process.env.APP_SECRET || 'change-this-niharo-secret';
const DB_FILE = path.resolve(ROOT, process.env.DB_FILE || './data/store.json');

// Database configuration
// Preferred for Railway + Supabase: use separate PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
// because a single DATABASE_URL is easy to paste incorrectly and special characters can break the URL.
const PGHOST = String(process.env.PGHOST || '').trim();
const PGPORT = Number(process.env.PGPORT || 5432);
const PGDATABASE = String(process.env.PGDATABASE || 'postgres').trim();
const PGUSER = String(process.env.PGUSER || '').trim();
const PGPASSWORD = String(process.env.PGPASSWORD || '').trim();
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const USE_PG_FIELDS = !!(PGHOST && PGUSER && PGPASSWORD);
const USE_POSTGRES_CONFIGURED = USE_PG_FIELDS || !!DATABASE_URL;
const STORE_KEY = 'main';
const pgPool = USE_POSTGRES_CONFIGURED && Pool ? new Pool(getPgConfig()) : null;
let postgresReady = false;
let postgresInitAttempted = false;
let postgresInitError = null;

function getPgConfig() {
  if (USE_PG_FIELDS) {
    return {
      host: PGHOST,
      port: PGPORT,
      database: PGDATABASE || 'postgres',
      user: PGUSER,
      password: PGPASSWORD,
      ssl: { rejectUnauthorized: false }
    };
  }
  return { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } };
}

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
    vardana: { materials: {}, recipes: {}, productions: [] },
    stockLedger: [],
    adminUsers: {},
    rolePermissions: defaultRolePermissions(),
    meta: { app: 'Niharo WMS Pro', version: '2.0.0' }
  };
}

function productName(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
}
function productUnit(value) {
  const u = String(value || 'PCS').trim().toUpperCase();
  if (u === 'LTR') return 'LITER';
  return ['PCS', 'KG', 'BOX', 'BAG', 'LITER', 'CARTON'].includes(u) ? u : 'PCS';
}
function vardanaUnit(value) {
  const u = String(value || 'PCS').trim().toUpperCase();
  if (u === 'LTR') return 'LITER';
  return ['PCS', 'KG', 'BOX', 'BAG', 'LITER', 'CARTON', 'ROLL', 'BUNDLE'].includes(u) ? u : 'PCS';
}

const PERMISSION_MODULES = ['dashboard','inventory','vardana','orders','masters','targets','reports','settings','admin'];
const PERMISSION_ACTIONS = ['view','edit','delete','export'];
const ROLE_LABELS = ['Owner','Warehouse','Sales Manager','Accounts','Viewer'];
function permissionSet(actions) {
  const out = {};
  for (const m of PERMISSION_MODULES) {
    out[m] = {};
    for (const a of PERMISSION_ACTIONS) out[m][a] = !!(actions[m] && actions[m].includes(a));
  }
  return out;
}
function defaultRolePermissions() {
  const all = {};
  for (const m of PERMISSION_MODULES) all[m] = ['view','edit','delete','export'];
  return {
    Owner: permissionSet(all),
    Warehouse: permissionSet({ dashboard:['view'], inventory:['view','edit','export'], vardana:['view','edit'], orders:['view','edit'], masters:['view'], targets:['view'], reports:['view'] }),
    'Sales Manager': permissionSet({ dashboard:['view'], inventory:['view'], orders:['view','edit'], masters:['view','edit'], targets:['view','edit'], reports:['view','export'] }),
    Accounts: permissionSet({ dashboard:['view'], orders:['view'], reports:['view','export'] }),
    Viewer: permissionSet({ dashboard:['view'], inventory:['view'], orders:['view'], reports:['view'] })
  };
}
function normalizeRoleName(value) {
  const v = String(value || '').trim();
  return ROLE_LABELS.find(r => r.toLowerCase() === v.toLowerCase()) || 'Viewer';
}
function normalizeRolePermissions(input) {
  const base = defaultRolePermissions();
  input = input && typeof input === 'object' ? input : {};
  for (const [role, perms] of Object.entries(input)) {
    const roleName = normalizeRoleName(role);
    if (roleName === 'Owner') continue;
    if (!base[roleName]) base[roleName] = permissionSet({});
    if (perms && typeof perms === 'object') {
      for (const m of PERMISSION_MODULES) {
        if (!base[roleName][m]) base[roleName][m] = {};
        const row = perms[m] || {};
        for (const a of PERMISSION_ACTIONS) base[roleName][m][a] = !!row[a];
      }
    }
  }
  return base;
}
function normalizeAdminUsers(input) {
  const out = {};
  input = input && typeof input === 'object' ? input : {};
  for (const [rawUser, raw] of Object.entries(input)) {
    const u = username(raw && typeof raw === 'object' ? (raw.username || rawUser) : rawUser);
    if (!u) continue;
    const item = raw && typeof raw === 'object' ? raw : {};
    if (u === username(ADMIN_USER)) continue;
    out[u] = {
      username: u,
      name: String(item.name || u).trim() || u,
      passwordHash: item.passwordHash || (item.password ? hashPassword(String(item.password)) : ''),
      role: normalizeRoleName(item.role || 'Viewer'),
      active: item.active !== false,
      createdAt: item.createdAt || today().iso,
      updatedAt: item.updatedAt || null
    };
  }
  return out;
}
function sanitizeAdminUsers(input) {
  return Object.keys(input || {}).sort().map(u => ({
    username: u,
    name: (input[u] && input[u].name) || u,
    role: normalizeRoleName(input[u] && input[u].role),
    active: !input[u] || input[u].active !== false,
    createdAt: input[u] && input[u].createdAt || null,
    updatedAt: input[u] && input[u].updatedAt || null
  }));
}
function rolePermissionsFor(role, store) {
  const perms = normalizeRolePermissions((store && store.rolePermissions) || {});
  const roleName = normalizeRoleName(role || 'Viewer');
  return perms[roleName] || perms.Viewer;
}
function userCan(a, module, action, store) {
  if (!a || a.role !== 'admin') return false;
  const roleName = normalizeRoleName(a.adminRole || (a.user && username(a.user) === username(ADMIN_USER) ? 'Owner' : 'Viewer'));
  if (roleName === 'Owner') return true;
  const perms = rolePermissionsFor(roleName, store);
  return !!(perms[module] && perms[module][action || 'view']);
}
function anyViewPermission(a, store) {
  return PERMISSION_MODULES.some(m => userCan(a, m, 'view', store));
}
function routePermission(pathname, method) {
  const p = pathname;
  const m = method;
  if (p === '/api/events') return ['dashboard','view'];
  if (p === '/api/db-check') return ['settings','view'];
  if (p === '/api/export') return ['settings','export'];
  if (p === '/api/import') return ['settings','edit'];
  if (p === '/api/reset') return ['settings','delete'];
  if (p.startsWith('/api/admin/')) return ['admin', m === 'GET' ? 'view' : (m === 'DELETE' ? 'delete' : 'edit')];
  if (p.startsWith('/api/products')) return ['inventory', m === 'DELETE' ? 'delete' : (m === 'GET' ? 'view' : 'edit')];
  if (p.startsWith('/api/vardana')) return ['vardana', (m === 'GET') ? 'view' : (m === 'DELETE' ? 'delete' : 'edit')];
  if (p.startsWith('/api/parties') || p.startsWith('/api/salesmen')) return ['masters', (m === 'GET') ? 'view' : (m === 'DELETE' ? 'delete' : 'edit')];
  if (p.includes('/targets')) return ['targets', m === 'GET' ? 'view' : (m === 'DELETE' ? 'delete' : 'edit')];
  if (p.startsWith('/api/orders')) {
    if (m === 'DELETE') return ['orders','delete'];
    if (m === 'PATCH' || m === 'PUT') return ['orders','edit'];
    return null; // order entry is also used by salesman app
  }
  return null;
}
async function requireRoutePermission(req, res, pathname, method) {
  const rule = routePermission(pathname, method);
  if (!rule) return true;
  const a = auth(req);
  if (!a || a.role !== 'admin') { json(res, 401, { error: 'Warehouse login required' }); return false; }
  const store = await loadStore();
  if (!userCan(a, rule[0], rule[1], store)) { json(res, 403, { error: 'Permission denied for this action' }); return false; }
  return true;
}

function normalizeVardana(input) {
  input = input && typeof input === 'object' ? input : {};
  const out = { materials: {}, recipes: {}, productions: [] };
  const materials = input.materials && typeof input.materials === 'object' ? input.materials : {};
  for (const [rawName, raw] of Object.entries(materials)) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const name = productName(item.name || rawName);
    if (!name) continue;
    out.materials[name] = {
      name,
      unit: vardanaUnit(item.unit || 'PCS'),
      available: Math.max(0, Number(item.available || item.stock || 0)),
      lowStock: Math.max(0, Number(item.lowStock || item.low || 0)),
      updatedAt: item.updatedAt || today().iso
    };
  }
  const recipes = input.recipes && typeof input.recipes === 'object' ? input.recipes : {};
  for (const [rawProduct, raw] of Object.entries(recipes)) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const product = productName(r.product || rawProduct);
    if (!product) continue;
    const outputQty = Math.max(0.01, Number(r.outputQty || 1));
    const mats = Array.isArray(r.materials) ? r.materials.map(x => ({ material: productName(x.material || x.name), qty: Math.max(0, Number(x.qty || x.quantity || 0)) })).filter(x => x.material && x.qty > 0) : [];
    out.recipes[product] = { product, outputQty, materials: mats, updatedAt: r.updatedAt || today().iso };
  }
  out.productions = Array.isArray(input.productions) ? input.productions.map(h => ({
    id: String(h.id || crypto.randomUUID()),
    product: productName(h.product),
    qty: Math.max(0, Number(h.qty || 0)),
    date: String(h.date || today().date),
    time: String(h.time || today().time),
    createdAt: h.createdAt || today().iso,
    consumed: Array.isArray(h.consumed) ? h.consumed.map(x => ({ material: productName(x.material), qty: Math.max(0, Number(x.qty || 0)), unit: vardanaUnit(x.unit || 'PCS') })).filter(x => x.material && x.qty > 0) : [],
    reversed: !!h.reversed,
    reversedAt: h.reversedAt || null
  })).filter(h => h.product && h.qty > 0) : [];
  return out;
}

function normalizeStockLedger(input) {
  if (!Array.isArray(input)) return [];
  return input.map(row => {
    const r = row && typeof row === 'object' ? row : {};
    const product = productName(r.product || r.name);
    if (!product) return null;
    return {
      id: String(r.id || crypto.randomUUID()),
      product,
      type: String(r.type || r.action || 'ADJUST').trim().toUpperCase(),
      qty: Number(r.qty || r.change || 0),
      unit: productUnit(r.unit || 'PCS'),
      opening: Number(r.opening || r.openingBalance || 0),
      closing: Number(r.closing || r.closingBalance || 0),
      date: String(r.date || today().date).slice(0, 10),
      time: String(r.time || today().time).slice(0, 5),
      createdAt: r.createdAt || today().iso,
      note: String(r.note || ''),
      refId: r.refId || null
    };
  }).filter(Boolean).slice(0, 10000);
}

function addStockLedger(store, product, type, qtyChange, opening, closing, note, refId) {
  const name = productName(product);
  if (!name) return;
  if (!Array.isArray(store.stockLedger)) store.stockLedger = [];
  const t = today();
  const unit = productUnit((store.products && store.products[name] && store.products[name].unit) || 'PCS');
  store.stockLedger.unshift({
    id: crypto.randomUUID(),
    product: name,
    type: String(type || 'ADJUST').toUpperCase(),
    qty: Number(qtyChange || 0),
    unit,
    opening: Number(opening || 0),
    closing: Number(closing || 0),
    date: t.date,
    time: t.time,
    createdAt: t.iso,
    note: String(note || ''),
    refId: refId || null
  });
  if (store.stockLedger.length > 10000) store.stockLedger = store.stockLedger.slice(0, 10000);
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
        unit: productUnit(item.unit || item.Unit || item.uom || item.UOM || item.measure || item.Measure),
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

  out.vardana = normalizeVardana(input.vardana || {});
  out.stockLedger = normalizeStockLedger(input.stockLedger || input.inventoryLedger || []);
  out.adminUsers = normalizeAdminUsers(input.adminUsers || {});
  out.rolePermissions = normalizeRolePermissions(input.rolePermissions || {});

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
    deliveredAt: order.deliveredAt || null,
    priority: ['High','Normal','Low','Hold'].includes(String(order.priority || 'Normal')) ? String(order.priority || 'Normal') : 'Normal'
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

function usingPostgres() {
  return !!(USE_POSTGRES_CONFIGURED && pgPool && postgresReady);
}

function safePgError(err) {
  if (!err) return null;
  return {
    message: err.message || 'Postgres connection failed',
    code: err.code || null,
    severity: err.severity || null
  };
}

function pgStatus() {
  return {
    configured: !!USE_POSTGRES_CONFIGURED,
    ready: usingPostgres(),
    host: PGHOST || (DATABASE_URL ? 'DATABASE_URL' : ''),
    port: USE_PG_FIELDS ? PGPORT : null,
    database: USE_PG_FIELDS ? (PGDATABASE || 'postgres') : null,
    user: USE_PG_FIELDS ? PGUSER : null,
    hasPassword: USE_PG_FIELDS ? !!PGPASSWORD : null,
    hasDatabaseUrl: !!DATABASE_URL,
    attempted: postgresInitAttempted,
    error: postgresInitError
  };
}

async function ensureJsonStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) await fsp.writeFile(DB_FILE, JSON.stringify(emptyStore(), null, 2));
}

async function initPostgres(force) {
  if (!USE_POSTGRES_CONFIGURED) return false;
  if (!pgPool) {
    postgresInitAttempted = true;
    postgresReady = false;
    postgresInitError = { message: 'pg package install nahi hua. package.json update karke redeploy karein.', code: 'PG_PACKAGE_MISSING', severity: 'FATAL' };
    return false;
  }
  if (postgresReady && !force) return true;
  postgresInitAttempted = true;
  try {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS niharo_store (
      key text PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = await pgPool.query('SELECT data FROM niharo_store WHERE key = $1', [STORE_KEY]);
    if (!existing.rows.length) {
      let initial = emptyStore();
      try {
        if (fs.existsSync(DB_FILE)) {
          const raw = await fsp.readFile(DB_FILE, 'utf8');
          initial = normalizeStore(JSON.parse(raw || '{}'));
        }
      } catch (_) {}
      await pgPool.query(
        'INSERT INTO niharo_store(key, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO NOTHING',
        [STORE_KEY, JSON.stringify(initial)]
      );
    }
    postgresReady = true;
    postgresInitError = null;
    return true;
  } catch (err) {
    postgresReady = false;
    postgresInitError = safePgError(err);
    console.error('Postgres unavailable; app is running in JSON fallback mode:', postgresInitError);
    return false;
  }
}

async function ensureStore() {
  if (USE_POSTGRES_CONFIGURED) await initPostgres(false);
  if (!usingPostgres()) await ensureJsonStore();
}
async function loadStore() {
  await ensureStore();
  if (storeCache) return storeCache;
  if (usingPostgres()) {
    const result = await pgPool.query('SELECT data FROM niharo_store WHERE key = $1', [STORE_KEY]);
    storeCache = normalizeStore((result.rows[0] && result.rows[0].data) || {});
    return storeCache;
  }
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
  store.meta = Object.assign({}, store.meta || {}, { savedAt: today().iso, storage: usingPostgres() ? 'postgres' : 'json' });
  if (usingPostgres()) {
    await pgPool.query(
      'INSERT INTO niharo_store(key, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      [STORE_KEY, JSON.stringify(store)]
    );
    return;
  }
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
    vardana: normalizeVardana(store.vardana || {}),
    stockLedger: normalizeStockLedger(store.stockLedger || []),
    adminUsers: sanitizeAdminUsers(store.adminUsers || {}),
    rolePermissions: normalizeRolePermissions(store.rolePermissions || {}),
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
function parseCookies(req) {
  const header = String((req && req.headers && req.headers.cookie) || '');
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}
function authCookie(token) {
  return `niharo_admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
}
function clearAuthCookie() {
  return 'niharo_admin_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
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
function makeToken(role, user, extra) {
  return tokenSign(Object.assign({ role, user, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 }, extra || {}));
}
function auth(req) {
  const header = req.headers.authorization || '';
  let token = '';
  if (header.startsWith('Bearer ')) token = header.slice(7);
  if (!token) token = parseCookies(req).niharo_admin_token || '';
  return tokenVerify(token);
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
function jsonHeaders(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
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
    out.push({ name: first, location: r[1] || 'MAIN', available: r[2] || 0, unit: r[3] || 'PCS' });
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

  if (m === 'GET' && p === '/api/health') return json(res, 200, {
    ok: true,
    app: 'Niharo WMS Pro',
    storage: usingPostgres() ? 'postgres' : (USE_POSTGRES_CONFIGURED ? 'json-fallback' : 'json'),
    time: new Date().toISOString()
  });
  if (m === 'GET' && p === '/api/db-check') {
    if (!need(req, res, ['admin'])) return;
    const ok = await initPostgres(true);
    if (ok) storeCache = null;
    return json(res, ok ? 200 : 500, {
      ok,
      storage: usingPostgres() ? 'postgres' : (USE_POSTGRES_CONFIGURED ? 'json-fallback' : 'json'),
      postgres: pgStatus(),
      time: new Date().toISOString()
    });
  }
  if (m === 'GET' && p === '/api/state') {
    const a = need(req, res, ['admin', 'salesman']);
    if (!a) return;
    if (a.role === 'admin') {
      const store = await loadStore();
      if (!anyViewPermission(a, store)) return json(res, 403, { error: 'No view permission' });
      return json(res, 200, { state: sanitize(store), viewer: { username: a.user, adminRole: normalizeRoleName(a.adminRole || 'Viewer'), permissions: rolePermissionsFor(a.adminRole || 'Viewer', store) } });
    }
    return json(res, 200, { state: await currentState() });
  }
  if (m === 'GET' && p === '/api/events') {
    if (!await requireRoutePermission(req, res, p, m)) return;
    return openEvents(req, res);
  }

  if (m === 'POST' && p === '/api/admin/login') {
    const b = await body(req);
    const inputUser = String(b.user || b.username || '').trim();
    const inputKey = username(inputUser);
    const pass = String(b.password || '');
    const store = await loadStore();
    if (inputKey === username(ADMIN_USER) && pass === ADMIN_PASSWORD) {
      const permissions = rolePermissionsFor('Owner', store);
      const token = makeToken('admin', ADMIN_USER, { adminRole: 'Owner' });
      return jsonHeaders(res, 200, { token, user: { username: ADMIN_USER, role: 'admin', adminRole: 'Owner', permissions } }, { 'Set-Cookie': authCookie(token) });
    }
    const account = (store.adminUsers || {})[inputKey];
    if (!account || account.active === false || !verifyPassword(pass, account.passwordHash)) {
      return json(res, 403, { error: 'Wrong user ID or password' });
    }
    const roleName = normalizeRoleName(account.role || 'Viewer');
    const permissions = rolePermissionsFor(roleName, store);
    const token = makeToken('admin', inputKey, { adminRole: roleName });
    return jsonHeaders(res, 200, { token, user: { username: inputKey, name: account.name || inputKey, role: 'admin', adminRole: roleName, permissions } }, { 'Set-Cookie': authCookie(token) });
  }

  if (m === 'POST' && p === '/api/admin/logout') {
    return jsonHeaders(res, 200, { ok: true }, { 'Set-Cookie': clearAuthCookie() });
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

  if (!await requireRoutePermission(req, res, p, m)) return;

  if (m === 'GET' && p === '/api/admin/users') {
    const store = await loadStore();
    return json(res, 200, { ok: true, users: sanitizeAdminUsers(store.adminUsers || {}), rolePermissions: normalizeRolePermissions(store.rolePermissions || {}) });
  }
  if (m === 'POST' && p === '/api/admin/users') {
    const a = need(req, res, ['admin']); if (!a) return;
    if (normalizeRoleName(a.adminRole) !== 'Owner') return json(res, 403, { error: 'Only Owner can manage admin users' });
    const b = await body(req);
    const u = username(b.username);
    if (!u || u === username(ADMIN_USER)) return bad(res, 'Valid user ID required');
    if (!b.password && !(await loadStore()).adminUsers?.[u]) return bad(res, 'Password required for new user');
    await updateStore((store) => {
      if (!store.adminUsers) store.adminUsers = {};
      const old = store.adminUsers[u] || {};
      store.adminUsers[u] = {
        username: u,
        name: String(b.name || old.name || u).trim() || u,
        passwordHash: b.password ? hashPassword(String(b.password)) : old.passwordHash,
        role: normalizeRoleName(b.role || old.role || 'Viewer'),
        active: b.active !== false,
        createdAt: old.createdAt || today().iso,
        updatedAt: today().iso
      };
    });
    return okState(res);
  }
  const adminUserMatch = p.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && m === 'DELETE') {
    const a = need(req, res, ['admin']); if (!a) return;
    if (normalizeRoleName(a.adminRole) !== 'Owner') return json(res, 403, { error: 'Only Owner can delete admin users' });
    const u = username(adminUserMatch[1]);
    await updateStore((store) => { if (store.adminUsers) delete store.adminUsers[u]; });
    return okState(res);
  }
  if (m === 'POST' && p === '/api/admin/roles') {
    const a = need(req, res, ['admin']); if (!a) return;
    if (normalizeRoleName(a.adminRole) !== 'Owner') return json(res, 403, { error: 'Only Owner can change permissions' });
    const b = await body(req);
    await updateStore((store) => { store.rolePermissions = normalizeRolePermissions(b.rolePermissions || b.permissions || {}); });
    return okState(res);
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
      if (!store.products[name]) store.products[name] = { name, location, unit: 'PCS', available: 0, lastStatus: '', updatedAt: today().iso };
      store.products[name].location = location;
      const opening = Number(store.products[name].available || 0);
      let closing = opening;
      if (type === 'OUT') {
        closing = Math.max(0, opening - qty);
        store.products[name].available = closing;
        store.products[name].lastStatus = '-' + qty + ' Out';
        addStockLedger(store, name, 'OUT', -(opening - closing), opening, closing, 'Manual stock out');
      } else {
        closing = Math.max(0, opening + qty);
        store.products[name].available = closing;
        store.products[name].lastStatus = '+' + qty + ' In';
        addStockLedger(store, name, 'IN', closing - opening, opening, closing, 'Manual stock in');
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
        const unit = productUnit(raw.unit || raw.Unit || raw.UOM || raw['Unit'] || raw['UOM'] || (store.products[name] && store.products[name].unit) || 'PCS');
        const opening = Number(store.products[name] && store.products[name].available || 0);
        store.products[name] = { name, location, unit, available, lastStatus: 'Imported from Excel', updatedAt: today().iso };
        if (opening !== available) addStockLedger(store, name, 'IMPORT', available - opening, opening, available, 'Product Excel import');
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
        const unit = productUnit(raw.unit || raw.Unit || raw.UOM || raw['Unit'] || raw['UOM'] || (store.products[name] && store.products[name].unit) || 'PCS');
        const opening = Number(store.products[name] && store.products[name].available || 0);
        store.products[name] = {
          name,
          location,
          unit,
          available,
          lastStatus: 'Imported from Excel',
          updatedAt: today().iso
        };
        if (opening !== available) addStockLedger(store, name, 'IMPORT', available - opening, opening, available, 'Product bulk import');
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
        const opening = Number(store.products[name].available || 0);
        store.products[name].location = productName(b.location || 'MAIN') || 'MAIN';
        store.products[name].unit = productUnit(b.unit || store.products[name].unit || 'PCS');
        const closing = Math.max(0, Number(b.available ?? 0));
        store.products[name].available = closing;
        store.products[name].lastStatus = 'Manual edit';
        store.products[name].updatedAt = today().iso;
        if (opening !== closing) addStockLedger(store, name, 'EDIT', closing - opening, opening, closing, 'Manual product edit');
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
    const rawKey = String(b.key || '').trim();
    const key = productName(rawKey);
    const qty = Math.max(0, Number(b.qty || 0));
    const incentive = Math.max(0, Number(b.incentive || 0));
    const deadline = String(b.deadline || '').trim();
    if (!u || !rawKey || !['category','product'].includes(type)) return bad(res, 'Salesman, target type and key required');
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
        const targetBucket = store.salesmen[u].targets[bucket];
        delete targetBucket[rawKey];
        delete targetBucket[key];
        for (const existingKey of Object.keys(targetBucket)) {
          const meta = targetBucket[existingKey] || {};
          if (existingKey === rawKey || productName(existingKey) === key || String(meta.id || '') === rawKey || productName(meta.key || '') === key) {
            delete targetBucket[existingKey];
          }
        }
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


  if (m === 'POST' && p === '/api/vardana/materials') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    const name = productName(b.name);
    if (!name) return bad(res, 'Material name required');
    await updateStore((store) => {
      if (!store.vardana) store.vardana = { materials: {}, recipes: {}, productions: [] };
      if (!store.vardana.materials) store.vardana.materials = {};
      store.vardana.materials[name] = { name, unit: vardanaUnit(b.unit || 'PCS'), available: Math.max(0, Number(b.available || 0)), lowStock: Math.max(0, Number(b.lowStock || 0)), updatedAt: today().iso };
    });
    return okState(res);
  }

  const vardanaMaterialMatch = p.match(/^\/api\/vardana\/materials\/(.+)$/);
  if (vardanaMaterialMatch) {
    if (!need(req, res, ['admin'])) return;
    const name = productName(vardanaMaterialMatch[1]);
    if (m === 'PUT') {
      const b = await body(req);
      await updateStore((store) => {
        if (!store.vardana) store.vardana = { materials: {}, recipes: {}, productions: [] };
        const existing = store.vardana.materials[name];
        if (!existing) throw new Error('Material not found');
        existing.unit = vardanaUnit(b.unit || existing.unit || 'PCS');
        existing.available = Math.max(0, Number(b.available ?? existing.available ?? 0));
        existing.lowStock = Math.max(0, Number(b.lowStock ?? existing.lowStock ?? 0));
        existing.updatedAt = today().iso;
      });
      return okState(res);
    }
    if (m === 'DELETE') {
      await updateStore((store) => {
        if (!store.vardana) store.vardana = { materials: {}, recipes: {}, productions: [] };
        delete store.vardana.materials[name];
        for (const recipe of Object.values(store.vardana.recipes || {})) recipe.materials = (recipe.materials || []).filter(x => productName(x.material) !== name);
      });
      return okState(res);
    }
  }

  if (m === 'POST' && p === '/api/vardana/recipes') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    const product = productName(b.product);
    const outputQty = Math.max(0.01, Number(b.outputQty || 1));
    const materials = Array.isArray(b.materials) ? b.materials.map(x => ({ material: productName(x.material), qty: Math.max(0, Number(x.qty || 0)) })).filter(x => x.material && x.qty > 0) : [];
    if (!product || !materials.length) return bad(res, 'Product aur material lines required');
    await updateStore((store) => {
      if (!store.vardana) store.vardana = { materials: {}, recipes: {}, productions: [] };
      if (!store.vardana.recipes) store.vardana.recipes = {};
      if (!store.vardana.materials) store.vardana.materials = {};
      for (const m of materials) if (!store.vardana.materials[m.material]) store.vardana.materials[m.material] = { name: m.material, unit: 'PCS', available: 0, lowStock: 0, updatedAt: today().iso };
      store.vardana.recipes[product] = { product, outputQty, materials, updatedAt: today().iso };
    });
    return okState(res);
  }

  const vardanaRecipeMatch = p.match(/^\/api\/vardana\/recipes\/(.+)$/);
  if (vardanaRecipeMatch && m === 'DELETE') {
    if (!need(req, res, ['admin'])) return;
    const product = productName(vardanaRecipeMatch[1]);
    await updateStore((store) => { if (store.vardana && store.vardana.recipes) delete store.vardana.recipes[product]; });
    return okState(res);
  }

  if (m === 'POST' && p === '/api/vardana/production') {
    if (!need(req, res, ['admin'])) return;
    const b = await body(req);
    const product = productName(b.product);
    const qtyMade = Math.max(0, Number(b.qty || 0));
    if (!product || qtyMade <= 0) return bad(res, 'Product aur quantity required');
    await updateStore((store) => {
      if (!store.vardana) store.vardana = { materials: {}, recipes: {}, productions: [] };
      const recipe = store.vardana.recipes && store.vardana.recipes[product];
      if (!recipe || !(recipe.materials || []).length) throw new Error('Is product ki recipe pehle save karein');
      const factor = qtyMade / Math.max(0.01, Number(recipe.outputQty || 1));
      const consumed = (recipe.materials || []).map(x => {
        const material = productName(x.material);
        const mat = store.vardana.materials && store.vardana.materials[material];
        const needQty = Number(x.qty || 0) * factor;
        const have = Number(mat && mat.available || 0);
        if (have < needQty) throw new Error(`${material} short hai. Need ${needQty}, available ${have}`);
        return { material, qty: needQty, unit: vardanaUnit(mat.unit || 'PCS') };
      });
      const t = today();
      for (const c of consumed) {
        store.vardana.materials[c.material].available = Math.max(0, Number(store.vardana.materials[c.material].available || 0) - c.qty);
        store.vardana.materials[c.material].updatedAt = t.iso;
      }
      if (!store.products[product]) store.products[product] = { name: product, location: 'MAIN', unit: 'PCS', available: 0, lastStatus: '', updatedAt: t.iso };
      const opening = Number(store.products[product].available || 0);
      const closing = opening + qtyMade;
      store.products[product].available = closing;
      store.products[product].lastStatus = `Production +${qtyMade}`;
      store.products[product].updatedAt = t.iso;
      addStockLedger(store, product, 'PRODUCTION', qtyMade, opening, closing, 'Production stock in');
      const hist = { id: crypto.randomUUID(), product, qty: qtyMade, date: t.date, time: t.time, createdAt: t.iso, consumed, reversed: false };
      if (!Array.isArray(store.vardana.productions)) store.vardana.productions = [];
      store.vardana.productions.unshift(hist);
    });
    return okState(res);
  }

  const vardanaReverseMatch = p.match(/^\/api\/vardana\/production\/([^/]+)\/reverse$/);
  if (vardanaReverseMatch && m === 'POST') {
    if (!need(req, res, ['admin'])) return;
    const id = vardanaReverseMatch[1];
    await updateStore((store) => {
      const h = store.vardana && Array.isArray(store.vardana.productions) ? store.vardana.productions.find(x => x.id === id) : null;
      if (!h) throw new Error('Production entry not found');
      if (h.reversed) return;
      const t = today();
      if (store.products[h.product]) {
        const opening = Number(store.products[h.product].available || 0);
        const closing = Math.max(0, opening - Number(h.qty || 0));
        store.products[h.product].available = closing;
        store.products[h.product].lastStatus = `Production reverse -${h.qty}`;
        store.products[h.product].updatedAt = t.iso;
        addStockLedger(store, h.product, 'PRODUCTION_REVERSE', closing - opening, opening, closing, 'Production reverse', h.id);
      }
      for (const c of h.consumed || []) {
        const material = productName(c.material);
        if (!store.vardana.materials[material]) store.vardana.materials[material] = { name: material, unit: vardanaUnit(c.unit || 'PCS'), available: 0, lowStock: 0, updatedAt: t.iso };
        store.vardana.materials[material].available = Number(store.vardana.materials[material].available || 0) + Number(c.qty || 0);
        store.vardana.materials[material].updatedAt = t.iso;
      }
      h.reversed = true;
      h.reversedAt = t.iso;
    });
    return okState(res);
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
        if (!store.products[item.product]) store.products[item.product] = { name: item.product, location: 'MAIN', unit: 'PCS', available: 0, lastStatus: 'Auto added from order', updatedAt: t.iso };
      }
      if (!store.parties.includes(party)) store.parties.push(party);
      store.orders.unshift({ id: crypto.randomUUID(), party, salesman: bookedBy, date: t.date, time: t.time, status: 'Pending', items, priority: 'Normal', createdAt: t.iso, deliveredDate: null });
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
        if (!store.products[item.product]) store.products[item.product] = { name: item.product, location: 'MAIN', unit: 'PCS', available: 0, lastStatus: '', updatedAt: today().iso };
        const opening = Number(store.products[item.product].available || 0);
        const closing = Math.max(0, opening - Number(item.qty || 0));
        store.products[item.product].available = closing;
        store.products[item.product].lastStatus = 'Delivered outward';
        store.products[item.product].updatedAt = today().iso;
        addStockLedger(store, item.product, 'OUT', closing - opening, opening, closing, `Delivered outward - ${order.party}`, order.id);
      }
      order.status = 'Delivered';
      const deliveredNow = today();
      order.deliveredDate = deliveredNow.date;
      order.deliveredAt = deliveredNow.iso;
    });
    return okState(res);
  }
  const priorityMatch = p.match(/^\/api\/orders\/([^/]+)\/priority$/);
  if (priorityMatch && m === 'PATCH') {
    if (!need(req, res, ['admin'])) return;
    const id = priorityMatch[1];
    const b = await body(req);
    const priority = String(b.priority || 'Normal');
    if (!['High','Normal','Low','Hold'].includes(priority)) return bad(res, 'Invalid priority');
    await updateStore((store) => {
      const order = store.orders.find((o) => o.id === id);
      if (!order) throw new Error('Order not found');
      if (status(order.status) === 'Delivered') throw new Error('Delivered order priority change nahi ho sakti');
      order.priority = priority;
      order.updatedAt = today().iso;
    });
    return okState(res);
  }

  const orderMatch = p.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && m === 'PATCH') {
    const a = need(req, res, ['admin', 'salesman']);
    if (!a) return;
    const id = orderMatch[1];
    const b = await body(req);
    const party = String(b.party || '').trim();
    const items = Array.isArray(b.items) ? b.items.map(normalizeItem).filter(Boolean) : [];
    if (!party || !items.length) return bad(res, 'Party and cart items required');
    await updateStore((store) => {
      const order = store.orders.find((o) => o.id === id);
      if (!order) throw new Error('Order not found');
      if (status(order.status) === 'Delivered') throw new Error('Delivered order edit nahi ho sakta');
      if (a.role === 'salesman') {
        const me = username(a.user);
        if (!store.salesmen[me]) throw new Error('Salesman account reset/delete ho gaya. Dobara login karein.');
        if (username(order.salesman) !== me) throw new Error('Aap sirf apna order edit kar sakte hain');
      }
      const t = today();
      for (const item of items) {
        if (!store.products[item.product]) store.products[item.product] = { name: item.product, location: 'MAIN', unit: 'PCS', available: 0, lastStatus: 'Auto added from order edit', updatedAt: t.iso };
      }
      if (!store.parties.includes(party)) store.parties.push(party);
      order.party = party;
      order.items = items;
      order.updatedAt = t.iso;
    });
    return okState(res);
  }
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
      store.vardana = imported.vardana || { materials: {}, recipes: {}, productions: [] };
      store.stockLedger = imported.stockLedger || [];
      store.adminUsers = imported.adminUsers || {};
      store.rolePermissions = imported.rolePermissions || defaultRolePermissions();
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
      store.vardana = clean.vardana;
      store.stockLedger = clean.stockLedger;
      store.adminUsers = clean.adminUsers;
      store.rolePermissions = clean.rolePermissions;
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
    console.log('Storage:', usingPostgres() ? 'Supabase/PostgreSQL' : (USE_POSTGRES_CONFIGURED ? 'JSON fallback - Postgres not ready' : 'JSON file'));
    console.log('Dashboard: http://localhost:' + PORT + '/');
    console.log('Salesman web: http://localhost:' + PORT + '/salesman');
    if (APP_SECRET.includes('change-this')) console.log('Warning: set APP_SECRET in Railway Variables before public hosting.');
    if (ADMIN_PASSWORD === '1234') console.log('Warning: set ADMIN_PASSWORD in Railway Variables.');
  });
}).catch((err) => {
  console.error('Startup warning:', err);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Niharo WMS Pro running in safe JSON mode');
    console.log('Dashboard: http://localhost:' + PORT + '/');
    console.log('Salesman web: http://localhost:' + PORT + '/salesman');
  });
});
