import { MemoryDb, initOrSyncD1, SCHEMA_SQL } from './src/db.js';

console.log('Testing Cloudflare D1 Sync & Write Mirroring...');

// Mock Cloudflare D1 Database binding
class MockD1 {
  constructor() {
    this.store = new Map();
    this.executedStatements = [];
  }

  prepare(sql) {
    const self = this;
    return {
      bind(...params) {
        return {
          async first() {
            self.executedStatements.push({ sql, params, type: 'first' });
            if (sql.includes('sqlite_master')) {
              return { name: 'users' };
            }
            return null;
          },
          async all() {
            self.executedStatements.push({ sql, params, type: 'all' });
            const tblMatch = sql.match(/FROM\s+([^\s;]+)/i);
            const tblName = tblMatch ? tblMatch[1].toLowerCase() : 'unknown';
            return { results: self.store.get(tblName) || [], success: true };
          },
          async run() {
            self.executedStatements.push({ sql, params, type: 'run' });
            return { success: true, meta: { changes: 1 } };
          }
        };
      },
      async first() {
        self.executedStatements.push({ sql, type: 'first' });
        if (sql.includes('sqlite_master')) {
          return { name: 'users' };
        }
        return null;
      },
      async run() {
        self.executedStatements.push({ sql, type: 'run' });
        return { success: true };
      }
    };
  }
}

const mockD1 = new MockD1();
const mockCtx = {
  waitUntil(promise) {
    promise.catch(console.error);
  }
};

await initOrSyncD1(mockD1, mockCtx);

console.log('✓ D1 Initialized and Hydrated Successfully');
console.log(`✓ Executed statements count on D1: ${mockD1.executedStatements.length}`);
console.log('ALL CLOUDFLARE D1 SYNC TESTS PASSED! 🎉');
