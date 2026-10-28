import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { Pill, Icon, Modal, Field, Empty, formData } from '../components/ui.jsx';
import { inr, imageToDataUrl, cdn } from '../lib/utils.js';

function ProductForm({ product, onClose }) {
  const { saveProduct, setProductImage, removeProductImage, toast } = useStore();
  const [img, setImg] = useState(null);        // new image chosen (data URL)
  const [drop, setDrop] = useState(false);     // remove existing image
  const preview = img || (!drop && product && product.image) || '';
  const pick = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { setImg(await imageToDataUrl(f)); setDrop(false); } catch (err) { toast(err.message, 'error'); }
  };
  const v = product || { name: '', category: 'Spices', warehouse: 'Khunmoh Phase II - W2', stock: 0, minStock: 30, price: 100, gst: 12 };
  return (
    <Modal title={product ? `Edit ${product.id}` : 'Add SKU to catalog'} onClose={onClose}>
      <form className="stack" onSubmit={async e => {
        const r = await saveProduct(formData(e), product && product.id);
        if (!r) return;
        const id = product ? product.id : r.id;
        if (img) await setProductImage(id, img);
        else if (drop && product && product.image) await removeProductImage(id);
        onClose();
      }}>
        <div className="imgbox">
          {preview ? <img className="thumb" src={preview} alt="" /> : <div className="thumb ph">No photo</div>}
          <label className="btn sm" style={{ cursor: 'pointer' }}>{preview ? 'Change photo' : 'Add photo'}
            <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick} />
          </label>
          {preview && <button type="button" className="btn sm danger" onClick={() => { setImg(null); setDrop(true); }}>Remove</button>}
        </div>
        <div className="form">
          <Field label="Product name" full><input type="text" name="name" required defaultValue={v.name} placeholder="e.g. Rehmat Shahi Masala 100g" /></Field>
          <Field label="Category"><select name="category" defaultValue={v.category}>{['Saffron', 'Spices', 'Food Items'].map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Warehouse"><input type="text" name="warehouse" defaultValue={v.warehouse} /></Field>
          {!product && <Field label="Opening stock"><input type="number" name="stock" min="0" step="1" defaultValue={v.stock} /></Field>}
          <Field label="Safety stock"><input type="number" name="minStock" min="0" step="1" defaultValue={v.minStock} /></Field>
          <Field label="Unit price (₹, excl. GST)"><input type="number" name="price" min="0.01" step="0.01" defaultValue={v.price} /></Field>
          <Field label="GST rate"><select name="gst" defaultValue={v.gst}>{[0, 5, 12, 18, 28].map(g => <option key={g} value={g}>{g}%</option>)}</select></Field>
        </div>
        {product && <div className="note warn">Price changes apply to new orders only. Existing orders and invoices keep the price they were created with.</div>}
        <div className="foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn accent" type="submit">Save product</button></div>
      </form>
    </Modal>
  );
}

function StockForm({ product, onClose }) {
  const { saveStock } = useStore();
  return (
    <Modal title={`Adjust stock · ${product.id}`} onClose={onClose}>
      <form className="stack" onSubmit={async e => { if (await saveStock(formData(e), product.id)) onClose(); }}>
        <div className="note">{product.name} currently holds <b>{product.stock}</b> units.</div>
        <div className="form">
          <Field label="Movement">
            <select name="kind">
              <option value="in">Stock in (receipt / production)</option>
              <option value="out">Stock out (damage, sample, wastage)</option>
              <option value="set">Set to counted quantity</option>
            </select>
          </Field>
          <Field label="Quantity"><input type="number" name="qty" min="0" step="1" defaultValue="0" required /></Field>
          <Field label="Reason" full><input type="text" name="reason" required placeholder="e.g. Batch SB-1042 received" /></Field>
        </div>
        <div className="foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn accent" type="submit">Update stock</button></div>
      </form>
    </Modal>
  );
}

