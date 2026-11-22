'use strict';
/**
 * Importa el export de Compass (carpeta data/, formato Extended JSON) a MongoDB.
 *   node seed.js           -> solo carga las colecciones que estén vacías
 *   node seed.js --reset   -> borra y recarga las colecciones del export
 */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'PetShop';
const RESET = process.argv.includes('--reset');

(async () => {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(DB_NAME);
  const dir = path.join(__dirname, 'data');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const name = file.replace(/^PetShop\./, '').replace(/\.json$/, '');
    const docs = EJSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const c = db.collection(name);
    if (RESET) await c.deleteMany({});
    if (await c.estimatedDocumentCount() > 0) { console.log(`= ${name}: ya tiene datos, se omite (usa --reset para recargar)`); continue; }
    if (docs.length) await c.insertMany(docs);
    console.log(`+ ${name}: ${docs.length} documentos`);
  }
  if (RESET) await db.collection('counters').deleteMany({});
  await client.close();
  console.log('Listo. Inicia la web con: npm start');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
