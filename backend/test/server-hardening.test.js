const { _test } = require('../src/server');

describe('Server hardening', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowedOrigin = process.env.ALLOWED_ORIGIN;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAllowedOrigin === undefined) {
      delete process.env.ALLOWED_ORIGIN;
    } else {
      process.env.ALLOWED_ORIGIN = originalAllowedOrigin;
    }
  });

  it('only allows explicitly configured origins in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGIN = 'https://app.example.com,https://admin.example.com';

    expect(_test.isAllowedCorsOrigin('https://app.example.com')).toBe(true);
    expect(_test.isAllowedCorsOrigin('https://admin.example.com')).toBe(true);
    expect(_test.isAllowedCorsOrigin('http://localhost:3000')).toBe(false);
    expect(_test.isAllowedCorsOrigin('https://team.onrender.com')).toBe(false);
    expect(_test.isAllowedCorsOrigin('null')).toBe(false);
    expect(_test.isAllowedCorsOrigin(null)).toBe(true);
  });

  it('skips the global rate limit for health endpoints', () => {
    expect(_test.shouldSkipGlobalRateLimit({ path: '/api/health' })).toBe(true);
    expect(_test.shouldSkipGlobalRateLimit({ originalUrl: '/api/health/metrics' })).toBe(true);
    expect(_test.shouldSkipGlobalRateLimit({ path: '/api/users' })).toBe(false);
  });
});
