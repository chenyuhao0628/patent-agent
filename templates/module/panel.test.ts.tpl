import test from 'node:test';
import assert from 'node:assert/strict';
import { panels } from '../../../app/panels.ts';
import { createWorkspaceStore } from '../../../app/workspace-data.ts';
import { createModuleDataLease } from '../../../app/module-data.ts';

test(__TITLE__ + ': registered scope has no implicit writes and expires after unmount', () => {
  const definition = panels.resolve(__LOCATION__, __ROUTE__);
  assert.equal(definition?.id, __ID__);
  const store = createWorkspaceStore({preview:{schema:1,settings:{provider:'',baseUrl:'',model:''},cases:['a','b'].map(id=>({id,number:id,title:id,type:'test',deadline:'',tags:[],archived:false,rounds:[],current:{kind:'write'}}))}});
  const lease = createModuleDataLease(store, __CASE_ID__);
  assert.deepEqual(lease.data.listCases().map(item=>item.id), __EXPECTED_IDS__);
  assert.equal('saveMetadata' in lease.data, false);
  lease.dispose();
  assert.throws(() => lease.data.listCases(), /范围已变化/);
  store.dispose();
});
