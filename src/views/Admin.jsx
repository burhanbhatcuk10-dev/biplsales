import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { Pill, Icon, Modal, Field, Empty, formData } from '../components/ui.jsx';
import { ROLE_LABEL } from '../lib/domain.js';
import { inr } from '../lib/utils.js';

function UserForm({ onClose }) {
  const { saveUser } = useStore();
  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="stack" onSubmit={async e => { if (await saveUser(formData(e))) onClose(); }}>
        <div className="form">
          <Field label="Full name"><input type="text" name="name" required /></Field>
          <Field label="Job title"><input type="text" name="title" required placeholder="e.g. Field Agent" /></Field>
          <Field label="Email"><input type="email" name="email" required /></Field>
          <Field label="Role">
            <select name="role"><option value="sales">Salesperson</option><option value="warehouse">Store Manager</option><option value="admin">Admin (full access)</option></select>
          </Field>
          <Field label="Password (8+ characters)" full><input type="text" name="password" minLength={8} required autoComplete="off" placeholder="They can change it after signing in" /></Field>
        </div>
        <div className="foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn accent" type="submit">Create user</button></div>
      </form>
    </Modal>
  );
}

export default function Admin() {
  const { S, me, toggleUser, resetPassword, saveCompany, backup } = useStore();
  const [q, setQ] = useState('');
  const [uf, setUf] = useState('');
  const [addUser, setAddUser] = useState(false);
  const term = q.toLowerCase();
  const logs = S.logs.filter(l => (!uf || l.user.startsWith(uf + ' (')) && (!term || (l.user + l.action).toLowerCase().includes(term))).slice(0, 200);
  const stat = id => { const mine = S.orders.filter(o => o.salesperson === id && o.status !== 'Cancelled'); return { n: mine.length, v: mine.reduce((a, o) => a + o.grandTotal, 0) }; };
  const co = S.company;

  return (
    <div className="stack">
      <div className="card pad row between">
        <div className="grow"><h2>Admin: users, company profile &amp; audit trail</h2><div className="sub">Role permissions: Admin has full access. Salesperson creates orders, customers, leads and receipts. Store Manager dispatches, delivers and adjusts stock. Share each person's email and password with them yourself; they can change it from the Password button.</div></div>
        <button className="btn primary" onClick={() => setAddUser(true)}><Icon name="plus" /> Add user</button>
      </div>

      <div className="card tbl">
        <table>
          <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Orders created</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {S.users.map(u => (
              <tr key={u.id}>
                <td><b>{u.name}</b><span className="s">{u.id} · {u.title}</span></td>
                <td className="mono">{u.email}</td>
                <td><Pill kind="info">{ROLE_LABEL[u.role]}</Pill></td>
                <td className="num">{stat(u.id).n}<span className="s">{inr(stat(u.id).v)}</span></td>
                <td>{u.active ? <Pill kind="good">Active</Pill> : <Pill kind="mute">Disabled</Pill>}</td>
                <td><div className="acts"><button className="btn sm" onClick={() => { const pw = window.prompt(`New password for ${u.name} (8+ characters). They will be signed out everywhere.`); if (pw) resetPassword(u.id, pw); }}>Reset password</button>
                  <button className="btn sm" onClick={() => toggleUser(u.id)} disabled={u.id === me.id} title={u.id === me.id ? 'You cannot disable your own account' : undefined}>{u.active ? 'Disable' : 'Enable'}</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card pad">
        <h2>Company profile (printed on invoices)</h2>
        <div className="note warn" style={{ marginTop: 10 }}>Enter the real GSTIN before issuing invoices. The value pre-filled here is a placeholder.</div>
        <form className="stack" style={{ marginTop: 14 }} onSubmit={e => saveCompany(formData(e))}>
          <div className="form">
            <Field label="Legal name"><input type="text" name="name" required defaultValue={co.name} /></Field>
            <Field label="GSTIN"><input type="text" name="gstin" maxLength={15} required style={{ textTransform: 'uppercase' }} defaultValue={co.gstin} /></Field>
            <Field label="Address" full><input type="text" name="address" required defaultValue={co.address} /></Field>
            <Field label="Phone"><input type="tel" name="phone" defaultValue={co.phone} /></Field>
            <Field label="Email"><input type="email" name="email" defaultValue={co.email} /></Field>
            <Field label="Bank details (shown on invoice)"><textarea name="bank" placeholder="Account name, A/C no., IFSC, branch" defaultValue={co.bank} /></Field>
            <Field label="Invoice terms"><textarea name="terms" defaultValue={co.terms} /></Field>
          </div>
          <div className="foot" style={{ marginTop: 0 }}><button className="btn accent" type="submit">Save company profile</button></div>
        </form>
      </div>

      <div className="card pad">
        <h2>Data backup</h2>
        <div className="sub">Your data lives in the Neon database. Download a JSON copy any time for your own records.</div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={backup}><Icon name="down" /> Download backup (JSON)</button>
        </div>
      </div>

      <div className="card">
        <div className="pad row between">
          <div><h2>Security audit trail</h2><div className="sub">Latest 200 matching entries</div></div>
          <div className="row"><select value={uf} onChange={e => setUf(e.target.value)} aria-label="Filter by user" className="userfilter"><option value="">All users</option>{S.users.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}</select>
          <input type="text" className="search" placeholder="Filter by user or action" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter audit log" /></div>
        </div>
        <div className="tbl">
          <table>
            <thead><tr><th>When</th><th>User</th><th>Action</th></tr></thead>
            <tbody>
              {logs.map(l => <tr key={l.id}><td className="num" style={{ whiteSpace: 'nowrap' }}>{l.ts}<span className="s">{l.id}</span></td><td>{l.user}</td><td>{l.action}</td></tr>)}
              {logs.length === 0 && <Empty cols={3}>No log entries.</Empty>}
            </tbody>
          </table>
        </div>
      </div>

      {addUser && <UserForm onClose={() => setAddUser(false)} />}
    </div>
  );
}
