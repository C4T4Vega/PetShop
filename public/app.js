const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, ''); else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
const clp = n => '$' + Number(n || 0).toLocaleString('es-CL');
const fecha = d => new Date(d).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || 'Error inesperado del servidor.');
  return j;
}
function toast(msg, kind = 'ok') {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'ok' ? 4000 : 7000);
}

let meta, lookups, view = 'dashboard';
const labelOf = (list, v) => (lookups[list].find(x => String(x.value) === String(v)) || {}).label ?? v;
const VIEWS = ['dashboard', 'ventas', 'articulos', 'clientes', 'stock_sucursal', 'vendedores', 'auditoria'];
const viewLabel = v => ({ dashboard: 'Dashboard', ventas: 'Ventas', auditoria: 'Auditoría' }[v] || meta.resources[v].label);

//diálogo
const dlg = $('#dlg');
function openDialog(title, body, onSubmit, okLabel = 'Guardar') {
  $('#dtitle').textContent = title; $('#dbody').replaceChildren(body); $('#ferr').textContent = '';
  $('#dok').hidden = !onSubmit; $('#dok').textContent = okLabel;
  $('#frm').onsubmit = async e => {
    e.preventDefault(); if (!onSubmit) return;
    $('#dok').disabled = true;
    try { const msg = await onSubmit(); dlg.close(); toast(msg); await refresh(true); }
    catch (err) { $('#ferr').textContent = err.message; toast(err.message, 'err'); }
    finally { $('#dok').disabled = false; }
  };
  dlg.showModal();
}
$('#dcancel').onclick = () => dlg.close();

function fieldInput(f, value, disabled) {
  let inp;
  if (f.type === 'select') inp = el('select', { name: f.name, disabled }, el('option', { value: '' }, '—'), f.options.map(o => el('option', { value: o }, o)));
  else if (f.type === 'lookup') inp = el('select', { name: f.name, disabled }, el('option', { value: '' }, 'Selecciona…'), lookups[f.lookup].map(o => el('option', { value: o.value }, o.label)));
  else inp = el('input', { name: f.name, type: f.type === 'number' ? 'number' : 'text', step: f.type === 'number' && !f.int ? 'any' : '1', min: f.min, disabled, autocomplete: 'off' });
  if (value != null) inp.value = value;
  return el('div', { class: 'field' }, el('label', {}, f.label + (f.required ? ' *' : '')), inp);
}
const formData = root => Object.fromEntries([...root.querySelectorAll('[name]')].map(i => [i.name, i.value]));

//tabla
function renderTable(cols, rows) {
  const tbl = $('#tbl');
  $('#empty').hidden = rows.length > 0;
  $('.tabla-scroll').hidden = rows.length === 0;
  tbl.replaceChildren(
    el('thead', {}, el('tr', {}, cols.map(c => el('th', { class: c.num ? 'num' : '' }, c.label)))),
    el('tbody', {}, rows.map(r => el('tr', {}, cols.map(c => el('td', { class: c.num ? 'num' : '' }, c.act ? el('div', { class: 'fila-acciones' }, c.get(r)) : c.get(r)))))));
}

async function refresh(withLookups) {
  if (withLookups) lookups = await api('/api/lookups');
  const q = encodeURIComponent($('#q').value.trim());
  const dash = view === 'dashboard';
  $('#dash').hidden = !dash; $('#listPanel').hidden = dash;
  $('#add').hidden = view === 'auditoria'; $('#q').hidden = view === 'auditoria'; $('#tablaFiltro').hidden = view !== 'auditoria';
  $('#title').textContent = dash ? 'Panel de control' : viewLabel(view);
  try {
    if (dash) return await viewDashboard();
    if (view === 'ventas') return viewVentas((await api('/api/ventas?q=' + q)).data);
    if (view === 'auditoria') return viewAuditoria((await api('/api/auditoria?tabla=' + encodeURIComponent($('#tablaFiltro').value))).data);
    viewGeneric((await api(`/api/${view}?q=${q}`)).data);
  } catch (e) { toast(e.message, 'err'); }
  status();
}

