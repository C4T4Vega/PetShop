use("PetShop");

const USUARIO = (() => {
  try {
    const u = db.runCommand({ connectionStatus: 1 }).authInfo.authenticatedUsers;
    return u.length ? u[0].user : "anonimo";
  } catch (e) { return "anonimo"; }
})();

// 1. COLECCIÓN auditoria_tienda (equivale a la tabla de auditoría)
if (!db.getCollectionNames().includes("auditoria_tienda")) {
  db.createCollection("auditoria_tienda", {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["nombre_tabla", "operacion", "usuario", "fecha_operacion", "id_registro", "detalle"],
        properties: {
          nombre_tabla:    { bsonType: "string" },
          operacion:       { enum: ["INSERT", "UPDATE", "DELETE"] },
          usuario:         { bsonType: "string" },
          fecha_operacion: { bsonType: "date" },
          id_registro:     { bsonType: "string" },
          detalle:         { bsonType: "string" }
        }
      }
    }
  });
}
db.auditoria_tienda.createIndex({ nombre_tabla: 1, fecha_operacion: -1 });

// _id (ObjectId) cumple el rol de id_auditoria
function auditar(tabla, operacion, idRegistro, detalle, extra) {
  return db.auditoria_tienda.insertOne(Object.assign({
    nombre_tabla: tabla,
    operacion: operacion,
    usuario: USUARIO,
    fecha_operacion: new Date(),
    id_registro: idRegistro,
    detalle: detalle
  }, extra || {})).insertedId;
}

// 2. CRUD stock_sucursal  (equivale al trigger a NIVEL DE FILA)
//    Solo audita el UPDATE si cantidad_stock realmente cambió.
const filtroStock = (s, p) => ({ "_id.sucursal_id": s, "_id.codigo_producto": p });
const idTxt = (s, p) => "SUC:" + s + "|PROD:" + p;

// CREATE
function crearStock(sucursalId, codigoProducto, cantidad) {
  if (!db.articulo.findOne({ _id: codigoProducto })) throw new Error("El producto " + codigoProducto + " no existe.");
  if (!db.sucursal.findOne({ _id: sucursalId })) throw new Error("La sucursal " + sucursalId + " no existe.");
  if (db.stock_sucursal.findOne(filtroStock(sucursalId, codigoProducto))) throw new Error("Ya existe stock para " + idTxt(sucursalId, codigoProducto));
  db.stock_sucursal.insertOne({ _id: { sucursal_id: sucursalId, codigo_producto: codigoProducto }, cantidad_stock: cantidad });
  auditar("STOCK_SUCURSAL", "INSERT", idTxt(sucursalId, codigoProducto), "Stock creado: " + cantidad);
}

// READ
function leerStock(sucursalId, codigoProducto) {
  return db.stock_sucursal.findOne(filtroStock(sucursalId, codigoProducto));
}

// UPDATE (el equivalente directo del trigger trg_auditoria_stock_row)
function actualizarStock(sucursalId, codigoProducto, nuevaCantidad) {
  const antes = leerStock(sucursalId, codigoProducto);
  if (!antes) throw new Error("No existe stock para " + idTxt(sucursalId, codigoProducto));
  if (antes.cantidad_stock === nuevaCantidad) { print("Sin cambios: no se audita."); return; }  // IF :OLD <> :NEW
  db.stock_sucursal.updateOne(filtroStock(sucursalId, codigoProducto), { $set: { cantidad_stock: nuevaCantidad } });
  auditar("STOCK_SUCURSAL", "UPDATE", idTxt(sucursalId, codigoProducto),
    "Stock modificado. Anterior: " + antes.cantidad_stock + " -> Nuevo: " + nuevaCantidad);
}

// DELETE
function eliminarStock(sucursalId, codigoProducto) {
  const antes = leerStock(sucursalId, codigoProducto);
  if (!antes) throw new Error("No existe stock para " + idTxt(sucursalId, codigoProducto));
  db.stock_sucursal.deleteOne(filtroStock(sucursalId, codigoProducto));
  auditar("STOCK_SUCURSAL", "DELETE", idTxt(sucursalId, codigoProducto), "Stock eliminado. Último valor: " + antes.cantidad_stock);
}

// 3. CRUD venta
//    Una entrada de auditoría por operación, id_registro = 'N/A'.
function auditarVentaStmt(operacion, detalleExtra) {
  auditar("VENTA", operacion, "N/A",
    "Ejecución de sentencia DML global (Statement Level) sobre la tabla VENTA" + (detalleExtra ? " | " + detalleExtra : ""));
}

// Reemplazo de seq_folio_boleta
function siguienteFolio() {
  if (!db.counters.findOne({ _id: "seq_folio_boleta" })) {
    const maxNum = db.venta.find({}, { _id: 1 }).toArray()
      .map(v => parseInt(String(v._id).replace(/\D/g, ""), 10) || 0)
      .reduce((a, b) => Math.max(a, b), 1000);
    db.counters.updateOne({ _id: "seq_folio_boleta" }, { $setOnInsert: { seq: maxNum } }, { upsert: true });
  }
  const r = db.counters.findOneAndUpdate({ _id: "seq_folio_boleta" }, { $inc: { seq: 1 } }, { returnDocument: "after" });
  return "BOL-" + r.seq;
}

