import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createBridgeServer, parseSalary, saveJdFile } from '../scripts/extension-bridge.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

test('parseSalary parses common compensation formats', () => {
  const usdK = parseSalary('$120k - $160k');
  assert.deepEqual(usdK, { min: 120000, max: 160000, currency: 'USD' });

  const lpa = parseSalary('25-35 LPA');
  assert.deepEqual(lpa, { min: 2500000, max: 3500000, currency: 'INR' });

  const singleLpa = parseSalary('30 LPA');
  assert.deepEqual(singleLpa, { min: 3000000, max: 3000000, currency: 'INR' });

  const directNum = parseSalary('100,000 - 140,000 USD');
  assert.deepEqual(directNum, { min: 100000, max: 140000, currency: 'USD' });

  assert.equal(parseSalary('Competitive'), null);
  assert.equal(parseSalary(''), null);
  assert.equal(parseSalary(null), null);
});

test('saveJdFile saves markdown file to jds/', () => {
  const root = getCareerOpsRoot();
  const relPath = saveJdFile({
    url: 'https://example.com/test-job',
    company: 'TestCorp Alpha',
    title: 'Platform Engineer',
    location: 'Remote',
    compensation: '$150k',
    description: 'This is a test job description with requirements and stack.',
    source: 'test',
    date: '2026-10-25',
  });

  assert.ok(relPath);
  const fullPath = path.join(root, relPath);
  assert.ok(fs.existsSync(fullPath));

  const content = fs.readFileSync(fullPath, 'utf8');
  assert.ok(content.includes('# Platform Engineer — TestCorp Alpha'));
  assert.ok(content.includes('This is a test job description'));

  // Clean up test file
  fs.unlinkSync(fullPath);
});

test('extension bridge HTTP server endpoints', async () => {
  const server = createBridgeServer();
  const testPort = 19456;

  await new Promise((resolve) => server.listen(testPort, '127.0.0.1', resolve));

  try {
    // 1. Test OPTIONS preflight
    const optRes = await fetch(`http://127.0.0.1:${testPort}/clip`, { method: 'OPTIONS' });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), '*');

    // 2. Test GET /health
    const healthRes = await fetch(`http://127.0.0.1:${testPort}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, 'career-ops-bridge');
    assert.ok(typeof healthJson.counts.pending === 'number');
    assert.ok(typeof healthJson.counts.applications === 'number');

    // 3. Test POST /clip validation failure
    const badRes = await fetch(`http://127.0.0.1:${testPort}/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://foo.bar' }), // missing company & title
    });
    assert.equal(badRes.status, 400);

    // 4. Test POST /clip duplicate check
    // We test with an offer that already exists in applications.md (e.g. sarvam.ai or rippling)
    const dupRes = await fetch(`http://127.0.0.1:${testPort}/clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://job-boards.greenhouse.io/gomotive/jobs/8742067002',
        company: 'gomotive',
        title: 'Backend Engineer',
        location: 'Bangalore, India',
      }),
    });
    assert.equal(dupRes.status, 200);
    const dupJson = await dupRes.json();
    assert.equal(dupJson.ok, true);
    assert.equal(dupJson.status, 'duplicate');
    assert.ok(dupJson.message.includes('already in your pipeline'));

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
