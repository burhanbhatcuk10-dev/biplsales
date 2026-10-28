import React, { useEffect, useState } from 'react';
import { useStore } from './store.jsx';
import { ROLE_LABEL } from './lib/domain.js';
import Dashboard from './views/Dashboard.jsx';
import Orders from './views/Orders.jsx';
import Products from './views/Products.jsx';
import Crm from './views/Crm.jsx';
import Payments from './views/Payments.jsx';
import Admin from './views/Admin.jsx';
import Login from './views/Login.jsx';
import Reports from './views/Reports.jsx';
import { Modal, Field, formData } from './components/ui.jsx';

function PasswordModal({ onClose, forced, logout }) {
  const { changePassword } = useStore();
  return (
    <Modal title={forced ? 'Choose your own password' : 'Change password'} onClose={forced ? () => {} : onClose}>
      {forced && <div className="note warn" style={{ marginBottom: 14 }}>Your administrator gave you a temporary password. Set a new one to continue.</div>}
      <form className="stack" onSubmit={async e => {
        const d = formData(e);
        if (d.next !== d.again) { alert('The new passwords do not match.'); return; }
        if (await changePassword(d.current, d.next)) onClose();
      }}>
        <div className="form">
          <Field label="Current password" full><input type="password" name="current" autoComplete="current-password" required /></Field>
          <Field label="New password (8+ characters)"><input type="password" name="next" autoComplete="new-password" minLength={8} required /></Field>
          <Field label="Repeat new password"><input type="password" name="again" autoComplete="new-password" minLength={8} required /></Field>
        </div>
        <div className="foot">{forced ? <button type="button" className="btn" onClick={logout}>Sign out</button> : <button type="button" className="btn" onClick={onClose}>Cancel</button>}<button className="btn accent" type="submit">Change password</button></div>
      </form>
    </Modal>
  );
}

export default function App() {
  const { S, me, status, logout } = useStore();
  if (status === 'loading') return <div className="login"><div className="boot"><span className="spin" aria-hidden="true" /> Starting up, one moment…</div></div>;
  if (!S || status === 'anon' || status === 'offline') return <Login />;
  return <Shell S={S} me={me} logout={logout} />;
}

function Shell({ S, me, logout }) {
  const [tab, setTab] = useState('dashboard');
  const [pwd, setPwd] = useState(false);
  const [autoOrder, setAutoOrder] = useState(false);

  const pending = S.orders.filter(o => o.status === 'Pending Review').length;
  const tabs = [['dashboard', 'Dashboard'], ['orders', 'Orders & Dispatch'], ['products', 'Inventory'], ['crm', 'Customers & Leads'], ['payments', 'Payments & Ledger']];
  if (me.role === 'admin') tabs.push(['reports', 'Reports'], ['admin', 'Admin & Audit']);
  const active = tabs.some(t => t[0] === tab) ? tab : 'dashboard';

  useEffect(() => { document.title = S.company.name + ' ERP'; }, [S.company.name]);

  const go = t => { setTab(t); window.scrollTo(0, 0); };
  const newOrder = () => { setAutoOrder(true); go('orders'); };

  return (
    <>
      <header className="top">
        <div className="wrap">
          <div className="brand">
            <div className="logo">BI</div>
            <div>
              <b>{S.company.name}</b>
              <small>Rehmat Spices · Diamond Saffron · Hidden Valley</small>
            </div>
          </div>
          <div className="who">
            <span><b>{me.name}</b></span>
            <span className="chip">{ROLE_LABEL[me.role]}</span>
            <button className="btn sm" onClick={() => setPwd(true)}>Password</button>
            <button className="btn sm" onClick={logout}>Sign out</button>
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        <div className="wrap">
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => go(id)} aria-current={active === id ? 'page' : undefined}>
              {label}{id === 'orders' && pending > 0 && <span className="badge">{pending}</span>}
            </button>
          ))}
        </div>
      </nav>

      <main>
        <div className="wrap">
          {active === 'dashboard' && <Dashboard goTab={go} newOrder={newOrder} />}
          {active === 'orders' && <Orders autoOpen={autoOrder} onAutoOpened={() => setAutoOrder(false)} />}
          {active === 'products' && <Products />}
          {active === 'crm' && <Crm />}
          {active === 'payments' && <Payments />}
          {active === 'reports' && <Reports />}
          {active === 'admin' && <Admin />}
        </div>
      </main>

      <footer>
        <div className="wrap">
          {S.company.name} · {S.company.address} ·{' '}
          Signed in as {me.name}. Data is saved securely online and shared with your team.
        </div>
      </footer>
      {S.mustChange ? <PasswordModal forced logout={logout} onClose={() => {}} /> : pwd && <PasswordModal onClose={() => setPwd(false)} />}
    </>
  );
}
