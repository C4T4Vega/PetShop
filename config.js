'use strict';

//Configuración del modelo NoSQL de PetShop.
const COL = {
  articulo: 'articulo',
  cliente: 'cliente',
  vendedor: 'vendedor',
  sucursal: 'sucursal',
  canal: 'canal',
  stock: 'stock_sucursal',
  venta: 'venta',
  auditoria: 'auditoria_tienda',
  contadores: 'counters',
  comuna: 'comunas',
  provincia: 'provincia',
  region: 'region'
};

const ESTADOS = ['Soltero/a', 'Casado/a', 'Viudo/a', 'Divorciado/a', 'Conviviente Civil'];

//Reglas de negocio
const IVA = 0.19;
const DESCUENTO_MINIMO = 50000;
const DESCUENTO_PCT = 0.10;
const COSTO_PCT = 0.6;

function calcularTotales(montoBruto) {
  const descuento = montoBruto >= DESCUENTO_MINIMO ? Math.round(montoBruto * DESCUENTO_PCT) : 0;
  const totalNeto = montoBruto - descuento;
  const impuesto = Math.round(totalNeto * IVA);
  return { descuento, totalNeto, impuesto, totalDocumento: totalNeto + impuesto };
}

//Recursos con CRUD genérico (la venta tiene lógica propia en server.js).
const RESOURCES = {
  articulos: {
    label: 'Artículos', singular: 'artículo', collection: COL.articulo, keyFields: ['codigo_producto'],
    idLabel: d => d.codigo_producto,
    searchFields: ['codigo_producto', 'nombre', 'marca', 'familia'],
    usedBy: [
      { collection: COL.venta, filter: d => ({ 'detalles.codigo_producto': d.codigo_producto }), msg: 'tiene ventas asociadas' },
      { collection: COL.stock, filter: d => ({ '_id.codigo_producto': d.codigo_producto }), msg: 'tiene registros de stock (elimínalos primero)' }
    ],
    fields: [
      { name: 'codigo_producto', label: 'Código', type: 'text', required: true },
      { name: 'nombre', label: 'Nombre', type: 'text', required: true },
      { name: 'marca', label: 'Marca', type: 'text', required: true },
      { name: 'familia', label: 'Familia', type: 'text' },
      { name: 'precio_base', label: 'Precio base', type: 'number', required: true, min: 0, money: true },
      { name: 'peso_valor', label: 'Peso / volumen', type: 'number', min: 0 },
      { name: 'unidad_medida', label: 'Unidad', type: 'select', options: ['KG', 'ML'] }
    ]
  },
  clientes: {
    label: 'Clientes', singular: 'cliente', collection: COL.cliente, keyFields: ['rut'],
    idLabel: d => d.rut,
    searchFields: ['rut', 'nombre', 'apellido', 'residencia'],
    usedBy: [{ collection: COL.venta, filter: d => ({ rut_cliente: d.rut }), msg: 'tiene ventas asociadas' }],
    fields: [
      { name: 'rut', label: 'RUT', type: 'text', required: true },
      { name: 'nombre', label: 'Nombre', type: 'text', required: true },
      { name: 'apellido', label: 'Apellido', type: 'text', required: true },
      { name: 'edad', label: 'Edad', type: 'number', int: true, min: 0 },
      { name: 'estado_civil', label: 'Estado civil', type: 'select', options: ESTADOS },
      { name: 'residencia', label: 'Residencia', type: 'text' }
    ]
  },
  stock_sucursal: {
    label: 'Stock', singular: 'registro de stock', collection: COL.stock, keyFields: ['sucursal_id', 'codigo_producto'],
    idLabel: d => `SUC:${d.sucursal_id}|PROD:${d.codigo_producto}`,
    searchFields: ['codigo_producto'],
    stockField: 'cantidad_stock',
    refs: [
      { field: 'sucursal_id', collection: COL.sucursal, msg: 'La sucursal indicada no existe.' },
      { field: 'codigo_producto', collection: COL.articulo, msg: 'El artículo indicado no existe.' }
    ],
    fields: [
      { name: 'sucursal_id', label: 'Sucursal', type: 'lookup', lookup: 'sucursales', numeric: true, required: true },
      { name: 'codigo_producto', label: 'Artículo', type: 'lookup', lookup: 'articulos', required: true },
      { name: 'cantidad_stock', label: 'Cantidad en stock', type: 'number', int: true, min: 0, required: true }
    ]
  },
  vendedores: {
    label: 'Vendedores', singular: 'vendedor', collection: COL.vendedor, keyFields: ['id_vendedor'],
    idLabel: d => String(d.id_vendedor),
    searchFields: ['nombre', 'apellidos'],
    usedBy: [{ collection: COL.venta, filter: d => ({ id_vendedor: d.id_vendedor }), msg: 'tiene ventas asociadas' }],
    refs: [{ field: 'sucursal_id', collection: COL.sucursal, msg: 'La sucursal indicada no existe.' }],
    fields: [
      { name: 'id_vendedor', label: 'ID vendedor', type: 'number', int: true, min: 1, required: true },
      { name: 'nombre', label: 'Nombre', type: 'text', required: true },
      { name: 'apellidos', label: 'Apellidos', type: 'text', required: true },
      { name: 'sueldo', label: 'Sueldo', type: 'number', min: 0, money: true },
      { name: 'sucursal_id', label: 'Sucursal', type: 'lookup', lookup: 'sucursales', numeric: true, required: true }
    ]
  }
};

module.exports = { COL, RESOURCES, calcularTotales, COSTO_PCT, IVA };
