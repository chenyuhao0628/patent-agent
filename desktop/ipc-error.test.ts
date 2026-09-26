import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, deserializeContractError, serializeContractError } from '../src/contracts/version.ts';

test('contract error code survives Electron error serialization shape', () => {
  const serialized = serializeContractError(new ContractError('INVALID_PROFILE', '账号标识格式无效。'));
  assert.equal(serialized.name, 'ContractError');
  const restored = deserializeContractError(new Error(`Error invoking remote method 'desktop:login': Error: ${serialized.message}`));
  assert(restored instanceof ContractError);
  assert.equal((restored as ContractError).code, 'INVALID_PROFILE');
  assert.equal(restored.message, '账号标识格式无效。');
});

test('ordinary errors remain ordinary errors', () => {
  const restored = deserializeContractError(new Error('Error invoking remote method \'desktop:login\': Error: 网络不可用。'));
  assert.equal(restored.name, 'Error');
  assert.equal(restored.message, '网络不可用。');
});
