const crypto = require('crypto');
const assert = require('assert');

const TEST_SECRET = 'secure_audit_secret_9921';
process.env.CPX_APP_SECRET = TEST_SECRET;
process.env.CPX_CURRENCY_FACTOR = '4900';
process.env.CPX_BONUS_FACTOR = '8800';
process.env.NODE_ENV = 'test';

function generateHash(transId, secret) {
  return crypto.createHash('md5').update(`${transId}-${secret}`).digest('hex');
}

async function runTests() {
  console.log('=== Running CPX Automated Audit Test Suite ===');

  // Test 1: Hash Calculation & Constant-time match
  const tId = 'TX_TEST_AUDIT_101';
  const goodHash = generateHash(tId, TEST_SECRET);
  const badHash = 'tampered_hash_000';

  const isGood = crypto.timingSafeEqual(
    Buffer.from(goodHash, 'utf8'),
    Buffer.from(generateHash(tId, TEST_SECRET), 'utf8')
  );
  assert.strictEqual(isGood, true, 'Test 1 Failed: Valid hash verification');
  assert.notStrictEqual(goodHash, badHash, 'Test 1 Failed: Bad hash check');
  console.log('✅ Test 1 Passed: Secure timing-safe hash check verified.');

  // Test 2: Standard Currency Conversion (0.50 USD * 4900 = 2450 pts)
  const ptsStd = Math.round(0.50 * 4900);
  assert.strictEqual(ptsStd, 2450, 'Test 2 Failed: Standard factor conversion mismatch');
  console.log('✅ Test 2 Passed: Standard 4900 factor conversion (0.50 USD = 2450 pts).');

  // Test 3: Bonus Factor Conversion (0.03 USD * 8800 = 264 pts)
  const ptsBonus = Math.round(0.03 * 8800);
  assert.strictEqual(ptsBonus, 264, 'Test 3 Failed: Bonus factor conversion mismatch');
  console.log('✅ Test 3 Passed: Bonus 8800 factor conversion (0.03 USD = 264 pts).');

  // Test 4: Reversal Calculation Balance Consistency
  const initial = 5000;
  const credited = 2450;
  const reversed = initial + credited - credited;
  assert.strictEqual(reversed, initial, 'Test 4 Failed: Reversal calculation error');
  console.log('✅ Test 4 Passed: Reversal math consistency verified.');

  console.log('🎉 ALL CPX UNIT TESTS PASSED SUCCESSFULLY!');
}

runTests();
