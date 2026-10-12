import type { IpcArgs, IpcChannel } from '../src/contracts/ipc.ts';
import type { DesktopService, OperationScope } from './service.ts';

type Policy = 'global' | 'account' | 'profile' | 'case' | 'local-case' | 'session' | 'extensions' | 'prior-art' | 'workspace';

// Session IDs and case IDs occupy the same tuple position, but are not interchangeable.
export const IPC_SCOPE_POLICY = {
  runtimeStatus: 'global', runtimeCheck: 'global', runtimeRollback: 'global', runtimeAutomatic: 'global',
  diagnosticExport: 'global', diagnosticReport: 'global',
  applicationGet: 'global', applicationSave: 'global', applicationMinimize: 'global', applicationQuit: 'global',
  bootstrap: 'global', verifyLogin: 'global', login: 'global', logout: 'global',
  selectDirectory: 'account', selectDshDirectory: 'account',
  extensions: 'extensions', priorArt: 'prior-art',
  saveSettings: 'profile', saveWorkspace: 'workspace', refreshShared: 'profile',
  sync: 'account', createCase: 'account', caseLinkCandidates:'case',linkCase:'case',
  flow: 'local-case', caseInfo: 'case', refreshCase: 'case', refreshCaseOutcomes: 'profile', refreshCaseOutcome: 'case',
  selectCurrentProcess: 'case', openCaseDirectory: 'local-case', openMaterial: 'local-case',
  findOriginals: 'local-case', copyOriginal: 'local-case',
  previewWorkMigration: 'profile', startWorkMigration: 'profile', cancelWorkMigration: 'global', organizeWorkFolders: 'profile',
  model: 'global', modelCancel: 'global',
  professionalPreview:'case',professionalGet: 'case', professionalHistory: 'case', professionalReviews: 'profile',
  professionalCommand: 'case', professionalPick: 'case', professionalPickReferences: 'case',
  professionalRemoveReference: 'case', professionalOpen: 'case',
  agentGetCase: 'case', agentHistory: 'case', agentReviewSources: 'case',
  agentCommand: 'case', agentProgress: 'profile', agentTasks: 'profile',
  documentToolsStatus: 'global', documentToolsDetect: 'global', documentToolsSelect: 'global',
  documentToolsInstall: 'global', documentToolsRemove: 'global', documentToolsConfigure: 'global', documentToolsOpen: 'global',
  transferInspect: 'case', transferHistory: 'case', transferPrepare: 'case',
  transferPickFile: 'session', transferRemoveFile: 'session', transferClearRemote: 'session', transferDeleteRemoteFile: 'session',
  transferPreviewFile: 'session', transferStartHand: 'session', transferSaveLocalReview: 'session',
  transferSave: 'session', transferSubmit: 'session', transferRefresh: 'profile',
  transferReprepare: 'session', transferRevoke: 'session',
} satisfies Record<IpcChannel, Policy>;

export function captureIpcScope<Name extends IpcChannel>(
  service: Pick<DesktopService, 'key' | 'captureScope' | 'assertScopeIdentity'>,
  transfer: { requestScope: (key: string, sessionId: string) => OperationScope },
  channel: Name,
  args: IpcArgs<Name>,
): OperationScope | undefined {
  const policy: Policy = IPC_SCOPE_POLICY[channel];
  switch (policy) {
    case 'global': return undefined;
    case 'account': return service.captureScope(service.key);
    case 'profile': return service.captureScope(args[0] as string);
    case 'case': return service.captureScope(args[0] as string, args[1] as string | undefined);
    case 'local-case': return service.captureScope(service.key, args[0] as string);
    case 'session': return transfer.requestScope(args[0] as string, args[1] as string);
    case 'extensions': return service.captureScope(args[1] as string);
    case 'prior-art': return service.captureScope(args[1] as string, args[0] === 'prepare' ? args[2] as string : undefined);
    case 'workspace': {
      const [key, , requested] = args as IpcArgs<'saveWorkspace'>;
      const scope = { ...requested, root: service.captureScope(key).root };
      service.assertScopeIdentity(scope);
      return scope;
    }
  }
}

export function dispatchScopedIpc<Name extends IpcChannel, Result>(
  service: Pick<DesktopService, 'key' | 'captureScope' | 'assertScopeIdentity' | 'assertScope'>,
  transfer: { requestScope: (key: string, sessionId: string) => OperationScope },
  channel: Name,
  args: IpcArgs<Name>,
  handler: (...args:IpcArgs<Name>)=>Result|Promise<Result>,
  enqueue?:<T>(fn:()=>Promise<T>)=>Promise<T>,
):Promise<Result>{
  const frozen=structuredClone(args),scope=captureIpcScope(service,transfer,channel,frozen);
  const invoke=async()=>{if(scope)service.assertScope(scope);return handler(...frozen);};
  return enqueue?enqueue(invoke):invoke();
}
