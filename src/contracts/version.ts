export const DESKTOP_CONTRACT_VERSION = 1 as const;

export type ContractErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_PROFILE'
  | 'INVALID_CASE'
  | 'INVALID_REQUEST';

export class ContractError extends Error {
  readonly code: ContractErrorCode;

  constructor(code: ContractErrorCode, message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

const CONTRACT_ERROR_PREFIX = 'PATENT_CONTRACT_ERROR:';

export function serializeContractError(error: unknown): Error {
  if (!(error instanceof ContractError)) {
    return error instanceof Error ? error : new Error('操作未完成。');
  }
  const serialized = new Error(`${CONTRACT_ERROR_PREFIX}${error.code}:${error.message}`);
  serialized.name = 'ContractError';
  Object.defineProperty(serialized, 'code', { value: error.code, enumerable: true, configurable: true });
  return serialized;
}

export function deserializeContractError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method 'desktop:[^']+': (?:Error: )?/, '');
  const match = new RegExp(`^${CONTRACT_ERROR_PREFIX}(INVALID_ARGUMENT|INVALID_PROFILE|INVALID_CASE|INVALID_REQUEST):(.*)$`, 's').exec(message);
  if (match) return new ContractError(match[1] as ContractErrorCode, match[2]);
  return new Error(message);
}

export function assertRecord(value: unknown, message = '请求对象无效。'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('INVALID_ARGUMENT', message);
  }
  return value as Record<string, unknown>;
}

export function assertString(value: unknown, label: string, maxLength = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new ContractError('INVALID_ARGUMENT', `${label}无效。`);
  }
  return value;
}

export function assertProfileKey(value: unknown): string {
  const key = assertString(value, '账号标识', 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ContractError('INVALID_PROFILE', '账号标识格式无效。');
  }
  return key;
}

export function assertCaseId(value: unknown): string {
  return assertString(value, '案件标识', 256);
}
