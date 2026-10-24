// node scripts/migrate.js up | down [steps] | status
import 'dotenv/config';
import { migrate, migrateDown, migrationStatus, closeDb } from '../src/db.js';

const [cmd = 'status', arg] = process.argv.slice(2);
try {
  if (cmd === 'up') await migrate();
  else if (cmd === 'down') await migrateDown(Number(arg || 1));
  else console.table(await migrationStatus());
} finally { await closeDb(); }
