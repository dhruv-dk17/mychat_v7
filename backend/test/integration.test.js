const request = require('supertest');
const { app } = require('../src/server');
const { pool } = require('../src/db/database');
const bcrypt = require('bcrypt');

jest.mock('../src/db/database', () => {
  return {
    pool: {
      query: jest.fn()
    },
    initDB: jest.fn(),
    ensureUserIdentityColumns: jest.fn()
  };
});

describe('Auth & Room APIs Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  describe('User Authentication', () => {
    it('registers a new user successfully', async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .post('/api/users/register')
        .send({
          username: 'testuser',
          passwordHash: validHash
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pool.query).toHaveBeenCalledTimes(1);
      
      // Check that the saved hash is a bcrypt hash, not plain text
      const dbCallArgs = pool.query.mock.calls[0];
      expect(dbCallArgs[1][1]).toMatch(/^\$2[abxy]\$\d+\$.+/);
    });

    it('logs in an existing user using a bcrypt hash', async () => {
      const hashedPass = await bcrypt.hash(validHash, 10);
      
      // Mock SELECT query returning the hash
      pool.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPass, username: 'testuser' }] });
      // Mock UPDATE query for new token
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .post('/api/users/login')
        .send({
          username: 'testuser',
          passwordHash: validHash
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
    });
    
    it('rejects login with invalid credentials', async () => {
      const hashedPass = await bcrypt.hash(validHash, 10);
      pool.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPass, username: 'testuser' }] });

      const invalidHash = 'bad3456789abcdefbad3456789abcdefbad3456789abcdefbad3456789abcdef';
      const res = await request(app)
        .post('/api/users/login')
        .send({
          username: 'testuser',
          passwordHash: invalidHash
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });
  });

  describe('Room Authentication', () => {
    it('registers a new room', async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app)
        .post('/api/rooms/register')
        .send({
          slug: 'testrm',
          passwordHash: validHash,
          ownerTokenHash: validHash
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.slug).toBe('testrm');
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('verifies room password successfully', async () => {
      const hashedPass = await bcrypt.hash(validHash, 10);
      pool.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPass }] });

      const res = await request(app)
        .post('/api/rooms/verify-password')
        .send({
          slug: 'testrm',
          passwordHash: validHash
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });
    
    it('rejects invalid room password', async () => {
      const hashedPass = await bcrypt.hash(validHash, 10);
      pool.query.mockResolvedValueOnce({ rows: [{ password_hash: hashedPass }] });

      const invalidHash = 'bad3456789abcdefbad3456789abcdefbad3456789abcdefbad3456789abcdef';
      const res = await request(app)
        .post('/api/rooms/verify-password')
        .send({
          slug: 'testrm',
          passwordHash: invalidHash
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });
  });
});
