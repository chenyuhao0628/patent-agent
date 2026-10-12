import { createContext, useContext, useSyncExternalStore } from 'react';
import type { WorkspaceStore } from './workspace-data.ts';
export const WorkspaceDataContext=createContext<WorkspaceStore|null>(null);
export function useWorkspaceStore(){const store=useContext(WorkspaceDataContext);if(!store)throw new Error('模块缺少工作区数据宿主。');return store;}
export function useWorkspaceSnapshot(){const store=useWorkspaceStore();return useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);}
