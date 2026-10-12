import type { Case, RemoteProcess, Workspace } from '../domain/workflow.ts';
import type { DesktopScope, DesktopState } from '../contracts/desktop-state.ts';
import type { CaseNavigationTarget } from './navigation.ts';
import type { Module } from '../domain/library.ts';
import type { CaseWorkspaceView, CaseReplyView, CaseProfessionalView, CaseTransferModuleView, CaseHistoryView } from '../domain/case-view.ts';

export type GlobalPanelContext = {
 kind:'global';page:string;module?:Module;settingsSection?:string;data:Workspace;nativeState?:DesktopState;
 refresh?:(state:DesktopState)=>void;
 onOpenCase:(item:Case,tab?:string,target?:CaseNavigationTarget)=>void;
 onUpdateCase:(id:string,patch:Partial<Case>,scope?:DesktopScope)=>Promise<void>;
 onArchive:(ids:string[],archived:boolean)=>void;onImport:()=>void;
 onSaveSettings:(settings:Workspace['settings'])=>Promise<Workspace['settings']>;
};
export type CasePanelContext = {
 kind:'case';item:Case;tab:string;requestedTarget?:CaseNavigationTarget;
 profileKey?:string;scopeVersion?:number;caseRevision:number;scope?:DesktopScope;
 projected:CaseWorkspaceView;replyView:CaseReplyView;professionalView:CaseProfessionalView;transferView:CaseTransferModuleView;historyView:CaseHistoryView;
 primary:string;editable:boolean;allowed:boolean;historical:boolean;
 canViewFeature:(id:Module)=>boolean;canUseConversation:boolean;
 navigate:(tab:string,target?:CaseNavigationTarget)=>void;
 updateCase:(patch:Partial<Case>,scope?:DesktopScope)=>void|Promise<void>;
 updateDesign:(design:NonNullable<Case['design']>)=>void;
 refreshWholeCase:()=>Promise<void>;refreshing:boolean;refreshSeq:number;
 chooseProcess:(process:RemoteProcess,confirmed?:boolean)=>Promise<void>;selectingProcess:boolean;
 setPreview:(text:string|null)=>void;
};
export function globalContext(context:GlobalPanelContext|CasePanelContext){if(context.kind!=='global')throw new Error('面板位置与上下文不匹配。');return context;}
export function caseContext(context:GlobalPanelContext|CasePanelContext){if(context.kind!=='case')throw new Error('面板位置与上下文不匹配。');return context;}
