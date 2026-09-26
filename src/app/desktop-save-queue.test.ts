import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopSaveQueue } from './desktop-save-queue.ts';
import { desktopScopeOf } from './scope.ts';
import type { DesktopState, DesktopScope } from '../contracts/desktop-state.ts';
import type { Workspace } from '../domain/workflow.ts';

function initial():DesktopState {
  return {
    profileKey:'local',scopeVersion:0,snapshotVersion:0,caseRevisions:{a:0,b:0},account:null,
    workspace:{schema:1,settings:{provider:'',baseUrl:'',model:''},cases:['a','b'].map(id=>({
      id,number:id,title:id,type:'test',deadline:'',tags:[],archived:false,source:'local',
      current:{kind:'write'},rounds:[],localDraft:'',
    }))},
    sync:{running:false,message:''},storage:{running:false,message:''},
    migration:{running:false,phase:'idle',canCancel:false,message:''},version:'test',dataDirectory:'',
  };
}
function gate(){
  let release!:()=>void;
  return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};
}
function fixture(saveHook?:(workspace:Workspace,scope:DesktopScope)=>Promise<void>) {
  let server=initial(),shown=server.workspace;
  const scopes:DesktopScope[]=[];
  const queue=createDesktopSaveQueue(server,{
    isActive:()=>true,
    onChange:workspace=>{shown=workspace;},
    onState:()=>{},
    save:async(_key,workspace,scope)=>{
      scopes.push({...scope});
      await saveHook?.(workspace,scope);
      assert.deepEqual(scope,desktopScopeOf(server,scope.caseId));
      const before=server.workspace.cases.find(c=>c.id===scope.caseId)!;
      const after=workspace.cases.find(c=>c.id===scope.caseId)!;
      server={...server,snapshotVersion:server.snapshotVersion+1,workspace,caseRevisions:{...server.caseRevisions,
        [before.id]:server.caseRevisions[before.id]+Number(before.archived!==after.archived),
      }};
      shown=queue.receive(structuredClone(server));
      return structuredClone(server);
    },
  });
  return {queue,scopes,server:()=>server,shown:()=>shown,external:(next:DesktopState)=>{server=next;shown=queue.receive(next);}};
}

test('archive acknowledgements advance only edits already queued in the same case',async()=>{
  const held=gate(),f=fixture(async()=>held.promise),scope=f.queue.scope('a')!;
  const archive=f.queue.enqueue('a',{archived:true},scope);
  const restore=f.queue.enqueue('a',{archived:false},scope);
  const tagged=f.queue.enqueue('a',{tags:['new']},scope);
  assert.equal(f.shown().cases[0].archived,false);
  held.release();
  await Promise.all([archive,restore,tagged]);
  assert.deepEqual(f.scopes.map(s=>s.caseRevision),[0,1,2]);
  assert.equal(f.server().workspace.cases[0].archived,false);
  assert.deepEqual(f.server().workspace.cases[0].tags,['new']);
  await assert.rejects(f.queue.enqueue('a',{tags:['stale']},scope),/作用域/);
});

test('a published save never replaces a newer queued optimistic draft',async()=>{
  const entered=gate(),release=gate();
  let calls=0;
  const f=fixture(async()=>{
    if(++calls===2){entered.release();await release.promise;}
  });
  const scope=f.queue.scope('a')!;
  const first=f.queue.enqueue('a',{localDraft:'first'},scope);
  const second=f.queue.enqueue('a',{localDraft:'second'},scope);
  await entered.promise;
  assert.equal(f.shown().cases[0].localDraft,'second');
  assert.equal(f.server().workspace.cases[0].localDraft,'first');
  release.release();await Promise.all([first,second]);
  assert.equal(f.server().workspace.cases[0].localDraft,'second');
});

test('queued saves use the newest authority and isolate batch archive edits by case',async()=>{
  const held=gate(),f=fixture(async()=>held.promise);
  const a=f.queue.enqueue('a',{archived:true},f.queue.scope('a'));
  const b=f.queue.enqueue('b',{archived:true},f.queue.scope('b'));
  const next=structuredClone(f.server());next.workspace.cases[1].localDraft='new server draft';
  f.external(next);held.release();
  await Promise.all([a,b]);
  assert.ok(f.server().workspace.cases.every(c=>c.archived));
  assert.equal(f.server().workspace.cases[1].localDraft,'new server draft');
  assert.deepEqual(f.scopes.map(s=>[s.caseId,s.caseRevision]),[['a',0],['b',0]]);
});

