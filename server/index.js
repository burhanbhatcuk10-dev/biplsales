process.env.TZ = process.env.TZ || 'Asia/Kolkata'; // invoice and ledger dates follow Indian time
import './env.js';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';

import { pool, tx, put, nextId, addLog, loadState, initDb } from './db.js';
import { r2, inr, today, GSTIN_RE } from '../src/lib/utils.js';
import { buildItems, totalsOf } from '../src/lib/seed.js';
import { ROLE_LABEL, PERMS, orderPaid, orderDue, outstanding } from '../src/lib/domain.js';

const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) { console.error('JWT_SECRET must be set (16+ random characters).'); process.exit(1); }
const COOKIE = 'bi_session';
const cloudOn = !!(process.env.CLOUDINARY_URL || (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET));
if (cloudOn && !process.env.CLOUDINARY_URL) {
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
} else if (cloudOn) cloudinary.config({ secure: true });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const can = (u, a) => { const p = PERMS[u.role] || []; return p.includes('*') || p.includes(a); };
const need = (u, ...actions) => { if (!actions.some(a => can(u, a))) bad('You do not have permission to do that.', 403); };
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const num = v => Number(v);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'img-src': ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'], 'script-src': ["'self'"] }
  }
}));
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());

app.get('/healthz', wrap(async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

/* ---------------- auth ---------------- */
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many failed sign-in attempts. Try again in 15 minutes.' } });
const DUMMY = bcrypt.hashSync('not-a-real-password', 10);

const setCookie = (res, u) => res.cookie(COOKIE, jwt.sign({ sub: u.id, v: u.token_version }, SECRET, { expiresIn: '12h' }), {
  httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 12 * 3600 * 1000, path: '/'
});

async function auth(req, _res, next) {
  try {
    const tok = req.cookies[COOKIE];
    if (!tok) bad('Please sign in.', 401);
    let p;
    try { p = jwt.verify(tok, SECRET); } catch (_) { bad('Session expired. Please sign in again.', 401); }
    const r = await pool.query('SELECT id,name,title,role,email,active,token_version,must_change FROM users WHERE id=$1', [p.sub]);
    const u = r.rows[0];
    if (!u || !u.active || u.token_version !== p.v) bad('Please sign in again.', 401);
    req.user = u;
    next();
  } catch (e) { next(e); }
}

const snapshot = async (c, u) => loadState(c, u);
const reply = (res, state, message, extra = {}) => res.json({ message, state, ...extra });
const read = async u => { const c = await pool.connect(); try { return await snapshot(c, u); } finally { c.release(); } };
const meOf = u => ({ id: u.id, name: u.name, title: u.title, role: u.role });
const whoOf = u => `${u.name} (${ROLE_LABEL[u.role]})`;

app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase(), password = String(req.body.password || '');
  if (!email || !password) bad('Enter your email and password.');
  const r = await pool.query('SELECT * FROM users WHERE lower(email)=$1', [email]);
  const u = r.rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY);
  if (!u || !ok) bad('Incorrect email or password.', 401);
  if (!u.active) bad('This account is disabled. Contact your administrator.', 403);
  setCookie(res, u);
  await tx(c => addLog(c, whoOf(u), 'Signed in'));
  res.json({ me: meOf(u) });
}));
app.post('/api/auth/logout', (_req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

app.use('/api', wrap(async (req, res, next) => { await auth(req, res, next); }));

app.get('/api/state', wrap(async (req, res) => { res.json({ state: await read(req.user) }); }));

app.post('/api/auth/password', wrap(async (req, res) => {
  const { current, next } = req.body;
  if (String(next || '').length < 8) bad('New password must be at least 8 characters.');
  const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(String(current || ''), r.rows[0].password_hash))) bad('Current password is incorrect.');
  const hash = await bcrypt.hash(String(next), 12);
  const u = await tx(async c => {
    const x = await c.query('UPDATE users SET password_hash=$1, must_change=false, token_version=token_version+1 WHERE id=$2 RETURNING *', [hash, req.user.id]);
    await addLog(c, whoOf(req.user), 'Changed own password');
    return x.rows[0];
  });
  setCookie(res, u); // keep this session alive; all others are signed out
  res.json({ message: 'Password changed.' });
}));

