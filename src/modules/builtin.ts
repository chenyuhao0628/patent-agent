import { ArrowRightLeft, BadgeCheck, Clock3, FileSearch, Folder, ListTodo, Settings } from 'lucide-react';
import type { GlobalPanelDefinition, CasePanelDefinition, PanelAccessContext } from '../app/panel-types.ts';
import type { Module } from '../domain/library.ts';
import { FEATURE_MODULE_BY_ID, featureAccessForView } from '../app/features.ts';

const access=(id:Module,context:PanelAccessContext)=>context.caseView?featureAccessForView(FEATURE_MODULE_BY_ID[id],context,context.caseView):{visible:false,startable:false,editable:false};
const globals=(name:'LibraryPanel'|'TasksPanel'|'TransferPanel'|'ReviewPanel'|'SettingsPanel'|'StatusPanel')=>()=>import('./workspace-panels.tsx').then(m=>({default:m[name]}));
const cases=(name:'OverviewPanel'|'MaterialsPanel'|'DiscussionPanel'|'ReplyPanel'|'WritingPanel'|'ReviewCasePanel'|'HistoryPanel'|'OutputsPanel'|'FlowPanel'|'SubmitPanel')=>()=>import('./case-panels.tsx').then(m=>({default:m[name]}));
const casePanel=(route:string,label:string,order:number,name:Parameters<typeof cases>[0],extra:Partial<CasePanelDefinition>={}):CasePanelDefinition=>({id:'case.'+route,location:'case',route,label,order,navigation:'case',historyRoute:'history',load:cases(name),...extra});
export const BUILTIN_GLOBAL_PANELS:readonly GlobalPanelDefinition[]=[
 {id:'workspace.library',location:'global',route:'library',label:'案件库',order:0,navigation:'main',icon:Folder,load:globals('LibraryPanel')},
 {id:'workspace.official',location:'global',route:'official',label:'等待官方',order:1,navigation:'main',icon:Clock3,load:globals('LibraryPanel')},
 {id:'workspace.tasks',location:'global',route:'tasks',label:'工作任务',order:2,navigation:'main',icon:ListTodo,load:globals('TasksPanel')},
 {id:'workspace.review',location:'global',route:'review',label:'审查队列',module:'review',order:3,navigation:'main',icon:FileSearch,requiredCapabilities:['professional.review'],load:globals('ReviewPanel')},
 {id:'workspace.transfer',location:'global',route:'transfer',label:'内部流转',module:'transfer',order:4,navigation:'main',icon:ArrowRightLeft,requiredCapabilities:['transfer.prepare'],load:globals('TransferPanel')},
 {id:'workspace.status',location:'global',route:'status',label:'案件状态',order:5,navigation:'main',icon:BadgeCheck,load:globals('StatusPanel')},
 {id:'workspace.settings',location:'global',route:'settings',label:'设置',order:6,navigation:'footer',icon:Settings,load:globals('SettingsPanel')},
 ...(['reply','write'] as const).map(module=>({id:'workspace.'+module,location:'global' as const,route:module,label:FEATURE_MODULE_BY_ID[module].label,order:10,navigation:'hidden' as const,module,activeNavigation:'library',load:globals('LibraryPanel')})),
];
export const BUILTIN_CASE_PANELS:readonly CasePanelDefinition[]=[
 casePanel('overview','概览',0,'OverviewPanel'),
 casePanel('materials','材料',1,'MaterialsPanel',{enter:'open-case',canEdit:c=>!!c.caseView?.stage.editable}),
 casePanel('discussion','本案对话',2,'DiscussionPanel',{layout:'conversation',requiredCapabilities:['agent.reply'],visible:c=>!['reply','correction'].includes(c.caseView?.stage.kind??''),canEdit:c=>!!c.caseView?.stage.editable,enter:'open-case'}),
 casePanel('reply','答复',2,'ReplyPanel',{layout:'conversation',canOpen:c=>!c.desktop||access('reply',c).visible,visible:c=>['reply','correction'].includes(c.caseView?.stage.kind??''),canEdit:c=>access('reply',c).editable,enter:'open-case'}),
 casePanel('write','撰写',3,'WritingPanel',{layout:'focused',canOpen:c=>!c.desktop||access('write',c).visible,visible:c=>c.caseView?.stage.kind==='write',canEdit:c=>access('write',c).editable,enter:'open-case'}),
 casePanel('review','稿件审查',4,'ReviewCasePanel',{layout:'focused',canOpen:c=>!c.desktop||access('review',c).visible,canEdit:c=>access('review',c).editable,enter:'open-case'}),
 casePanel('submit','提交',5,'SubmitPanel',{visible:c=>access('transfer',c).visible,canEdit:c=>access('transfer',c).editable}),
 casePanel('history','办理历史',6,'HistoryPanel'),
 casePanel('outputs','成果',7,'OutputsPanel'),
 casePanel('flow','贝思兰德流程',8,'FlowPanel'),
];
export const BUILTIN_PANELS=[...BUILTIN_GLOBAL_PANELS,...BUILTIN_CASE_PANELS];
