export type EngineSessionView = {
  id: string;
  reused: boolean;
  retained: boolean;
  runtimeVersion: string;
  cacheEnabled: boolean;
  usageReported: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  compactions: number;
};
