import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError, storeErrorCode } from '../../../src/store/index.ts';

// Rule: every store failure that crosses IPC names its kind in the first characters of its
// message, because Electron hands the renderer only the message.

test('a store error carries its code and puts it first in the message', () => {
  const err = new StoreError('not_found', 'no such chapter');
  assert.equal(err.code, 'not_found');
  assert.equal(err.message, '[store:not_found] no such chapter');
  assert.ok(err instanceof Error);
});

test('the code is read back from the message alone, as the renderer will have it', () => {
  for (const code of ['not_found', 'cloud_only', 'unreadable', 'bad_name', 'exists', 'blocked'] as const) {
    const sent = new StoreError(code, 'something about a file').message;
    assert.equal(storeErrorCode(sent), code);
    assert.equal(storeErrorCode(new StoreError(code, 'x')), code);
  }
});

test('an error that did not come from the store has no code', () => {
  assert.equal(storeErrorCode(new Error('ENOENT: no such file')), undefined);
  assert.equal(storeErrorCode("Error invoking remote method 'chapter:read': Error: [store:not_found] x"), 'not_found');
  assert.equal(storeErrorCode('[store:nonsense] x'), undefined);
  assert.equal(storeErrorCode(undefined), undefined);
  assert.equal(storeErrorCode(42), undefined);
});
