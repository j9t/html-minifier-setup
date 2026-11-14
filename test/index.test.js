import { describe, test } from 'node:test';
import assert from 'node:assert';
import * as api from '../src/index.js';

describe('Package exports', () => {
  test('Includes what programmatic use needs', () => {
    for (const name of ['createRenderer', 'customize', 'formatReport', 'loadPages', 'toConfig', 'toPresetConfig']) {
      assert.strictEqual(typeof api[name], 'function', name);
    }
  });
});