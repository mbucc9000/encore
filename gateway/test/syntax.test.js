'use strict';
// Every bridge source file parses (node --check), including the ones no other test loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();

test('the bridge has source files', () => {
  assert.ok(files.includes('main.js') && files.length > 10, files.join(', '));
});

for (const f of files) {
  test(`node --check src/${f}`, () => {
    const r = spawnSync(process.execPath, ['--check', path.join(SRC, f)], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  });
}
