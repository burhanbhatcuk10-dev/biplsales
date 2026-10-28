import React, { useMemo, useState } from 'react';
import { useStore } from '../store.jsx';
import { Icon } from '../components/ui.jsx';
import { inr, r2, downloadFile, toCSV } from '../lib/utils.js';
import { outstanding, userName, lowStock } from '../lib/domain.js';

const iso = d => d.toLocaleDateString('en-CA');
function presets() {
  const t = new Date();
  const m0 = new Date(t.getFullYear(), t.getMonth(), 1);
  const d30 = new Date(t); d30.setDate(d30.getDate() - 29);
  const fy = new Date(t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1, 3, 1);
  return { 'This month': [iso(m0), iso(t)], 'Last 30 days': [iso(d30), iso(t)], 'This FY': [iso(fy), iso(t)], 'All time': ['', ''] };
}

// cols: [{ h, k, f?, r? }]  rows: array of objects. f formats for display; CSV keeps the raw value.
function ReportTable({ title, sub, cols, rows, file }) {
  const csv = () => downloadFile(`${file}.csv`, toCSV([cols.map(c => c.h)].concat(rows.map(r => cols.map(c => r[c.k])))), 'text/csv');
  return (
    <div className="card">
      <div className="pad row between">
        <div><h2>{title}</h2>{sub && <div className="sub">{sub}</div>}</div>
        <button className="btn sm" onClick={csv} disabled={!rows.length}><Icon name="down" size={13} /> CSV</button>
      </div>
      <div className="tbl">
        <table>
          <thead><tr>{cols.map(c => <th key={c.k} className={c.r ? 'r' : ''}>{c.h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>{cols.map(c => <td key={c.k} className={c.r ? 'r num' : ''}>{c.f ? c.f(r[c.k]) : r[c.k]}</td>)}</tr>)}
            {rows.length === 0 && <tr><td colSpan={cols.length} className="empty">No data for this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Reports() {
  const { S } = useStore();
  const P = useMemo(presets, []);
  const [label, setLabel] = useState('Last 30 days');
  const [from, setFrom] = useState(P['Last 30 days'][0]);
  const [to, setTo] = useState(P['Last 30 days'][1]);
  const pick = l => { setLabel(l); setFrom(P[l][0]); setTo(P[l][1]); };
  const inRange = d => (!from || d >= from) && (!to || d <= to);

  const orders = S.orders.filter(o => o.status !== 'Cancelled' && inRange(o.date));
  const pays = S.payments.filter(p => inRange(p.date));
  const sales = r2(orders.reduce((a, o) => a + o.grandTotal, 0));
  const collected = r2(pays.reduce((a, p) => a + p.amount, 0));

  const group = (list, keyFn) => {
    const m = new Map();
    list.forEach(o => { const k = keyFn(o); const g = m.get(k) || { key: k, orders: 0, delivered: 0, value: 0 }; g.orders++; g.value = r2(g.value + o.grandTotal); if (o.status === 'Delivered') g.delivered++; m.set(k, g); });
    return [...m.values()].sort((a, b) => b.value - a.value);
  };
  const byPerson = group(orders, o => userName(S, o.salesperson)).map(g => ({ person: g.key, orders: g.orders, delivered: g.delivered, value: g.value, share: sales ? Math.round((g.value / sales) * 100) : 0 }));
  const byCust = group(orders, o => o.customerId).map(g => {
    const c = S.customers.find(x => x.id === g.key);
    return { customer: c ? c.name : g.key, market: c ? c.market : '', orders: g.orders, value: g.value, outstanding: c ? outstanding(S, c) : 0 };
  });
  const prod = new Map();
  orders.forEach(o => o.items.forEach(i => {
    const g = prod.get(i.productId) || { sku: i.productId, name: i.name, qty: 0, revenue: 0 };
    g.qty += i.qty; g.revenue = r2(g.revenue + i.price * i.qty); prod.set(i.productId, g);
  }));
  const byProduct = [...prod.values()].sort((a, b) => b.revenue - a.revenue);
  const stock = S.products.map(p => ({ sku: p.id, name: p.name, stock: p.stock, min: p.minStock, value: r2(p.stock * p.price), status: p.stock <= p.minStock ? (p.stock === 0 ? 'Out of stock' : 'Low') : 'OK' }));
  const stockValue = r2(stock.reduce((a, p) => a + p.value, 0));
  const receivable = r2(S.customers.reduce((a, c) => a + Math.max(0, outstanding(S, c)), 0));

  return (
    <div className="stack">
      <div className="card pad row between">
        <div className="grow"><h2>Reports</h2><div className="sub">Cancelled orders are excluded. Every table can be exported to CSV.</div></div>
        <div className="row">
          <div className="seg">{Object.keys(P).map(l => <button key={l} onClick={() => pick(l)} aria-pressed={label === l}>{l}</button>)}</div>
          <input type="date" value={from} onChange={e => { setLabel(''); setFrom(e.target.value); }} aria-label="From date" className="datein" />
          <input type="date" value={to} onChange={e => { setLabel(''); setTo(e.target.value); }} aria-label="To date" className="datein" />
        </div>
      </div>

      <div className="kpis">
        <div className="card kpi"><div className="l">Sales (incl. GST)</div><div className="v">{inr(sales)}</div><div className="d">{orders.length} orders</div></div>
        <div className="card kpi"><div className="l">Collected</div><div className="v">{inr(collected)}</div><div className="d">{pays.length} receipts</div></div>
        <div className="card kpi"><div className="l">Average order</div><div className="v">{inr(orders.length ? Math.round(sales / orders.length) : 0)}</div><div className="d">in this period</div></div>
        <div className="card kpi"><div className="l">Total receivable</div><div className="v">{inr(receivable)}</div><div className="d">all customers, today</div></div>
        <div className="card kpi"><div className="l">Stock value</div><div className="v">{inr(stockValue)}</div><div className="d">{lowStock(S).length} SKUs low</div></div>
      </div>

      <ReportTable title="Sales by salesperson" file="sales-by-salesperson"
        cols={[{ h: 'Salesperson', k: 'person' }, { h: 'Orders', k: 'orders', r: 1 }, { h: 'Delivered', k: 'delivered', r: 1 }, { h: 'Sales value', k: 'value', r: 1, f: inr }, { h: 'Share %', k: 'share', r: 1 }]} rows={byPerson} />
      <ReportTable title="Sales by customer" file="sales-by-customer"
        cols={[{ h: 'Customer', k: 'customer' }, { h: 'Market', k: 'market' }, { h: 'Orders', k: 'orders', r: 1 }, { h: 'Sales value', k: 'value', r: 1, f: inr }, { h: 'Outstanding now', k: 'outstanding', r: 1, f: inr }]} rows={byCust} />
      <ReportTable title="Product performance" file="product-performance"
        cols={[{ h: 'SKU', k: 'sku' }, { h: 'Product', k: 'name' }, { h: 'Units sold', k: 'qty', r: 1 }, { h: 'Revenue (excl. GST)', k: 'revenue', r: 1, f: inr }]} rows={byProduct} />
      <ReportTable title="Stock position" sub="Current stock, not limited to the date range" file="stock-position"
        cols={[{ h: 'SKU', k: 'sku' }, { h: 'Product', k: 'name' }, { h: 'In stock', k: 'stock', r: 1 }, { h: 'Safety stock', k: 'min', r: 1 }, { h: 'Value', k: 'value', r: 1, f: inr }, { h: 'Status', k: 'status' }]} rows={stock} />
    </div>
  );
}
