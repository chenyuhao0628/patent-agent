export type EngineRuntimeStatus = {
  automatic: boolean;
  state: 'idle' | 'checking' | 'downloading' | 'verifying' | 'pending' | 'unavailable';
  activeVersion: string;
  previousVersion?: string;
  candidateVersion?: string;
  activeRuns: number;
  checkedAt?: string;
  error?: string;
};
