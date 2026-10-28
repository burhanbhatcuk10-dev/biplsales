import React, { useState } from 'react';
import { useStore } from '../store.jsx';

export default function Login() {
  const { login, status, retry } = useStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [wait, setWait] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setErr(''); setWait(true);
    const m = await login(email, password);
    setWait(false);
    if (m) setErr(m);
  };

  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="logo big">BI</div>
        <h1>Banday Impex</h1>
        <p>Orders, inventory, customers and payments for Rehmat Spices, Diamond Saffron and Hidden Valley, in one place.</p>
        <ul>
          <li>Role-based access for sales and store teams</li>
          <li>GST invoices and credit control</li>
          <li>Live stock across Khunmoh warehouses</li>
        </ul>
      </aside>
      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <h2>Sign in</h2>
          <div className="sub">Use the email and password given by your administrator.</div>
          {status === 'offline' && (
            <div className="note bad">The server is not responding. If you run this on your computer, start it with npm run dev. <button type="button" className="btn sm" onClick={retry}>Try again</button></div>
          )}
          <label className="f">Email
            <input type="email" autoComplete="username" required autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
          </label>
          <label className="f">Password
            <span className="pw">
              <input type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
              <button type="button" className="pwtoggle" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</button>
            </span>
          </label>
          {err && <div className="note bad" role="alert">{err}</div>}
          <button className="btn accent big" type="submit" disabled={wait}>{wait ? 'Signing in…' : 'Sign in'}</button>
          <div className="sub" style={{ textAlign: 'center' }}>Forgot your password? Ask your administrator to reset it.</div>
        </form>
      </main>
    </div>
  );
}
