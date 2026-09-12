import test from 'node:test';
import assert from 'node:assert/strict';
import type { Case } from '../src/domain/workflow.ts';
import { classificationSuggestion } from './agent-classification.ts';

const fixture = (name: string): Case => ({ id: 'c', title: '隔离分类样本', number: 'TEST', type: '发明', tags: [], archived: false, deadline: '', rounds: [], current: { kind: 'reply', processId: 'p' }, remote: { caseId: 'remote', syncedAt: '', processes: [{ id: 'p', name, status: 200, node: '办理', undertaker: '', deadline: '' }] } });
test('proposal reads current process and notice round, but never confirms automatically', () => {
  const s = classificationSuggestion(fixture('答复审查意见（三）'), [{ name: '第三次审查意见通知书.pdf', text: '第三次审查意见通知书' }]);
  assert.equal(s.classification.officeActionRound, 3);
  assert.equal(s.classification.noticeCategory, '审查意见通知书');
  assert.equal(s.classification.patentType, '发明');
  assert.equal(s.classification.status, 'unclassified');
});
test('inconsistent current sources leave round unselected; unknown round is not silently one', () => {
  const s = classificationSuggestion(fixture('第二次审查意见'), [{ name: '通知书', text: '第三次审查意见通知书' }]);
  assert.equal(s.classification.officeActionRound, undefined);
  assert.ok(s.warnings.some(w => w.includes('不一致')));
  assert.equal(classificationSuggestion(fixture('审查意见')).classification.officeActionRound, undefined);
});
test('correction proposal keeps baseline subject to human confirmation', () => {
  const c = fixture('补正通知书'); c.current = { kind: 'correction', processId: 'p' };
  const s = classificationSuggestion(c);
  assert.equal(s.classification.noticeCategory, '补正通知书');
  assert.equal(s.classification.correctionBasis, 'original');
  assert.ok(s.warnings.some(w => w.includes('提交版本')));
});