export default function Products() {
  const { S, can, exportCSV } = useStore();
  const [cat, setCat] = useState('All');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null); // {type:'edit'|'stock', id} | {type:'new'}
  const [view, setView] = useState(() => { try { return localStorage.getItem('bi_prod_view') || 'table'; } catch (e) { return 'table'; } });
  const setV = v => { setView(v); try { localStorage.setItem('bi_prod_view', v); } catch (e) { /* storage blocked */ } };

  const cats = ['All', ...Array.from(new Set(S.products.map(p => p.category)))];
  const term = q.toLowerCase();
  const list = S.products.filter(p => (cat === 'All' || p.category === cat) && (!term || (p.name + p.id).toLowerCase().includes(term)));
  const value = S.products.reduce((a, p) => a + p.stock * p.price, 0);
  const target = modal && modal.id ? S.products.find(p => p.id === modal.id) : null;

  return (
    <div className="stack">
      <div className="card pad row between">
        <div className="grow"><h2>Product master &amp; Khunmoh inventory</h2><div className="sub">{S.products.length} SKUs · stock valued at {inr(value)} at selling price</div></div>
        <div className="row">
          <button className="btn" onClick={() => exportCSV('products')}><Icon name="down" /> CSV</button>
          {can('*') && <button className="btn primary" onClick={() => setModal({ type: 'new' })}><Icon name="plus" /> Add SKU</button>}
        </div>
      </div>

      <div className="card pad row between">
        <div className="row"><div className="seg">{cats.map(c => <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c}>{c}</button>)}</div>
          <div className="seg"><button onClick={() => setV('table')} aria-pressed={view === 'table'}>List</button><button onClick={() => setV('grid')} aria-pressed={view === 'grid'}>Gallery</button></div></div>
        <input type="text" className="search" placeholder="Search SKU or product" value={q} onChange={e => setQ(e.target.value)} aria-label="Search products" />
      </div>

      {view === 'grid' && (
        <div className="gallery">
          {list.map(p => {
            const low = p.stock <= p.minStock;
            return (
              <div className="card pcard" key={p.id}>
                {p.image ? <img className="pimg" src={cdn(p.image, 480, 360)} alt={p.name} loading="lazy" /> : <div className="pimg ph">{p.category}</div>}
                <div className="pbody">
                  <div className="pname">{p.name}</div>
                  <div className="row between"><b className="num">{inr(p.price)}</b>{low ? <Pill kind="bad">{p.stock === 0 ? 'Out of stock' : 'Low stock'}</Pill> : <Pill kind="good">{p.stock} in stock</Pill>}</div>
                  <div className="sub">{p.id} · GST {p.gst}% · {p.warehouse}</div>
                  <div className="acts" style={{ marginTop: 10 }}>
                    {(can('*') || can('stock.adjust')) && <button className="btn sm" onClick={() => setModal({ type: 'stock', id: p.id })}>Adjust stock</button>}
                    {can('*') && <button className="btn sm" onClick={() => setModal({ type: 'edit', id: p.id })}>Edit</button>}
                  </div>
                </div>
              </div>
            );
          })}
          {list.length === 0 && <div className="card pad empty">No products match.</div>}
        </div>
      )}

      {view === 'table' && <div className="card tbl">
        <table>
          <thead><tr><th>SKU &amp; product</th><th>Category</th><th>Warehouse</th><th className="r">Stock</th><th className="r">Price</th><th className="r">GST</th><th>Health</th><th>Actions</th></tr></thead>
          <tbody>
            {list.map(p => {
              const low = p.stock <= p.minStock;
              return (
                <tr key={p.id}>
                  <td>
                    <div className="pcell">
                      {p.image ? <img className="thumb" src={cdn(p.image, 96)} alt="" loading="lazy" /> : <div className="thumb ph">{p.category.slice(0, 3).toUpperCase()}</div>}
                      <div><b>{p.id}</b><span className="s">{p.name}</span></div>
                    </div>
                  </td>
                  <td><Pill kind="mute">{p.category}</Pill></td>
                  <td>{p.warehouse}</td>
                  <td className="r num"><b>{p.stock}</b><span className="s">min {p.minStock}</span></td>
                  <td className="r num">{inr(p.price)}</td>
                  <td className="r">{p.gst}%</td>
                  <td>{low ? <Pill kind="bad">{p.stock === 0 ? 'Out of stock' : 'Low stock'}</Pill> : <Pill kind="good">Healthy</Pill>}</td>
                  <td>
                    <div className="acts">
                      {(can('*') || can('stock.adjust')) && <button className="btn sm" onClick={() => setModal({ type: 'stock', id: p.id })}>Adjust stock</button>}
                      {can('*') && <button className="btn sm" onClick={() => setModal({ type: 'edit', id: p.id })}>Edit</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && <Empty cols={8}>No products match.</Empty>}
          </tbody>
        </table>
      </div>}

      {modal && modal.type === 'new' && <ProductForm onClose={() => setModal(null)} />}
      {modal && modal.type === 'edit' && target && <ProductForm product={target} onClose={() => setModal(null)} />}
      {modal && modal.type === 'stock' && target && <StockForm product={target} onClose={() => setModal(null)} />}
    </div>
  );
}