// CREATE (port de pkg_ventas_petshop.registrar_venta)
function registrarVenta(rut, codigoProducto, cantidad, sucursalId = 1, idVendedor = 100, canalId = 1) {
  // Validaciones
  if (!db.cliente.findOne({ _id: rut })) throw new Error("El cliente con RUT " + rut + " no existe.");
  const stock = leerStock(sucursalId, codigoProducto);
  if (!stock) throw new Error("El producto no tiene registro de stock en la sucursal indicada.");
  if (stock.cantidad_stock < cantidad) throw new Error("Stock insuficiente. Disponible: " + stock.cantidad_stock);
  const art = db.articulo.findOne({ _id: codigoProducto });
  if (!art) throw new Error("El producto " + codigoProducto + " no existe.");

  // Cálculos
  const bruto = art.precio_base * cantidad;
  const descuento = bruto >= 50000 ? Math.round(bruto * 0.10) : 0;
  const neto = bruto - descuento;
  const impuesto = Math.round(neto * 0.19);
  const total = neto + impuesto;

  //1-.Descuento de stock
  const filtro = Object.assign({ cantidad_stock: { $gte: cantidad } }, filtroStock(sucursalId, codigoProducto));
  const upd = db.stock_sucursal.updateOne(filtro, { $inc: { cantidad_stock: -cantidad } });
  if (upd.modifiedCount !== 1) throw new Error("No se pudo descontar stock (cambió mientras se procesaba).");
  auditar("STOCK_SUCURSAL", "UPDATE", idTxt(sucursalId, codigoProducto),
    "Stock modificado. Anterior: " + stock.cantidad_stock + " -> Nuevo: " + (stock.cantidad_stock - cantidad));

  //2-.Inserción de la venta
  const numDoc = siguienteFolio();
  try {
    db.venta.insertOne({
      _id: numDoc,
      fecha: new Date(),
      tipo_documento: "Boleta",
      total_neto: neto,
      porcentaje_impuesto: 19,
      impuesto: impuesto,
      total_documento: total,
      rut_cliente: rut,
      id_vendedor: idVendedor,
      canal_id: canalId,
      detalles: [{
        codigo_producto: codigoProducto,
        precio_unitario: art.precio_base,
        cantidad: cantidad,
        total_linea: neto,
        costo_unitario: Math.round(art.precio_base * 0.6)
      }]
    });
  } catch (e) {
    // Rollback manual
    db.stock_sucursal.updateOne(filtroStock(sucursalId, codigoProducto), { $inc: { cantidad_stock: cantidad } });
    throw new Error("Error al procesar la transacción: " + e.message);
  }
  auditarVentaStmt("INSERT", "Doc " + numDoc);
  print("=== VENTA REGISTRADA EXITOSAMENTE ===\nDocumento Nro : " + numDoc + "\nMonto Total   : $" + total);
  return numDoc;
}

// READ
function leerVenta(numeroDocumento) { return db.venta.findOne({ _id: numeroDocumento }); }
function obtenerTotal(numeroDocumento) {// fn_obtener_total_venta
  const v = leerVenta(numeroDocumento);
  if (!v) throw new Error("El documento Nro " + numeroDocumento + " no existe.");
  return v.total_documento;
}
function totalAcumuladoVentas() {// fn_total_acumulado_ventas
  const r = db.venta.aggregate([{ $group: { _id: null, total: { $sum: "$total_documento" } } }]).toArray();
  return r.length ? r[0].total : 0;
}

// UPDATE (solo campos administrativos; los montos no se tocan)
function actualizarVenta(numeroDocumento, cambios) {
  const permitidos = ["id_vendedor", "canal_id", "rut_cliente"];
  const set = {};
  Object.keys(cambios).forEach(k => { if (permitidos.includes(k)) set[k] = cambios[k]; });
  if (!Object.keys(set).length) throw new Error("Campos permitidos: " + permitidos.join(", "));
  const r = db.venta.updateOne({ _id: numeroDocumento }, { $set: set });
  if (r.matchedCount === 0) throw new Error("El documento Nro " + numeroDocumento + " no existe.");
  auditarVentaStmt("UPDATE", "Doc " + numeroDocumento + " campos: " + Object.keys(set).join(","));
}

// DELETE
function eliminarVenta(numeroDocumento) {
  const r = db.venta.deleteOne({ _id: numeroDocumento });
  if (r.deletedCount === 0) throw new Error("El documento Nro " + numeroDocumento + " no existe.");
  auditarVentaStmt("DELETE", "Doc " + numeroDocumento);
}

// 4. PRUEBAS 

// 4.1 Consultar stock
printjson(leerStock(1, "14547"));

// 4.2 Actualizar stock a 40 -> genera auditoría
actualizarStock(1, "14547", 40);

// 4.3 Repetir mismo valor -> NO genera auditoría (condición de control)
actualizarStock(1, "14547", 40);

// 4.4 Registrar una venta (audita VENTA + STOCK_SUCURSAL)
registrarVenta("17894561-2", "14547", 2, 1);

// 4.5 Ver la auditoría (más reciente primero)
db.auditoria_tienda.find({ nombre_tabla: "STOCK_SUCURSAL" }).sort({ fecha_operacion: -1 }).forEach(printjson);
db.auditoria_tienda.find({ nombre_tabla: "VENTA" }).sort({ fecha_operacion: -1 }).forEach(printjson);
print("Filas de auditoría STOCK_SUCURSAL: " + db.auditoria_tienda.countDocuments({ nombre_tabla: "STOCK_SUCURSAL" }));

// 4.6 Total de una boleta y total histórico
print("BOL-1001 = " + obtenerTotal("BOL-1001"));
print("Total histórico = " + totalAcumuladoVentas());