test('external A-B-A is not acknowledged as this queue own archive transition',async()=>{
  const f=fixture(),scope=f.queue.scope('a')!;
  const pending=f.queue.enqueue('a',{localDraft:'stale'},scope);
  const rejected=assert.rejects(pending,/作用域/);
  const next=structuredClone(f.server());next.caseRevisions={...next.caseRevisions,a:2};
  f.external(next);
  await rejected;
  assert.equal(f.scopes.length,0);
  assert.equal(f.shown().cases[0].localDraft,'');
});

test('late save acknowledgement cannot roll back a newer stage event',async()=>{
  const entered=gate(),release=gate();
  let published=initial(),shown=published.workspace;
  const queue=createDesktopSaveQueue(published,{
    isActive:()=>true,onChange:w=>{shown=w;},onState:s=>{published=s;},
    save:async(_key,workspace)=>{
      const saved={...initial(),workspace,caseRevisions:{a:1,b:0}};
      shown=queue.receive(saved);entered.release();await release.promise;return saved;
    },
  });
  const scope=queue.scope('a')!;
  const a=queue.enqueue('a',{archived:true},scope);
  const b=queue.enqueue('a',{archived:false},scope);
  const rejected=assert.rejects(b,/作用域/);
  await entered.promise;
  const external=initial();external.caseRevisions={a:3,b:0};external.workspace.cases[0].current={kind:'review'};
  shown=queue.receive(external);
  release.release();await a;await rejected;
  assert.equal(published.caseRevisions.a,3);
  assert.equal(shown.cases[0].current?.kind,'review');
});

test('failed save rolls back its optimistic fields while allowing later edits to save',async()=>{
  let first=true;
  const f=fixture(async()=>{if(first){first=false;throw new Error('disk failed');}});
  const scope=f.queue.scope('a')!;
  const rejected=assert.rejects(f.queue.enqueue('a',{archived:true},scope),/disk failed/);
  const next=f.queue.enqueue('a',{localDraft:'kept'},scope);
  await rejected;await next;
  assert.equal(f.shown().cases[0].archived,false);
  assert.equal(f.server().workspace.cases[0].localDraft,'kept');
});

test('late same-stage save response cannot replace a newer snapshot or feed stale data to the next save',async()=>{
  const entered=gate(),release=gate();
  let server=initial(),shown=server.workspace,published=server,calls=0;
  const queue=createDesktopSaveQueue(server,{
    isActive:()=>true,onChange:w=>{shown=w;},onState:s=>{published=s;},
    save:async(_key,workspace)=>{
      server={...server,snapshotVersion:server.snapshotVersion+1,workspace};
      const saved=structuredClone(server);
      shown=queue.receive(saved);
      if(++calls===1){entered.release();await release.promise;}
      return saved;
    },
  });
  const first=queue.enqueue('a',{localDraft:'first'},queue.scope('a'));
  await entered.promise;
  server=structuredClone(server);
  server.snapshotVersion++;
  server.workspace.cases[1].localDraft='newer external draft';
  shown=queue.receive(server);
  const second=queue.enqueue('a',{tags:['new']},queue.scope('a'));
  release.release();await Promise.all([first,second]);
  assert.equal(shown.cases[1].localDraft,'newer external draft');
  assert.equal(server.workspace.cases[1].localDraft,'newer external draft');
  assert.equal(published.snapshotVersion,server.snapshotVersion);
});

test('queued edits reject account changes and callbacks after unmount',async()=>{
  const f=fixture(),scope=f.queue.scope('a')!;
  const pending=f.queue.enqueue('a',{localDraft:'stale'},scope);
  const rejected=assert.rejects(pending,/作用域/);
  const account=initial();account.profileKey='other';account.scopeVersion=1;f.external(account);
  await rejected;assert.equal(f.scopes.length,0);
  let active=true,calls=0;
  const queue=createDesktopSaveQueue(initial(),{
    isActive:()=>active,onChange:()=>{},onState:()=>{},
    save:async()=>{calls++;return initial();},
  });
  const unmounted=queue.enqueue('a',{localDraft:'stale'},queue.scope('a'));
  active=false;await assert.rejects(unmounted,/作用域/);assert.equal(calls,0);
});