/* ---------------- orders ---------------- */
app.post('/api/orders', wrap(async (req, res) => {
  const u = req.user; need(u, 'order.create');
  const draft = req.body;
  if (!Array.isArray(draft.items) || !draft.items.length) bad('Add at least one item.');
  const out = await tx(async c => {
    const S = await snapshot(c, u);
    const cust = S.customers.find(x => x.id === draft.customerId);
    if (!cust) bad('Select a customer.');
    if (cust.onHold) bad(`${cust.name} is on credit hold. Release the hold before placing an order.`);
    const lines = draft.items.map(i => ({ pid: i.pid, qty: num(i.qty) }));
    if (lines.some(i => !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 100000)) bad('Quantities must be whole numbers of 1 or more.');
    if (lines.some(i => !S.products.find(p => p.id === i.pid))) bad('One of the products no longer exists.');
    const items = buildItems(lines.map(i => [i.pid, i.qty]), S.products);
    const t = totalsOf(items);
    const exposure = r2(outstanding(S, cust) + t.grandTotal);
    const exceeds = exposure > cust.creditLimit;
    if (exceeds && !(u.role === 'admin' && draft.override)) {
      bad(`This order takes ${cust.name} to ${inr(exposure)}, above the ${inr(cust.creditLimit)} limit.${u.role === 'admin' ? ' Tick the override to proceed.' : ' Ask an admin to approve an override.'}`);
    }
    const id = await nextId(c, 'ORD');
    await put(c, 'orders', {
      id, date: today(), customerId: cust.id, customerName: cust.name, market: cust.market, items, ...t,
      status: 'Pending Review', salesperson: u.id, creditOverride: exceeds, notes: str(draft.notes, 1000), dispatchedOn: '', deliveredOn: ''
    });
    await addLog(c, whoOf(u), `Created order ${id} for ${cust.name} (${inr(t.grandTotal)})${exceeds ? ' with credit-limit override' : ''}`);
    return { id, state: await snapshot(c, u) };
  });
  reply(res, out.state, `Order ${out.id} placed and sent for review.`);
}));

app.post('/api/orders/:id/advance', wrap(async (req, res) => {
  const u = req.user;
  const out = await tx(async c => {
    const S = await snapshot(c, u);
    const o = S.orders.find(x => x.id === req.params.id);
    if (!o) bad('Order not found.', 404);
    const cust = S.customers.find(x => x.id === o.customerId);
    let next;
    if (o.status === 'Pending Review') {
      if (u.role !== 'admin') bad('Only an admin can approve orders for packing.', 403);
      if (cust && cust.onHold) bad(`${cust.name} is on credit hold. Release the hold first.`);
      next = 'Pack Approval';
    } else if (o.status === 'Pack Approval') {
      need(u, 'order.dispatch');
      const short = o.items.filter(i => { const p = S.products.find(x => x.id === i.productId); return !p || p.stock < i.qty; });
      if (short.length) bad('Not enough stock to dispatch: ' + short.map(i => `${i.name} (need ${i.qty}, have ${(S.products.find(x => x.id === i.productId) || { stock: 0 }).stock})`).join('; '));
      next = 'Dispatched';
    } else if (o.status === 'Dispatched') {
      need(u, 'order.deliver');
      next = 'Delivered';
    } else bad('This order cannot be advanced.');
    if (next === 'Dispatched') {
      for (const i of o.items) {
        const p = S.products.find(x => x.id === i.productId);
        await put(c, 'products', { ...p, stock: p.stock - i.qty });
      }
      o.dispatchedOn = today();
    }
    if (next === 'Delivered') o.deliveredOn = today();
    o.status = next;
    await put(c, 'orders', o);
    await addLog(c, whoOf(u), `Moved order ${o.id} to ${next}`);
    return { next, state: await snapshot(c, u) };
  });
  reply(res, out.state, `Order ${req.params.id} is now ${out.next}.`);
}));

app.post('/api/orders/:id/cancel', wrap(async (req, res) => {
  const u = req.user; if (u.role !== 'admin') bad('Only an admin can cancel orders.', 403);
  const out = await tx(async c => {
    const S = await snapshot(c, u);
    const o = S.orders.find(x => x.id === req.params.id);
    if (!o) bad('Order not found.', 404);
    if (!['Pending Review', 'Pack Approval'].includes(o.status)) bad('Only orders not yet dispatched can be cancelled.');
    if (orderPaid(S, o) > 0) bad('This order has payments recorded. Move those payments to another order first.');
    o.status = 'Cancelled';
    await put(c, 'orders', o);
    await addLog(c, whoOf(u), `Cancelled order ${o.id}`);
    return snapshot(c, u);
  });
  reply(res, out, `Order ${req.params.id} cancelled.`);
}));

