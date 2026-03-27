const adminRoute = require('../src/routes/admin');
const { ensureUserIdentityColumns } = require('../src/db/database');

const helpers = adminRoute._test;

describe('Admin Hardening', () => {
  it('parseAdminUid accepts the admin uid formats we support', () => {
    expect(helpers.parseAdminUid('u42')).toBe(42);
    expect(helpers.parseAdminUid('42')).toBe(42);
    expect(helpers.parseAdminUid(' U7 ')).toBe(7);
    expect(helpers.parseAdminUid('abc')).toBe(null);
    expect(helpers.parseAdminUid('u0')).toBe(null);
  });

  it('deleteAdminUser runs inside a transaction and commits on success', async () => {
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

    expect(calls.map(call => call.sql)).toEqual([
      'BEGIN',
      'UPDATE users SET is_deleted = TRUE, token = NULL WHERE internal_id = $1 AND is_deleted = FALSE RETURNING username',
      'DELETE FROM rooms WHERE owner_username = $1',
      'COMMIT',
      'RELEASE',
    ]);
    expect(calls[1].params).toEqual([17]);
    expect(calls[2].params).toEqual(['alice']);
  });

  it('deleteAdminUser rolls back if room cleanup fails', async () => {
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

    await expect(helpers.deleteAdminUser({ connect: async () => client }, 17))
      .rejects.toThrow('room cleanup failed');

    expect(calls.some(call => call.sql === 'ROLLBACK')).toBe(true);
    expect(calls[calls.length - 1].sql).toBe('RELEASE');
  });

  it('ensureUserIdentityColumns backfills legacy users and sets the sequence', async () => {
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

    expect(calls.some(call => call.sql === 'ALTER TABLE users ADD COLUMN internal_id INTEGER')).toBe(true);
    expect(calls.some(call => call.sql === 'CREATE SEQUENCE IF NOT EXISTS users_internal_id_seq')).toBe(true);
    expect(calls.some(call => call.sql === 'UPDATE users SET internal_id = nextval(\'users_internal_id_seq\') WHERE internal_id IS NULL')).toBe(true);
    const setvalCall = calls.find(call => call.sql.startsWith('SELECT setval('));
    expect(setvalCall.params).toEqual([42]);
  });

  it('parseOptionalTimestamp accepts numeric or date inputs and rejects bad values', () => {
    expect(helpers.parseOptionalTimestamp(1234)).toBe(1234);
    expect(helpers.parseOptionalTimestamp('1234')).toBe(1234);
    expect(helpers.parseOptionalTimestamp('2026-03-26T00:00:00Z')).toBe(Date.parse('2026-03-26T00:00:00Z'));
    expect(helpers.parseOptionalTimestamp('nope')).toBe(null);
  });
});
