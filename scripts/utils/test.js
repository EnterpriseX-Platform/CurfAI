const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const Database = require('better-sqlite3');

async function run() {
  const ds = await prisma.dataSource.findUnique({ where: { id: 'cmriney4v000gqjhvbtq4v0yp' } });
  const db = new Database(ds.connection);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(tables.map(t => t.name));
}
run();