//CRUD genérico
function viewGeneric(rows) {
  const r = meta.resources[view];
  const cols = r.fields.map(f => ({
    label: f.label, num: f.type === 'number',
    get: row => {
      const v = row[f.name];
      if (v == null || v === '') return '—';
      if (f.type === 'lookup' && f.lookup === 'sucursales') return labelOf('sucursales', v);
      if (f.name === 'cantidad_stock') return v <= 10 ? el('span', { class: 'stock-bajo' }, String(v)) : String(v);
      return f.money ? clp(v) : String(v);
    }
  }));
  cols.push({ label: '', act: true, get: row => [
    el('button', { class: 'accion-editar', onclick: () => formGeneric(r, row) }, 'Editar'),
    el('button', { class: 'accion-eliminar', onclick: () => borrar(r, row) }, 'Eliminar')] });
  renderTable(cols, rows);
}
function formGeneric(r, row) {
  const editing = !!row, immut = editing ? (r.immutable || []) : [];
  const body = el('div', {}, r.fields.map(f => fieldInput(f, row && row[f.name], immut.includes(f.name) || (editing && ['sucursal_id','codigo_producto'].includes(f.name) && view === 'stock_sucursal'))));
  openDialog(editing ? `Editar ${r.singular}` : `Nuevo ${r.singular}`, body, async () => {
    const d = formData(body);
    return (await api(editing ? `/api/${view}/${encodeURIComponent(row.id)}` : `/api/${view}`, editing ? 'PUT' : 'POST', d)).message;
  });
}
async function borrar(r, row) {
  if (!confirm(`¿Eliminar este ${r.singular}? Esta acción borra el documento en MongoDB.`)) return;
  try { toast((await api(`/api/${view}/${encodeURIComponent(row.id)}`, 'DELETE')).message); await refresh(true); } catch (e) { toast(e.message, 'err'); }
}

//Ventas 
function viewVentas(rows) {
  renderTable([
    { label: 'Folio', get: v => v.numero_documento }, { label: 'Fecha', get: v => fecha(v.fecha) },
    { label: 'Cliente', get: v => labelOf('clientes', v.rut_cliente) }, { label: 'Canal', get: v => labelOf('canales', v.canal_id) },
    { label: 'Ítems', num: true, get: v => String((v.detalles || []).reduce((s, l) => s + l.cantidad, 0)) },
    { label: 'Total', num: true, get: v => clp(v.total_documento) },
    { label: '', act: true, get: v => [
      el('button', { class: 'accion-editar', onclick: () => detalleVenta(v) }, 'Detalle'),
      el('button', { class: 'accion-editar', onclick: () => editarVenta(v) }, 'Editar'),
      el('button', { class: 'accion-eliminar', onclick: () => borrarVenta(v) }, 'Eliminar')] }
  ], rows);
}
function detalleVenta(v) {
  const t = el('table', { class: 'admin-tabla', style: 'min-width:0' }, el('thead', {}, el('tr', {}, ['Producto', 'Cant.', 'Precio', 'Total'].map(h => el('th', {}, h)))),
    el('tbody', {}, v.detalles.map(l => el('tr', {}, el('td', {}, l.nombre || labelOf('articulos', l.codigo_producto)), el('td', {}, l.cantidad), el('td', {}, clp(l.precio_unitario)), el('td', {}, clp(l.total_linea))))));
  const filas = [];
  if (v.monto_bruto != null) filas.push(['Monto bruto', clp(v.monto_bruto)], ['Descuento', '-' + clp(v.descuento)]);
  filas.push(['Neto', clp(v.total_neto)], [`IVA ${v.porcentaje_impuesto}%`, clp(v.impuesto)]);
  const sum = el('div', { class: 'sum' }, filas.map(([a, b]) => el('div', {}, el('span', {}, a), el('span', {}, b))),
    el('div', { class: 'tot' }, el('span', {}, 'Total'), el('span', {}, clp(v.total_documento))));
  if (!v.detalles.length) t.after(el('p', { class: 'nota', style: 'padding:10px 4px' }, 'Esta venta no tiene líneas de detalle registradas.'));
  openDialog(`${v.tipo_documento} ${v.numero_documento}`, el('div', {}, el('div', { class: 'tabla-scroll' }, t), sum), null);
}
function selectOf(name, list, value, extra = {}) {
  const s = el('select', { name, ...extra }, el('option', { value: '' }, 'Selecciona…'), lookups[list].map(o => el('option', { value: o.value }, o.label)));
  if (value != null) s.value = value; return s;
}
const wrapField = (label, ctl) => el('div', { class: 'field' }, el('label', {}, label), ctl);

