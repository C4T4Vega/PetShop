'use strict';
const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const { COL, RESOURCES, calcularTotales, COSTO_PCT, IVA } = require('./config');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'PetShop';
const PORT = Number(process.env.PORT) || 3000;
const USUARIO = process.env.APP_USER || 'anonimo';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new HttpError(400, m);
const notFound = m => new HttpError(404, m);
const wrap = fn => (req, res, next) => fn(req, res).catch(next);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const rxSafe = q => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

let db;

//Auditoría (reemplaza los triggers de Oracle)
async function audit(tabla, operacion, idRegistro, detalle) {
  try {
    await db.collection(COL.auditoria).insertOne({
      nombre_tabla: tabla.toUpperCase(), operacion, usuario: USUARIO, fecha_operacion: new Date(),
      id_registro: String(idRegistro), detalle: String(detalle).slice(0, 500)
    });
  } catch (e) { console.error('No se pudo registrar auditoría:', e.message); }
}
const auditVenta = (operacion, extra) =>
  audit('VENTA', operacion, 'N/A', 'Ejecución de sentencia DML global (Statement Level) sobre la tabla VENTA' + (extra ? ' | ' + extra : ''));

//Clave de negocio en _id
const fieldDef = (r, n) => r.fields.find(f => f.name === n);
const isNum = f => f.type === 'number' || (f.type === 'lookup' && f.numeric);
const single = r => r.keyFields.length === 1;
const idOf = (r, d) => single(r) ? String(d._id) : r.keyFields.map(k => d._id[k]).join('|');
function fromDb(r, d) {
  const { _id, ...rest } = d;
  return { ...(single(r) ? { [r.keyFields[0]]: _id } : _id), ...rest, id: idOf(r, d) };
}
function toDb(r, doc) {
  const rest = { ...doc };
  r.keyFields.forEach(k => delete rest[k]);
  const _id = single(r) ? doc[r.keyFields[0]] : Object.fromEntries(r.keyFields.map(k => [k, doc[k]]));
  return { _id, ...rest };
}
function parseId(r, s) {
  const parts = single(r) ? [s] : String(s).split('|');
  if (parts.length !== r.keyFields.length) throw bad('Identificador no válido.');
  const vals = r.keyFields.map((k, i) => isNum(fieldDef(r, k)) ? Number(parts[i]) : parts[i]);
  return single(r) ? vals[0] : Object.fromEntries(r.keyFields.map((k, i) => [k, vals[i]]));
}
const dbPath = (r, name) => r.keyFields.includes(name) ? (single(r) ? '_id' : '_id.' + name) : name;
const sf = (sucursal_id, codigo_producto) => ({ '_id.sucursal_id': sucursal_id, '_id.codigo_producto': codigo_producto });

//Validación genérica
function coerce(r, body, editing) {
  const out = {};
  for (const f of r.fields) {
    if (editing && r.keyFields.includes(f.name)) continue;
    const v = body[f.name];
    if (v === undefined || v === null || String(v).trim() === '') {
      if (f.required) throw bad(`El campo "${f.label}" es obligatorio.`);
      out[f.name] = null; continue;
    }
    if (isNum(f)) {
      const n = Number(v);
      if (!Number.isFinite(n)) throw bad(`El campo "${f.label}" debe ser numérico.`);
      if ((f.int || f.type === 'lookup') && !Number.isInteger(n)) throw bad(`El campo "${f.label}" debe ser un entero.`);
      if (f.min != null && n < f.min) throw bad(`El campo "${f.label}" no puede ser menor que ${f.min}.`);
      out[f.name] = n;
    } else {
      const s = String(v).trim();
      if (f.type === 'select' && !f.options.includes(s)) throw bad(`Valor no válido para "${f.label}".`);
      out[f.name] = s;
    }
  }
  return out;
}
async function checkRefs(r, doc) {
  for (const ref of r.refs || []) {
    if (doc[ref.field] == null) continue;
    if (!await db.collection(ref.collection).findOne({ _id: doc[ref.field] }, { projection: { _id: 1 } })) throw bad(ref.msg);
  }
}
const getRes = req => { const r = RESOURCES[req.params.res]; if (!r) throw notFound('Recurso no encontrado.'); return r; };

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', wrap(async (req, res) => {
  const counts = {};
  for (const name of Object.values(COL)) counts[name] = await db.collection(name).estimatedDocumentCount();
  res.json({ ok: true, db: DB_NAME, counts });
}));
app.get('/api/meta', (req, res) => {
  const resources = {};
  for (const [k, r] of Object.entries(RESOURCES)) resources[k] = { label: r.label, singular: r.singular, fields: r.fields, keyFields: r.keyFields };
  res.json({ ok: true, resources, iva: IVA });
});
app.get('/api/lookups', wrap(async (req, res) => {
  const all = c => db.collection(c).find({}).toArray();
  const [suc, ven, can, art, cli] = await Promise.all([all(COL.sucursal), all(COL.vendedor), all(COL.canal), all(COL.articulo), all(COL.cliente)]);
  res.json({
    ok: true,
    sucursales: suc.map(s => ({ value: s._id, label: s.nombre_sucursal })),
    vendedores: ven.map(v => ({ value: v._id, label: `${v.nombre} ${v.apellidos}` })),
    canales: can.map(c => ({ value: c._id, label: c.nombre_canal })),
    articulos: art.map(a => ({ value: a._id, label: `${a._id} · ${a.nombre}`, precio: a.precio_base })),
    clientes: cli.map(c => ({ value: c._id, label: `${c._id} · ${c.nombre} ${c.apellido}` }))
  });
}));
app.get('/api/auditoria', wrap(async (req, res) => {
  const filtro = req.query.tabla ? { nombre_tabla: String(req.query.tabla) } : {};
  const data = await db.collection(COL.auditoria).find(filtro).sort({ fecha_operacion: -1, _id: -1 }).limit(200).toArray();
  res.json({ ok: true, data });
}));