/* ---------------- products ---------------- */
function productFields(b) {
  const price = num(b.price), min = num(b.minStock);
  if (!str(b.name)) bad('Enter a product name.');
  if (!(price > 0)) bad('Price must be above zero.');
  if (!(min >= 0)) bad('Safety stock cannot be negative.');
  if (![0, 5, 12, 18, 28].includes(num(b.gst))) bad('Choose a valid GST rate.');
  return { name: str(b.name, 200), category: str(b.category, 60), warehouse: str(b.warehouse, 120), minStock: Math.floor(min), price: r2(price), gst: num(b.gst) };
}
app.post('/api/products', wrap(async (req, res) => {
  const u = req.user; need(u, '*');
  const f = productFields(req.body);
  const out = await tx(async c => {
    const p = { id: await nextId(c, 'P'), ...f, stock: Math.max(0, Math.floor(num(req.body.stock) || 0)), image: '', imageId: '' };
    await put(c, 'products', p);
    await addLog(c, whoOf(u), `Added product ${p.id} ${p.name}`);
    return { p, state: await snapshot(c, u) };
  });
  reply(res, out.state, `${out.p.name} added.`, { id: out.p.id });
}));
app.put('/api/products/:id', wrap(async (req, res) => {
  const u = req.user; need(u, '*');
  const f = productFields(req.body);
  const state = await tx(async c => {
    const r = await c.query('SELECT data FROM products WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) bad('Product not found.', 404);
    await put(c, 'products', { ...r.rows[0].data, ...f });
    await addLog(c, whoOf(u), `Edited product ${req.params.id}`);
    return snapshot(c, u);
  });
  reply(res, state, `${req.params.id} updated.`);
}));
app.post('/api/products/:id/stock', wrap(async (req, res) => {
  const u = req.user; need(u, 'stock.adjust');
  const q = Math.floor(num(req.body.qty)), kind = req.body.kind;
  if (!(q >= 0)) bad('Quantity must be zero or more.');
  if (!['in', 'out', 'set'].includes(kind)) bad('Choose a movement type.');
  if (!str(req.body.reason)) bad('Enter a reason.');
  const out = await tx(async c => {
    const r = await c.query('SELECT data FROM products WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) bad('Product not found.', 404);
    const p = r.rows[0].data;
    if (kind === 'out' && q > p.stock) bad(`Only ${p.stock} units are in stock.`);
    const after = kind === 'in' ? p.stock + q : kind === 'out' ? p.stock - q : q;
    await put(c, 'products', { ...p, stock: after });
    await addLog(c, whoOf(u), `Stock ${p.id}: ${p.stock} → ${after} (${str(req.body.reason, 200)})`);
    return { after, state: await snapshot(c, u) };
  });
  reply(res, out.state, `${req.params.id} stock is now ${out.after}.`);
}));

// Image arrives as a data URL (the browser downsizes it first), goes to Cloudinary, and only the URL is stored.
app.post('/api/products/:id/image', wrap(async (req, res) => {
  const u = req.user; need(u, '*');
  if (!cloudOn) bad('Image storage is not configured. Set the Cloudinary environment variables.', 503);
  const data = String(req.body.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(data)) bad('Upload a JPG, PNG or WebP image.');
  if (data.length > 7 * 1024 * 1024) bad('Image is too large.', 413);
  const state = await tx(async c => {
    const r = await c.query('SELECT data FROM products WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) bad('Product not found.', 404);
    const p = r.rows[0].data;
    let up;
    try {
      up = await cloudinary.uploader.upload(data, { folder: 'banday-impex/products', resource_type: 'image' });
    } catch (e) { bad('Image upload failed: ' + (e.message || 'Cloudinary error'), 502); }
    if (p.imageId) cloudinary.uploader.destroy(p.imageId).catch(() => {});
    await put(c, 'products', { ...p, image: up.secure_url, imageId: up.public_id });
    await addLog(c, whoOf(u), `Updated image for ${p.id}`);
    return snapshot(c, u);
  });
  reply(res, state, 'Product image saved.');
}));
app.delete('/api/products/:id/image', wrap(async (req, res) => {
  const u = req.user; need(u, '*');
  const state = await tx(async c => {
    const r = await c.query('SELECT data FROM products WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) bad('Product not found.', 404);
    const p = r.rows[0].data;
    if (p.imageId && cloudOn) cloudinary.uploader.destroy(p.imageId).catch(() => {});
    await put(c, 'products', { ...p, image: '', imageId: '' });
    await addLog(c, whoOf(u), `Removed image for ${p.id}`);
    return snapshot(c, u);
  });
  reply(res, state, 'Image removed.');
}));

/* ---------------- customers & leads ---------------- */
app.post('/api/customers', wrap(async (req, res) => saveCustomer(req, res, null)));
app.put('/api/customers/:id', wrap(async (req, res) => saveCustomer(req, res, req.params.id)));
async function saveCustomer(req, res, editId) {
  const u = req.user; need(u, 'customer.add');
  const b = req.body, admin = u.role === 'admin';
  const g = str(b.gstin, 15).toUpperCase();
  if (!str(b.name)) bad('Enter the customer name.');
  if (g && !GSTIN_RE.test(g)) bad('GSTIN format is invalid. It must be 15 characters, e.g. 01AABCR1234F1Z5.');
  if (!['Wholesale', 'Retail'].includes(b.type)) bad('Choose a customer type.');
  const out = await tx(async c => {
    const S = await snapshot(c, u);
    if (g && S.customers.some(x => x.gstin === g && x.id !== editId)) bad('Another customer already uses this GSTIN.');
    const base = { name: str(b.name, 200), type: b.type, market: str(b.market, 200), phone: str(b.phone, 40), gstin: g, notes: str(b.notes, 1000) };
    let cust;
    if (editId) {
      cust = S.customers.find(x => x.id === editId);
      if (!cust) bad('Customer not found.', 404);
      Object.assign(cust, base);
      if (admin) cust.creditLimit = Math.max(0, num(b.creditLimit) || 0);
      await addLog(c, whoOf(u), `Edited customer ${editId}`);
    } else {
      cust = { id: await nextId(c, 'C'), ...base, creditLimit: admin ? Math.max(0, num(b.creditLimit) || 0) : 50000, opening: admin ? num(b.opening) || 0 : 0, onHold: false };
      if (req.body.fromLead) cust.fromLead = str(req.body.fromLead, 20);
      await addLog(c, whoOf(u), `Added customer ${cust.id} ${cust.name}`);
    }
    await put(c, 'customers', cust);
    return { cust, state: await snapshot(c, u) };
  });
  reply(res, out.state, editId ? `${out.cust.name} updated.` : `${out.cust.name} added.`);
}
app.post('/api/customers/:id/hold', wrap(async (req, res) => {
  const u = req.user; if (u.role !== 'admin') bad('Only an admin can change credit holds.', 403);
  const out = await tx(async c => {
    const r = await c.query('SELECT data FROM customers WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) bad('Customer not found.', 404);
    const x = r.rows[0].data; x.onHold = !x.onHold;
    await put(c, 'customers', x);
    await addLog(c, whoOf(u), `${x.onHold ? 'Placed' : 'Released'} credit hold on ${x.name}`);
    return { x, state: await snapshot(c, u) };
  });
  reply(res, out.state, `${out.x.name} is now ${out.x.onHold ? 'on credit hold' : 'active'}.`);
}));

const STAGES = ['Initial Contact', 'Qualified', 'Negotiation', 'Won', 'Lost'];
async function saveLead(req, res, editId) {
  const u = req.user; need(u, 'lead.manage');
  const b = req.body;
  if (!str(b.businessName)) bad('Enter the business name.');
  if (!STAGES.includes(b.stage)) bad('Choose a stage.');
  const out = await tx(async c => {
    const a = await c.query('SELECT 1 FROM users WHERE id=$1 AND active', [b.assignedTo]);
    if (!a.rows[0]) bad('Choose who the lead is assigned to.');
    const v = { businessName: str(b.businessName, 200), contactPerson: str(b.contactPerson, 120), phone: str(b.phone, 40), market: str(b.market, 200), potential: Math.max(0, num(b.potential) || 0), stage: b.stage, assignedTo: b.assignedTo, notes: str(b.notes, 1000) };
    let l;
    if (editId) {
      const r = await c.query('SELECT data FROM leads WHERE id=$1', [editId]);
      if (!r.rows[0]) bad('Lead not found.', 404);
      l = { ...r.rows[0].data, ...v };
      await addLog(c, whoOf(u), `Edited lead ${v.businessName}`);
    } else {
      l = { id: await nextId(c, 'L'), ...v };
      await addLog(c, whoOf(u), `Created lead ${l.id} ${l.businessName}`);
    }
    await put(c, 'leads', l);
    return snapshot(c, u);
  });
  reply(res, out, editId ? 'Lead updated.' : 'Lead added.');
}
app.post('/api/leads', wrap((req, res) => saveLead(req, res, null)));
app.put('/api/leads/:id', wrap((req, res) => saveLead(req, res, req.params.id)));
app.post('/api/leads/:id/advance', wrap(async (req, res) => {
  const u = req.user; need(u, 'lead.manage');
  const order = ['Initial Contact', 'Qualified', 'Negotiation', 'Won'];
  const out = await tx(async c => {
    const r = await c.query('SELECT data FROM leads WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) bad('Lead not found.', 404);
    const l = r.rows[0].data, i = order.indexOf(l.stage);
    if (i < 0 || i >= 3) bad('This lead cannot be advanced.');
    l.stage = order[i + 1];
    await put(c, 'leads', l);
    await addLog(c, whoOf(u), `Lead ${l.businessName} moved to ${l.stage}`);
    return { l, state: await snapshot(c, u) };
  });
  reply(res, out.state, `${out.l.businessName}: ${out.l.stage}.`);
}));
app.post('/api/leads/:id/lost', wrap(async (req, res) => {
  const u = req.user; need(u, 'lead.manage');
  const state = await tx(async c => {
    const r = await c.query('SELECT data FROM leads WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) bad('Lead not found.', 404);
    const l = { ...r.rows[0].data, stage: 'Lost' };
    await put(c, 'leads', l);
    await addLog(c, whoOf(u), `Marked lead ${l.businessName} as lost`);
    return snapshot(c, u);
  });
  reply(res, state, 'Lead marked as lost.');
}));

/* ---------------- payments ---------------- */
app.post('/api/payments', wrap(async (req, res) => {
  const u = req.user; need(u, 'payment.add');
  const b = req.body, amount = r2(num(b.amount));
  if (!(amount > 0)) bad('Enter an amount above zero.');
  const out = await tx(async c => {
    const S = await snapshot(c, u);
    const cust = S.customers.find(x => x.id === b.customer);
    if (!cust) bad('Select a customer.');
    const o = b.order ? S.orders.find(x => x.id === b.order && x.customerId === cust.id) : null;
    if (b.order && !o) bad('That order does not belong to this customer.');
    if (o && o.status === 'Cancelled') bad('That order is cancelled.');
    if (o && amount > orderDue(S, o) + 0.005) bad(`${o.id} has only ${inr(orderDue(S, o))} due. Record the excess as an on-account payment.`);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today();
    const p = { id: await nextId(c, 'PAY'), orderId: o ? o.id : '', customerId: cust.id, customerName: cust.name, date, mode: str(b.mode, 60), amount, reference: str(b.reference, 100) || 'REF-' + String(Date.now()).slice(-6) };
    await put(c, 'payments', p);
    await addLog(c, whoOf(u), `Recorded ${p.id} ${inr(amount)} from ${cust.name}${o ? ' against ' + o.id : ' on account'}`);
    return snapshot(c, u);
  });
  reply(res, out, `Payment of ${inr(amount)} recorded.`);
}));

/* ---------------- admin ---------------- */
const adminOnly = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Admin access required.')));

app.post('/api/users', adminOnly, wrap(async (req, res) => {
  const u = req.user, b = req.body;
  const email = str(b.email, 200);
  if (!str(b.name)) bad('Enter the full name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter a valid email address.');
  if (!['admin', 'sales', 'warehouse'].includes(b.role)) bad('Choose a role.');
  if (String(b.password || '').length < 8) bad('Password must be at least 8 characters.');
  const hash = await bcrypt.hash(String(b.password), 12);
  const state = await tx(async c => {
    const dup = await c.query('SELECT 1 FROM users WHERE lower(email)=lower($1)', [email]);
    if (dup.rows[0]) bad('A user with this email already exists.');
    const id = await nextId(c, 'U');
    await c.query('INSERT INTO users (id,name,title,role,email,password_hash,must_change) VALUES ($1,$2,$3,$4,$5,$6,true)', [id, str(b.name, 120), str(b.title, 120), b.role, email, hash]);
    await addLog(c, whoOf(u), `Created user ${str(b.name, 120)} (${ROLE_LABEL[b.role]})`);
    return snapshot(c, u);
  });
  reply(res, state, `${str(b.name, 120)} added. Share the email and password with them; they will be asked to choose their own password at first sign-in.`);
}));
app.post('/api/users/:id/toggle', adminOnly, wrap(async (req, res) => {
  const u = req.user;
  if (req.params.id === u.id) bad('You cannot disable your own account.');
  const state = await tx(async c => {
    const r = await c.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    const t = r.rows[0];
    if (!t) bad('User not found.', 404);
    if (t.role === 'admin' && t.active) {
      const n = await c.query(`SELECT count(*)::int AS n FROM users WHERE role='admin' AND active`);
      if (n.rows[0].n < 2) bad('At least one active admin is required.');
    }
    await c.query('UPDATE users SET active=$2, token_version=token_version+1 WHERE id=$1', [t.id, !t.active]);
    await addLog(c, whoOf(u), `${!t.active ? 'Enabled' : 'Disabled'} user ${t.name}`);
    return snapshot(c, u);
  });
  reply(res, state, 'User updated.');
}));
app.post('/api/users/:id/password', adminOnly, wrap(async (req, res) => {
  const u = req.user;
  if (String(req.body.password || '').length < 8) bad('Password must be at least 8 characters.');
  const hash = await bcrypt.hash(String(req.body.password), 12);
  const out = await tx(async c => {
    const r = await c.query('UPDATE users SET password_hash=$2, must_change=(id <> $3), token_version=token_version+1 WHERE id=$1 RETURNING *', [req.params.id, hash, u.id]);
    if (!r.rows[0]) bad('User not found.', 404);
    await addLog(c, whoOf(u), `Reset password for ${r.rows[0].name}`);
    return { t: r.rows[0], state: await snapshot(c, u) };
  });
  if (out.t.id === u.id) setCookie(res, out.t);
  reply(res, out.state, `Password reset for ${out.t.name}. They are signed out everywhere.`);
}));
app.put('/api/company', adminOnly, wrap(async (req, res) => {
  const u = req.user, b = req.body, g = str(b.gstin, 15).toUpperCase();
  if (!GSTIN_RE.test(g)) bad('Enter a valid 15-character GSTIN.');
  if (!str(b.name) || !str(b.address)) bad('Enter the company name and address.');
  const state = await tx(async c => {
    await put2(c, { name: str(b.name, 200), gstin: g, address: str(b.address, 400), phone: str(b.phone, 40), email: str(b.email, 200), bank: str(b.bank, 800), terms: str(b.terms, 1200) });
    await addLog(c, whoOf(u), 'Updated company profile');
    return snapshot(c, u);
  });
  reply(res, state, 'Company profile saved.');
}));
const put2 = (c, data) => c.query(`INSERT INTO company (k,data) VALUES ('company',$1) ON CONFLICT (k) DO UPDATE SET data=EXCLUDED.data`, [data]);

app.get('/api/backup', adminOnly, wrap(async (req, res) => {
  const out = await tx(async c => {
    await addLog(c, whoOf(req.user), 'Downloaded data backup');
    const dump = {};
    for (const t of ['products', 'customers', 'leads', 'orders', 'payments']) dump[t] = (await c.query(`SELECT data FROM ${t} ORDER BY seq`)).rows.map(r => r.data);
    dump.company = (await c.query(`SELECT data FROM company WHERE k='company'`)).rows[0]?.data;
    dump.users = (await c.query('SELECT id,name,title,role,email,active FROM users ORDER BY seq')).rows;
    dump.logs = (await c.query('SELECT data FROM logs ORDER BY seq')).rows.map(r => r.data);
    return dump;
  });
  res.setHeader('Content-Disposition', `attachment; filename="banday-erp-backup-${today()}.json"`);
  res.json(out);
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

/* ---------------- static frontend ---------------- */
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false, setHeaders: (r, p) => { if (p.includes('/assets/')) r.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

const port = Number(process.env.PORT) || 3000;
initDb().then(() => {
  app.listen(port, '0.0.0.0', () => console.log(`Banday Impex ERP listening on ${port}`));
}).catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
