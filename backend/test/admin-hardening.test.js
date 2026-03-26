const assert = require('node:assert/strict');

const adminRoute = require('../src/routes/admin');
const { ensureUserIdentityColumns } = require('../src/db/database');

const helpers = adminRoute._test;

async function run(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

async function main() {
  await run('parseAdminUid accepts the admin uid formats we support', async () => {
    assert.equal(helpers.parseAdminUid('u42'), 42);
    assert.equal(helpers.parseAdminUid('42'), 42);
    assert.equal(helpers.parseAdminUid(' U7 '), 7);
    assert.equal(helpers.parseAdminUid('abc'), null);
    assert.equal(helpers.parseAdminUid('u0'), null);
  });

  await run('deleteAdminUser runs inside a transaction and commits on success', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        const normalized = sql.trim().replace(/\s+/g, ' ');
        calls.push({ sql: normalized, params: params || [] });

        if (/^UPDATE users/i.test(normalized)) {
          return { rows: [{ username: 'alice' }] };
        }
        if (/^DELETE FROM rooms/i.test(normalized)) {
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
      release() {
        calls.push({ sql: 'RELEASE', params: [] });
      },
    };

    await helpers.deleteAdminUser({ connect: async () => client }, 17);

    assert.deepEqual(calls.map(call => call.sql), [
      'BEGIN',
      'UPDATE users SET is_deleted = TRUE, token = NULL WHERE internal_id = $1 AND is_deleted = FALSE RETURNING username',
      'DELETE FROM rooms WHERE owner_username = $1',
      'COMMIT',
      'RELEASE',
    ]);
    assert.deepEqual(calls[1].params, [17]);
    assert.deepEqual(calls[2].params, ['alice']);
  });

  await run('deleteAdminUser rolls back if room cleanup fails', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        const normalized = sql.trim().replace(/\s+/g, ' ');
        calls.push({ sql: normalized, params: params || [] });

        if (/^UPDATE users/i.test(normalized)) {
          return { rows: [{ username: 'alice' }] };
        }
        if (/^DELETE FROM rooms/i.test(normalized)) {
          throw new Error('room cleanup failed');
        }
        return { rows: [] };
      },
      release() {
        calls.push({ sql: 'RELEASE', params: [] });
      },
    };

    await assert.rejects(
      helpers.deleteAdminUser({ connect: async () => client }, 17),
      /room cleanup failed/
    );

    assert(calls.some(call => call.sql === 'ROLLBACK'));
    assert.equal(calls[calls.length - 1].sql, 'RELEASE');
  });

  await run('ensureUserIdentityColumns backfills legacy users and sets the sequence', async () => {
    const calls = [];
    const existingColumns = new Set();
    const client = {
      async query(sql, params) {
        const normalized = sql.trim().replace(/\s+/g, ' ');
        calls.push({ sql: normalized, params: params || [] });

        if (normalized.includes('information_schema.columns')) {
          const [, columnName] = params;
          return { rows: existingColumns.has(columnName) ? [{}] : [] };
        }

        if (normalized.includes('MAX(internal_id)')) {
          return { rows: [{ max_internal_id: 41 }] };
        }

        return { rows: [] };
      },
    };

    await ensureUserIdentityColumns(client);

    assert(calls.some(call => call.sql === 'ALTER TABLE users ADD COLUMN internal_id INTEGER'));
    assert(calls.some(call => call.sql === 'CREATE SEQUENCE IF NOT EXISTS users_internal_id_seq'));
    assert(calls.some(call => call.sql === 'UPDATE users SET internal_id = nextval(\'users_internal_id_seq\') WHERE internal_id IS NULL'));
    const setvalCall = calls.find(call => call.sql.startsWith('SELECT setval('));
    assert.deepEqual(setvalCall.params, [42]);
  });

  await run('parseOptionalTimestamp accepts numeric or date inputs and rejects bad values', async () => {
    assert.equal(helpers.parseOptionalTimestamp(1234), 1234);
    assert.equal(helpers.parseOptionalTimestamp('1234'), 1234);
    assert.equal(helpers.parseOptionalTimestamp('2026-03-26T00:00:00Z'), Date.parse('2026-03-26T00:00:00Z'));
    assert.equal(helpers.parseOptionalTimestamp('nope'), null);
  });

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