//VENTAS (lógica de pkg_ventas_petshop)
const ventaOut = v => ({ ...v, id: v._id, numero_documento: v._id, detalles: v.detalles || [] });

app.get('/api/ventas', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filtro = q ? { $or: [{ _id: rxSafe(q) }, { rut_cliente: rxSafe(q) }] } : {};
  const data = await db.collection(COL.venta).find(filtro).sort({ fecha: -1, _id: -1 }).limit(500).toArray();
  res.json({ ok: true, data: data.map(ventaOut) });
}));

app.post('/api/ventas', wrap(async (req, res) => {
  const b = req.body || {};
  const rut = String(b.rut_cliente || '').trim();
  const sucursal_id = Number(b.sucursal_id), id_vendedor = Number(b.id_vendedor), canal_id = Number(b.canal_id);
  const tipo = b.tipo_documento === 'Factura' ? 'Factura' : 'Boleta';

  if (!await db.collection(COL.cliente).findOne({ _id: rut })) throw bad(`El cliente con RUT ${rut || '(vacío)'} no existe.`);
  if (!await db.collection(COL.sucursal).findOne({ _id: sucursal_id })) throw bad('La sucursal indicada no existe.');
  if (!await db.collection(COL.vendedor).findOne({ _id: id_vendedor })) throw bad('El vendedor indicado no existe.');
  if (!await db.collection(COL.canal).findOne({ _id: canal_id })) throw bad('El canal indicado no existe.');
  if (!Array.isArray(b.detalle) || !b.detalle.length) throw bad('La venta debe tener al menos un producto.');

  const pedido = new Map();
  for (const l of b.detalle) {
    const cant = Number(l.cantidad);
    if (!l.codigo_producto) throw bad('Todas las líneas deben tener un producto.');
    if (!Number.isInteger(cant) || cant <= 0) throw bad('La cantidad debe ser un entero mayor que 0.');
    pedido.set(l.codigo_producto, (pedido.get(l.codigo_producto) || 0) + cant);
  }
  const lineas = [];
  for (const [codigo, cantidad] of pedido) {
    const art = await db.collection(COL.articulo).findOne({ _id: codigo });
    if (!art) throw bad(`El producto ${codigo} no existe.`);
    const stock = await db.collection(COL.stock).findOne(sf(sucursal_id, codigo));
    if (!stock) throw bad(`El producto ${codigo} no tiene registro de stock en la sucursal indicada.`);
    if (stock.cantidad_stock < cantidad) throw bad(`Stock insuficiente para "${art.nombre}". Disponible: ${stock.cantidad_stock}.`);
    lineas.push({ codigo_producto: codigo, precio_unitario: art.precio_base, cantidad, total_linea: art.precio_base * cantidad, costo_unitario: Math.round(art.precio_base * COSTO_PCT), nombre: art.nombre });
  }
  const bruto = lineas.reduce((s, l) => s + l.total_linea, 0);
  const t = calcularTotales(bruto);

  const aplicadas = [];
  const revertir = async () => { for (const a of aplicadas) await db.collection(COL.stock).updateOne(sf(sucursal_id, a.codigo), { $inc: { cantidad_stock: a.cantidad } }); };
  try {
    for (const l of lineas) {
      const antes = await db.collection(COL.stock).findOneAndUpdate(
        { ...sf(sucursal_id, l.codigo_producto), cantidad_stock: { $gte: l.cantidad } },
        { $inc: { cantidad_stock: -l.cantidad } }, { returnDocument: 'before' });
      if (!antes) throw bad(`Stock insuficiente para "${l.nombre}" (otra venta se adelantó).`);
      aplicadas.push({ codigo: l.codigo_producto, cantidad: l.cantidad, antes: antes.cantidad_stock });
    }
    const cont = await db.collection(COL.contadores).findOneAndUpdate(
      { _id: tipo === 'Factura' ? 'seq_folio_factura' : 'seq_folio_boleta' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const folio = (tipo === 'Factura' ? 'FAC-' : 'BOL-') + cont.seq;

    await db.collection(COL.venta).insertOne({
      _id: folio, fecha: new Date(), tipo_documento: tipo, total_neto: t.totalNeto, porcentaje_impuesto: IVA * 100,
      impuesto: t.impuesto, total_documento: t.totalDocumento, rut_cliente: rut, id_vendedor, canal_id,
      detalles: lineas, monto_bruto: bruto, descuento: t.descuento, sucursal_id
    });
    for (const a of aplicadas) await audit('STOCK_SUCURSAL', 'UPDATE', `SUC:${sucursal_id}|PROD:${a.codigo}`, `Stock modificado. Anterior: ${a.antes} -> Nuevo: ${a.antes - a.cantidad}`);
    await auditVenta('INSERT', `Doc ${folio}`);
    res.status(201).json({ ok: true, message: `Venta ${folio} registrada. Total: $${t.totalDocumento.toLocaleString('es-CL')}` });
  } catch (e) { await revertir(); throw e; }
}));

app.put('/api/ventas/:id', wrap(async (req, res) => {
  const actual = await db.collection(COL.venta).findOne({ _id: req.params.id });
  if (!actual) throw notFound('La venta no existe.');
  const id_vendedor = Number(req.body.id_vendedor), canal_id = Number(req.body.canal_id);
  if (!await db.collection(COL.vendedor).findOne({ _id: id_vendedor })) throw bad('El vendedor indicado no existe.');
  if (!await db.collection(COL.canal).findOne({ _id: canal_id })) throw bad('El canal indicado no existe.');
  const set = {}, campos = [];
  if (id_vendedor !== actual.id_vendedor) { set.id_vendedor = id_vendedor; campos.push('id_vendedor'); }
  if (canal_id !== actual.canal_id) { set.canal_id = canal_id; campos.push('canal_id'); }
  if (!campos.length) return res.json({ ok: true, message: 'No hubo cambios que guardar.' });
  await db.collection(COL.venta).updateOne({ _id: actual._id }, { $set: set });
  await auditVenta('UPDATE', `Doc ${actual._id} campos: ${campos.join(',')}`);
  res.json({ ok: true, message: `Venta ${actual._id} actualizada.` });
}));

app.delete('/api/ventas/:id', wrap(async (req, res) => {
  const v = await db.collection(COL.venta).findOne({ _id: req.params.id });
  if (!v) throw notFound('La venta no existe.');
  await db.collection(COL.venta).deleteOne({ _id: v._id });
  let restituido = false;
  if (v.sucursal_id != null) {
    for (const l of v.detalles || []) {
      const antes = await db.collection(COL.stock).findOneAndUpdate(sf(v.sucursal_id, l.codigo_producto), { $inc: { cantidad_stock: l.cantidad } }, { returnDocument: 'before' });
      if (antes) { restituido = true; await audit('STOCK_SUCURSAL', 'UPDATE', `SUC:${v.sucursal_id}|PROD:${l.codigo_producto}`, `Stock modificado. Anterior: ${antes.cantidad_stock} -> Nuevo: ${antes.cantidad_stock + l.cantidad}`); }
    }
  }
  await auditVenta('DELETE', `Doc ${v._id}`);
  res.json({ ok: true, message: `Venta ${v._id} eliminada${restituido ? ' y stock restituido' : ''}.` });
}));

//CRUD genérico: articulos, clientes, stock_sucursal, vendedores
app.get('/api/:res', wrap(async (req, res) => {
  const r = getRes(req);
  const q = String(req.query.q || '').trim();
  const filtro = q ? { $or: r.searchFields.map(f => ({ [dbPath(r, f)]: rxSafe(q) })) } : {};
  const data = await db.collection(r.collection).find(filtro).sort({ _id: 1 }).limit(500).toArray();
  res.json({ ok: true, data: data.map(d => fromDb(r, d)) });
}));

app.post('/api/:res', wrap(async (req, res) => {
  const r = getRes(req);
  const doc = coerce(r, req.body || {}, false);
  await checkRefs(r, doc);
  try { await db.collection(r.collection).insertOne(toDb(r, doc)); }
  catch (e) { if (e.code === 11000) throw new HttpError(409, `Ya existe un ${r.singular} con ese identificador.`); throw e; }
  await audit(r.collection, 'INSERT', r.idLabel(doc), `Registro creado: ${JSON.stringify(doc)}`);
  res.status(201).json({ ok: true, message: `${cap(r.singular)} ${r.idLabel(doc)} creado correctamente.` });
}));

app.put('/api/:res/:id', wrap(async (req, res) => {
  const r = getRes(req);
  const raw = await db.collection(r.collection).findOne({ _id: parseId(r, req.params.id) });
  if (!raw) throw notFound(`El ${r.singular} no existe.`);
  const actual = fromDb(r, raw);
  const cambios = coerce(r, req.body || {}, true);
  await checkRefs(r, { ...actual, ...cambios });
  const dif = Object.keys(cambios).filter(k => (actual[k] ?? null) !== cambios[k]);
  if (!dif.length) return res.json({ ok: true, message: 'No hubo cambios que guardar.' });
  await db.collection(r.collection).updateOne({ _id: raw._id }, { $set: cambios });
  const detalle = r.stockField && dif.includes(r.stockField)
    ? `Stock modificado. Anterior: ${actual[r.stockField]} -> Nuevo: ${cambios[r.stockField]}`
    : dif.map(k => `${k}: ${actual[k] ?? '∅'} -> ${cambios[k] ?? '∅'}`).join('; ');
  await audit(r.collection, 'UPDATE', r.idLabel(actual), detalle);
  res.json({ ok: true, message: `${cap(r.singular)} ${r.idLabel(actual)} actualizado correctamente.` });
}));

app.delete('/api/:res/:id', wrap(async (req, res) => {
  const r = getRes(req);
  const raw = await db.collection(r.collection).findOne({ _id: parseId(r, req.params.id) });
  if (!raw) throw notFound(`El ${r.singular} no existe.`);
  const actual = fromDb(r, raw);
  for (const u of r.usedBy || []) {
    if (await db.collection(u.collection).findOne(u.filter(actual))) throw new HttpError(409, `No se puede eliminar: el ${r.singular} ${r.idLabel(actual)} ${u.msg}.`);
  }
  await db.collection(r.collection).deleteOne({ _id: raw._id });
  await audit(r.collection, 'DELETE', r.idLabel(actual), `Registro eliminado: ${JSON.stringify(actual)}`);
  res.json({ ok: true, message: `${cap(r.singular)} ${r.idLabel(actual)} eliminado correctamente.` });
}));

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada.' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ ok: false, error: status === 500 ? 'Error interno: ' + err.message : err.message });
});

//Arranque
async function ensureCounters() {
  // Equivalente a seq_folio_boleta / seq_folio_factura. Si ya existe el contador (lo creó tu script mongosh) no se toca.
  for (const [id, prefijo, base] of [['seq_folio_boleta', 'BOL-', 1000], ['seq_folio_factura', 'FAC-', 5000]]) {
    const ids = await db.collection(COL.venta).find({ _id: new RegExp('^' + prefijo) }, { projection: { _id: 1 } }).toArray();
    const max = ids.reduce((m, d) => Math.max(m, parseInt(String(d._id).slice(4), 10) || 0), base);
    await db.collection(COL.contadores).updateOne({ _id: id }, { $setOnInsert: { seq: max } }, { upsert: true });
  }
}
(async () => {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  try { await client.connect(); }
  catch (e) {
    console.error(`\nNo se pudo conectar a MongoDB en ${MONGO_URI}\n${e.message}\nVerifica que MongoDB (o el contenedor Docker) esté en ejecución.\n`);
    process.exit(1);
  }
  db = client.db(DB_NAME);
  await ensureCounters();
  app.listen(PORT, () => console.log(`PetShop CRUD listo en http://localhost:${PORT}  (base: ${DB_NAME})`));
})();
