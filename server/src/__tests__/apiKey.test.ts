// Pure-function unit tests for the public-API security core. No DB, no server —
// run with:  npx tsx src/__tests__/apiKey.test.ts   (or `npm run test:api`).
import assert from 'node:assert/strict';
import { isValidKeyShape, timingSafeHexEqual, hashApiKey, generateApiKey } from '../lib/apiKey';
import { applyScopes, classifyField, unclassifiedSensitiveKeys, REALMS } from '../lib/apiScopes';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ' — ' + (e as Error).message); }
}

// ── Key shape ─────────────────────────────────────────────────────────────────
test('shape: accepts crmk_live_ / crmk_test_', () => {
  assert.ok(isValidKeyShape('crmk_live_' + 'a'.repeat(24)));
  assert.ok(isValidKeyShape('crmk_test_' + 'Z9_-'.repeat(6)));
});
test('shape: rejects junk / wrong prefix / too short', () => {
  assert.equal(isValidKeyShape('nope'), false);
  assert.equal(isValidKeyShape('ck_live_' + 'a'.repeat(32)), false);
  assert.equal(isValidKeyShape('crmk_live_short'), false);
  assert.equal(isValidKeyShape(''), false);
});
test('generate: real key passes its own shape check + hash is 64-hex', () => {
  const { raw, keyHash } = generateApiKey('live');
  assert.ok(isValidKeyShape(raw));
  assert.match(keyHash, /^[0-9a-f]{64}$/);
  assert.equal(keyHash, hashApiKey(raw));
});

// ── Constant-time compare ─────────────────────────────────────────────────────
test('timingSafeHexEqual: equal hashes → true', () => {
  const h = hashApiKey('crmk_live_' + 'x'.repeat(24));
  assert.equal(timingSafeHexEqual(h, h), true);
});
test('timingSafeHexEqual: different hashes → false', () => {
  assert.equal(timingSafeHexEqual(hashApiKey('a'), hashApiKey('b')), false);
});
test('timingSafeHexEqual: length mismatch / empty → false (never throws)', () => {
  assert.equal(timingSafeHexEqual('ab', 'abcd'), false);
  assert.equal(timingSafeHexEqual('', ''), false);
});

// ── Field classification ──────────────────────────────────────────────────────
test('classifyField: money/party/people/files/core/deny', () => {
  assert.equal(classifyField('basicAmount'), 'read:money');
  assert.equal(classifyField('gstin'), 'read:parties');
  assert.equal(classifyField('responsible'), 'read:people');
  assert.equal(classifyField('pdfUrl'), 'read:files');
  assert.equal(classifyField('status'), null);   // core
  assert.equal(classifyField('name'), null);      // overloaded core identifier
  assert.equal(classifyField('aadhaar'), 'deny');
  assert.equal(classifyField('keyHash'), 'deny');
});

// ── Scope redaction ───────────────────────────────────────────────────────────
const rich = { id: 'x', name: 'Proj', status: 'OPEN', basicAmount: 100, vendor: 'Acme', responsible: 'Ravi', pdfUrl: 'http://f', keyHash: 'SECRET', deepLink: 'http://go' };

test('redaction: core-only strips money/parties/people/files + hard-deny', () => {
  const { data, withheld } = applyScopes(rich, ['read:core']);
  const d = data as Record<string, unknown>;
  assert.ok('id' in d && 'status' in d && 'name' in d && 'deepLink' in d);
  for (const k of ['basicAmount', 'vendor', 'responsible', 'pdfUrl', 'keyHash']) assert.ok(!(k in d), `${k} should be stripped`);
  for (const k of ['basicAmount', 'vendor', 'responsible', 'pdfUrl', 'keyHash']) assert.ok(withheld.includes(k));
});
test('redaction: read:money keeps money, still strips others', () => {
  const { data } = applyScopes(rich, ['read:core', 'read:money']);
  const d = data as Record<string, unknown>;
  assert.equal(d.basicAmount, 100);
  assert.ok(!('vendor' in d) && !('responsible' in d));
});
test('redaction: read:parties keeps vendor; read:people keeps responsible', () => {
  assert.equal((applyScopes(rich, ['read:core', 'read:parties']).data as any).vendor, 'Acme');
  assert.equal((applyScopes(rich, ['read:core', 'read:people']).data as any).responsible, 'Ravi');
});
test('redaction: hard-deny stripped even with ALL scopes', () => {
  const all = ['read:core', 'read:money', 'read:parties', 'read:people', 'read:files'];
  const d = applyScopes(rich, all).data as Record<string, unknown>;
  assert.ok(!('keyHash' in d), 'keyHash must never ship');
  assert.equal(d.pdfUrl, 'http://f'); // files scope present → kept
});
test('redaction: recurses into arrays + nested objects', () => {
  const nested = { rows: [{ id: 1, amount: 5 }], meta: { vendor: 'X' } };
  const d = applyScopes(nested, ['read:core']).data as any;
  assert.ok(!('amount' in d.rows[0]) && !('vendor' in d.meta));
});

// ── Leak test: real v1 response shapes must contain NO unclassified sensitive key
test('leak: representative v1 objects have no unclassified sensitive fields', () => {
  const samples = [
    { id: '1', name: 'P', client: 'C', site: 'S', status: 'OPEN', startDate: null, targetDate: null, deepLink: 'x' },
    { id: '2', number: 'PO-1', vendor: 'V', status: 'OK', date: null, basicAmount: 1, finalAmount: 2, deepLink: 'x' },
    { id: '3', number: 'GRN-1', against: 'PO-1', vendor: 'V', status: 'OK', date: null, invoiceNumber: 'I', invoiceValue: 9, deepLink: 'x' },
    { id: '4', number: 'FMS-1', vendor: 'V', po: 'PO-1', amount: 5, status: 'OK', paidAt: null, deepLink: 'x' },
    { id: '5', name: 'T', status: 'OK', percentComplete: 10, plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null, responsible: 'R', deepLink: 'x' },
    { id: '6', srNo: '1', description: 'd', category: 'c', unit: 'u', plannedQty: 1, modelNumber: 'm', deepLink: 'x' },
    { id: '7', vendorName: 'V', type: 'VENDOR', gstin: 'G', pan: 'P', contact: 'C', phone: 'p', deepLink: 'x' },
  ];
  const leaks = unclassifiedSensitiveKeys(samples);
  assert.deepEqual(leaks, [], 'unclassified sensitive keys: ' + leaks.join(', '));
});

// ── Realm/scope coupling config ───────────────────────────────────────────────
test('realm config: finance needs read:money, vendors needs read:parties', () => {
  assert.equal(REALMS.find((r) => r.key === 'finance')?.requiresScope, 'read:money');
  assert.equal(REALMS.find((r) => r.key === 'vendors')?.requiresScope, 'read:parties');
  assert.equal(REALMS.find((r) => r.key === 'projects')?.requiresScope, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
