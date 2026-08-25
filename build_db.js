const Database=require('better-sqlite3');
global.window={};require('./seed.js');
const db=new Database('freight.db');
db.exec('DROP TABLE IF EXISTS shipments;DROP TABLE IF EXISTS quotes;DROP TABLE IF EXISTS invoices;');
db.exec(window.FREIGHT_SEED_SQL);
console.log('freight.db built:',db.prepare('SELECT COUNT(*) c FROM shipments').get().c,'shipments');
db.close();