function editarVenta(v) {
  const body = el('div', {}, wrapField('Vendedor', selectOf('id_vendedor', 'vendedores', v.id_vendedor)), wrapField('Canal', selectOf('canal_id', 'canales', v.canal_id)),
    el('p', { class: 'nota' }, 'Los montos y productos de una venta emitida no se modifican; para corregirlos, elimina la venta (el stock se restituye) y regístrala de nuevo.'));
  openDialog(`Editar ${v.numero_documento}`, body, async () => (await api('/api/ventas/' + encodeURIComponent(v.id), 'PUT', formData(body))).message);
}
async function borrarVenta(v) {
  if (!confirm(`¿Eliminar ${v.numero_documento}? Se devolverá el stock a la sucursal.`)) return;
  try { toast((await api('/api/ventas/' + encodeURIComponent(v.id), 'DELETE')).message); await refresh(true); } catch (e) { toast(e.message, 'err'); }
}
function nuevaVenta() {
  const lines = el('div', { class: 'lines' }), sum = el('div', { class: 'sum' });
  const calc = () => {
    let bruto = 0;
    lines.querySelectorAll('.row').forEach(r => {
      const a = lookups.articulos.find(x => x.value === r.querySelector('select').value); const q = Number(r.querySelector('input').value);
      if (a && q > 0) bruto += a.precio * q;
    });
    const desc = bruto >= 50000 ? Math.round(bruto * 0.10) : 0, neto = bruto - desc, iva = Math.round(neto * meta.iva);
    sum.replaceChildren(...[['Monto bruto', clp(bruto)], ['Descuento 10% (desde $50.000)', '-' + clp(desc)], ['IVA 19%', clp(iva)]].map(([a, b]) => el('div', {}, el('span', {}, a), el('span', {}, b))),
      el('div', { class: 'tot' }, el('span', {}, 'Total'), el('span', {}, clp(neto + iva))));
  };
  const addLine = () => {
    const row = el('div', { class: 'row' }, selectOf('p', 'articulos', null, { required: true, onchange: calc }),
      el('input', { type: 'number', min: 1, step: 1, value: 1, 'aria-label': 'Cantidad', oninput: calc }),
      el('button', { type: 'button', class: 'accion-editar', onclick: () => { if (lines.children.length > 1) { row.remove(); calc(); } } }, 'Quitar'));
    lines.append(row);
  };
  addLine();
  const body = el('div', {},
    wrapField('Cliente *', selectOf('rut_cliente', 'clientes', null)), wrapField('Sucursal *', selectOf('sucursal_id', 'sucursales', null)),
    wrapField('Vendedor *', selectOf('id_vendedor', 'vendedores', null)), wrapField('Canal *', selectOf('canal_id', 'canales', null)),
    wrapField('Tipo de documento', el('select', { name: 'tipo_documento' }, el('option', {}, 'Boleta'), el('option', {}, 'Factura'))),
    el('div', { class: 'field' }, el('label', {}, 'Productos *'), lines, el('div', {}, el('button', { type: 'button', class: 'accion-editar', onclick: addLine }, '+ Agregar producto'))), sum);
  calc();
  openDialog('Registrar venta', body, async () => {
    const d = formData(body);
    d.detalle = [...lines.querySelectorAll('.row')].map(r => ({ codigo_producto: r.querySelector('select').value, cantidad: r.querySelector('input').value }));
    return (await api('/api/ventas', 'POST', d)).message;
  }, 'Registrar venta');
}

