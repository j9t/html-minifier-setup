import { describe, test } from 'node:test';
import assert from 'node:assert';

describe('Package', () => {
  test('Offers no programmatic entry point', async () => {
    await assert.rejects(import('html-minifier-setup'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  });

  test('Keeps internal modules private', async () => {
    await assert.rejects(import('html-minifier-setup/src/select.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  });

  test('Includes the package manifest', async () => {
    const { default: manifest } = await import('html-minifier-setup/package.json', { with: { type: 'json' } });
    assert.strictEqual(manifest.name, 'html-minifier-setup');
  });
});