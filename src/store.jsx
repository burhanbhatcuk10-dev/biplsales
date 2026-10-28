import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { today, downloadFile, toCSV } from './lib/utils.js';
import { currentUser, canDo, orderPaid, orderDue, payStatus, outstanding } from './lib/domain.js';

const Ctx = createContext(null);
export const useStore = () => useContext(Ctx);

// Every change goes to the server, which checks permissions, applies business rules and saves to the database.
async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    const err = new Error('Cannot connect right now. Check your internet connection and try again.');
    err.network = true;
    throw err;
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok) {
    const err = new Error(data.error || (res.status >= 502 ? 'The server is starting up. Please try again in a few seconds.' : `Request failed (${res.status}).`));
    err.status = res.status;
    throw err;
  }
  return data;
}

export function StoreProvider({ children }) {
  const [S, setS] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | anon | ready | offline
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);
  const inflight = useRef(false);

  const toast = useCallback((msg, type = 'success') => {
    const id = Math.random();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), type === 'error' ? 5200 : 3200);
  }, []);

  // The free Render plan sleeps when idle and takes up to a minute to wake: keep retrying quietly on the loading screen.
  const refresh = useCallback(async (attempt = 0) => {
    try {
      const d = await request('GET', '/api/state');
      setS(d.state); setStatus('ready');
    } catch (e) {
      if (e.status === 401) { setS(null); setStatus('anon'); return; }
      if (attempt < 25) { await new Promise(r => setTimeout(r, 3000)); return refresh(attempt + 1); }
      setStatus(s => (s === 'ready' ? s : 'offline'));
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const retry = useCallback(() => { setStatus('loading'); refresh(); }, [refresh]);

  // Keep every user's screen current without a manual reload (new orders, stock, payments from other users).
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(25); }, 30000);
    const v = () => { if (document.visibilityState === 'visible') refresh(25); };
    document.addEventListener('visibilitychange', v);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', v); };
  }, [status, refresh]);

  // run(): perform a server action, update state from the reply, toast the result. Resolves true/false.
  const run = useCallback(async (method, url, body, okMsg) => {
    if (inflight.current) return null; // ignore double-clicks while a save is running
    inflight.current = true;
    setBusy(true);
    try {
      const d = await request(method, url, body);
      if (d.state) setS(d.state);
      const m = okMsg || d.message;
      if (m) toast(m);
      return d;
    } catch (e) {
      if (e.status === 401) { setS(null); setStatus('anon'); toast('Your session has ended. Please sign in again.', 'error'); } else toast(e.message, 'error');
      return null;
    } finally { inflight.current = false; setBusy(false); }
  }, [toast]);

  const login = useCallback(async (email, password) => {
    try {
      await request('POST', '/api/auth/login', { email, password });
      await refresh();
      return null;
    } catch (e) { return e.message; }
  }, [refresh]);

  const logout = useCallback(async () => {
    try { await request('POST', '/api/auth/logout'); } catch (e) { /* cookie is cleared server side; ignore network errors */ }
    setS(null); setStatus('anon');
  }, []);

  const api = useMemo(() => {
    const ok = async (...a) => !!(await run(...a));
    const me = S ? currentUser(S) : null;
    const can = a => (S ? canDo(S, a) : false);

    const changePassword = async (current, next) => {
      try { await request('POST', '/api/auth/password', { current, next }); toast('Password changed.'); refresh(25); return true; }
      catch (e) { toast(e.message, 'error'); return false; }
    };

    const placeOrder = d => ok('POST', '/api/orders', { customerId: d.customerId, items: d.items, override: !!d.override, notes: d.notes });
    const advanceOrder = id => run('POST', `/api/orders/${id}/advance`);
    const cancelOrder = async id => {
      if (!window.confirm(`Cancel order ${id}? This cannot be undone.`)) return;
      await run('POST', `/api/orders/${id}/cancel`);
    };
    const saveProduct = (fd, editId) => run(editId ? 'PUT' : 'POST', editId ? `/api/products/${editId}` : '/api/products', fd);
    const saveStock = (fd, id) => ok('POST', `/api/products/${id}/stock`, fd);
    const setProductImage = (id, image) => ok('POST', `/api/products/${id}/image`, { image });
    const removeProductImage = id => ok('DELETE', `/api/products/${id}/image`);
    const saveCustomer = (fd, editId, fromLead) => ok(editId ? 'PUT' : 'POST', editId ? `/api/customers/${editId}` : '/api/customers', { ...fd, fromLead });
    const toggleHold = id => run('POST', `/api/customers/${id}/hold`);
    const saveLead = (fd, editId) => ok(editId ? 'PUT' : 'POST', editId ? `/api/leads/${editId}` : '/api/leads', fd);
    const advanceLead = id => run('POST', `/api/leads/${id}/advance`);
    const markLost = id => run('POST', `/api/leads/${id}/lost`);
    const savePayment = fd => ok('POST', '/api/payments', fd);
    const saveUser = fd => ok('POST', '/api/users', fd);
    const toggleUser = id => run('POST', `/api/users/${id}/toggle`);
    const resetPassword = (id, password) => ok('POST', `/api/users/${id}/password`, { password });
    const saveCompany = fd => ok('PUT', '/api/company', fd);

    const backup = async () => {
      try {
        const res = await fetch('/api/backup', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Backup failed.');
        downloadFile(`banday-erp-backup-${today()}.json`, await res.text(), 'application/json');
        toast('Backup downloaded.');
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };

    const exportCSV = kind => {
      let rows;
      if (kind === 'orders') rows = [['Order', 'Date', 'Customer', 'Market', 'Status', 'Payment', 'Taxable', 'GST', 'Total', 'Paid', 'Due']].concat(S.orders.map(o => [o.id, o.date, o.customerName, o.market, o.status, payStatus(S, o), o.subtotal, o.taxTotal, o.grandTotal, orderPaid(S, o), orderDue(S, o)]));
      if (kind === 'products') rows = [['SKU', 'Name', 'Category', 'Warehouse', 'Stock', 'Safety stock', 'Price', 'GST %']].concat(S.products.map(p => [p.id, p.name, p.category, p.warehouse, p.stock, p.minStock, p.price, p.gst]));
      if (kind === 'customers') rows = [['ID', 'Name', 'Type', 'Market', 'Phone', 'GSTIN', 'Credit limit', 'Outstanding', 'On hold']].concat(S.customers.map(c => [c.id, c.name, c.type, c.market, c.phone, c.gstin, c.creditLimit, outstanding(S, c), c.onHold ? 'Yes' : 'No']));
      if (kind === 'payments') rows = [['Receipt', 'Date', 'Customer', 'Order', 'Mode', 'Reference', 'Amount']].concat(S.payments.map(p => [p.id, p.date, p.customerName, p.orderId, p.mode, p.reference, p.amount]));
      downloadFile(`banday-${kind}-${today()}.csv`, toCSV(rows), 'text/csv');
      toast(`${kind} exported.`);
    };

    return {
      S, me, can, toast, busy, status, login, logout, refresh, retry, changePassword,
      placeOrder, advanceOrder, cancelOrder, saveProduct, saveStock, setProductImage, removeProductImage,
      saveCustomer, toggleHold, saveLead, advanceLead, markLost, savePayment,
      saveUser, toggleUser, resetPassword, saveCompany, backup, exportCSV
    };
  }, [S, status, busy, run, toast, login, logout, refresh, retry]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div id="toast" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={'t ' + (t.type === 'error' ? 'error' : '')}>{t.msg}</div>)}
      </div>
    </Ctx.Provider>
  );
}
