import type { WorkspaceStore } from './workspace-data.ts';
import type { Case } from '../domain/workflow.ts';
import { projectCaseView } from '../domain/case-view.ts';
import { sameDesktopScope } from './scope.ts';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
export type CaseMetadataPatch = Pick<Partial<Case>, 'title' | 'deadline' | 'tags' | 'archived'>;

/** A module holds a lease on one account/case/stage, not a mutable workspace.
 * Read-only and historical panels receive no mutation method at all. */
export function createModuleData(store: WorkspaceStore, caseId?: string, editable = false) {
  const expected=store.scope(caseId);
  const check=()=>{if(!expected||!sameDesktopScope(store.scope(caseId),expected))throw new Error('模块的数据范围已变化，请重新打开页面。');};
  const read={
    scope: expected && frozen({...expected}),
    listCases: () => {
      check();
      return frozen(store.getSnapshot().workspace.cases.filter(c=>!caseId||c.id===caseId).map(c=>({id:c.id,title:c.title,number:c.number,archived:c.archived,current:structuredClone(c.current)})));
    },
    case: () => {
      check();
      if (!caseId) throw new Error('该模块未绑定案件。');
      const item=store.getSnapshot().workspace.cases.find(c=>c.id===caseId);
      if (!item) throw new Error('案件已不存在。');
      return frozen(projectCaseView(structuredClone(item)));
    },
    subscribe: (listener: () => void) => {
      check();
      const off=store.subscribe(()=>{try{check();}catch{off();return;}listener();});
      return off;
    },
  };
  if (!editable || !caseId) return read;
  return {...read,saveMetadata:async(patch:CaseMetadataPatch)=>{
    check();
    if(Object.keys(patch).some(k=>!['title','deadline','tags','archived'].includes(k)))throw new Error('模块元数据写入包含未授权字段。');
    await store.updateCase(caseId,patch,expected);
  }};
}
export type ModuleData = ReturnType<typeof createModuleData>;
