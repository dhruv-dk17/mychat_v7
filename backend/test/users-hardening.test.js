const request = require('supertest');

jest.mock('../src/db/database', () => {
  return {
    pool: {
      query: jest.fn(),
      connect: jest.fn()
    },
    initDB: jest.fn(),
    ensureUserIdentityColumns: jest.fn()
  };
});

const { app } = require('../src/server');
const { pool } = require('../src/db/database');

describe('User hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const token = 'a'.repeat(64);

  it('deletes an account using auth headers inside a transaction', async () => {
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
      }
    };

    pool.connect.mockResolvedValue(client);

    const res = await request(app)
      .delete('/api/users/account')
      .set('X-Auth-Username', 'Alice')
      .set('X-Auth-Token', token);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(calls.map(call => call.sql)).toEqual([
      'BEGIN',
      'UPDATE users SET is_deleted = TRUE, token = NULL WHERE username = $1 AND token = $2 AND is_deleted = FALSE RETURNING username',
      'DELETE FROM rooms WHERE owner_username = $1',
      'COMMIT',
      'RELEASE'
    ]);
    expect(calls[1].params).toEqual(['alice', token]);
    expect(calls[2].params).toEqual(['alice']);
  });

  it('rejects query-string auth for account deletion', async () => {
    const res = await request(app)
      .delete(`/api/users/account?username=alice&token=${token}`);

    expect(res.status).toBe(401);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('fetches platform messages using auth headers', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ internal_id: 7 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            content: 'Important notice',
            created_at: 123
          }
        ]
      });

    const res = await request(app)
      .get('/api/users/messages')
      .set('X-Auth-Username', 'Alice')
      .set('X-Auth-Token', token);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messages).toHaveLength(1);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      'SELECT username, internal_id FROM users WHERE username = $1 AND token = $2 AND is_deleted = FALSE',
      ['alice', token]
    );
    expect(pool.query.mock.calls[1][0]).toContain('FROM platform_messages');
    expect(pool.query.mock.calls[1][1][0]).toBe(7);
  });

  it('rejects query-string auth for platform messages', async () => {
    const res = await request(app)
      .get(`/api/users/messages?username=alice&token=${token}`);

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
