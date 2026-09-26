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