//Auditoría
function viewAuditoria(rows) {
  renderTable([
    { label: 'Fecha', get: a => fecha(a.fecha_operacion) }, { label: 'Tabla', get: a => a.nombre_tabla },
    { label: 'Operación', get: a => el('span', { class: 'badge-rol ' + a.operacion }, a.operacion) },
    { label: 'Usuario', get: a => a.usuario }, { label: 'Registro', get: a => a.id_registro }, { label: 'Detalle', get: a => a.detalle }
  ], rows);
}


//Dashboard
async function viewDashboard() {
  const [vs, st, ar, cl, au] = await Promise.all([api('/api/ventas'), api('/api/stock_sucursal'), api('/api/articulos'), api('/api/clientes'), api('/api/auditoria')]);
  const criticos = st.data.filter(s => s.cantidad_stock <= 10).sort((a, b) => a.cantidad_stock - b.cantidad_stock);
  const total = vs.data.reduce((s, v) => s + (v.total_documento || 0), 0);
  const card = (valor, etiqueta, alerta) => el('article', { class: 'admin-card' + (alerta ? ' alerta' : '') }, el('div', { class: 'valor' }, String(valor)), el('div', { class: 'etiqueta' }, etiqueta));
  $('#dash').replaceChildren(
    el('div', { class: 'admin-cards' }, card(vs.data.length, 'Ventas registradas'), card(clp(total), 'Total histórico de ventas'), card(ar.data.length, 'Artículos en catálogo'),
      card(cl.data.length, 'Clientes'), card(criticos.length, 'Registros con stock crítico (≤ 10)', criticos.length > 0)),
    el('section', { class: 'admin-panel' }, el('h3', {}, 'Alertas de stock crítico'),
      criticos.length ? el('ul', {}, criticos.map(s => el('li', {}, `${labelOf('articulos', s.codigo_producto)} — ${labelOf('sucursales', s.sucursal_id)}: ${s.cantidad_stock} unidades`)))
        : el('p', { class: 'nota' }, 'No hay productos con stock crítico por el momento.')),
    el('section', { class: 'admin-panel' }, el('h3', {}, 'Últimos movimientos de auditoría'),
      au.data.length ? el('ul', { class: 'ok' }, au.data.slice(0, 6).map(a => el('li', {}, `${fecha(a.fecha_operacion)} · ${a.nombre_tabla} ${a.operacion} · ${a.id_registro} — ${a.detalle}`)))
        : el('p', { class: 'nota' }, 'Aún no hay movimientos registrados.')));
  status();
}

//Arranque
async function status() {
  try { const h = await api('/api/health'); $('#status').replaceChildren('Conectado a MongoDB · base ', el('b', {}, h.db)); }
  catch (e) { $('#status').textContent = 'Sin conexión con el servidor'; }
}
function go(v) {
  view = v; $('#q').value = ''; location.hash = v;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.v === v));
  refresh(true);
}
$('#add').onclick = () => view === 'ventas' ? nuevaVenta() : formGeneric(meta.resources[view], null);
$('#refresh').onclick = () => refresh(true);
$('#tablaFiltro').onchange = () => refresh();
let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(() => refresh(), 250); };

(async () => {
  try {
    meta = await api('/api/meta'); lookups = await api('/api/lookups');
    $('#tabs').replaceChildren(...VIEWS.map(v => el('a', { href: '#' + v, 'data-v': v, onclick: e => { e.preventDefault(); go(v); } }, viewLabel(v))));
    go(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard');
  } catch (e) { $('#status').textContent = 'Error: ' + e.message; toast(e.message, 'err'); }
})();
