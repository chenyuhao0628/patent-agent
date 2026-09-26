import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationItems, parseRoute, casePath, isHistoryTarget } from './navigation.ts';
import { featureContext } from './features.ts';

test('navigation hides desktop business modules when the host cannot provide them', () => {
  assert.deepEqual(navigationItems(featureContext(false)).map(item => item.id), [
    'library', 'official', 'tasks', 'status',
  ]);
});

test('old round, discussion and source bookmarks retain an exact read-only identity',()=>{
  for(const [tab,key] of [['reply','roundId'],['discussion','discussionId'],['review','sourceId'],['write','sourceId']] as const){
    const route=parseRoute(`#/case/case%2F1/${tab}/old%2Fid`);
    assert.equal(route[1],'case/1');
    assert.deepEqual(route[3],{readonly:true,[key]:'old/id'});
    assert.equal(isHistoryTarget(route[3]),true);
  }
});

test('precise history targets roundtrip including encoded identifiers without falling back to current',()=>{
  const target={processId:'old / process',discussionId:'d/1',runId:'r?1',historyId:'h#1'};
  assert.deepEqual(parseRoute(casePath('case/1','history',target)),['case','case/1','history',target]);
  assert.deepEqual(parseRoute('#/case/missing/review?sourceId=missing'),['case','missing','review',{sourceId:'missing'}]);
  assert.equal(isHistoryTarget({sourceId:'current-source'}),false);
  assert.equal(isHistoryTarget({readonly:true,sourceId:'old-source'}),true);
});

test('navigation derives business modules from the registered capability surface', () => {
  const ids = navigationItems(featureContext(true)).map(item => item.id);
  assert.deepEqual(ids, ['library', 'official', 'tasks', 'review', 'transfer', 'status']);
});
