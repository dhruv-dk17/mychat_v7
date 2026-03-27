const startedAt = Date.now();
const counters = new Map();

function incrementMetric(name, value = 1) {
  counters.set(name, (counters.get(name) || 0) + value);
}

function getMetricsSnapshot() {
  const snapshot = Object.fromEntries(counters.entries());
  snapshot.uptimeMs = Date.now() - startedAt;
  snapshot.startedAt = startedAt;
  return snapshot;
}

function metricsMiddleware(req, res, next) {
  incrementMetric('http.requests.total');
  const start = Date.now();
  res.on('finish', () => {
    incrementMetric(`http.responses.${res.statusCode}`);
    incrementMetric(`http.routes.${req.method}.${req.path}`);
    incrementMetric('http.responseTime.totalMs', Date.now() - start);
  });
  next();
}

module.exports = {
  getMetricsSnapshot,
  incrementMetric,
  metricsMiddleware
};
