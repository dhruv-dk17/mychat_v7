const { initDB } = require('./src/db/database');
const logger = require('./src/lib/logger');

async function test() {
  console.log('Testing DB init...');
  try {
    await initDB();
    console.log('DB init passed (as expected with catch)');
  } catch (err) {
    console.error('DB init failed:', err);
  }
  console.log('Testing server require...');
  try {
    const { app } = require('./src/server.js');
    console.log('Server require passed');
  } catch (err) {
    console.error('Server require failed:', err);
  }
}

test();
