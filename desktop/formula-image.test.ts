import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSegments } from '../src/domain/formula-parser.ts';

test('parseSegments parses markdown image tokens', () => {
  const input = '![系统架构图](data:image/png;base64,sample123)';
  const segments = parseSegments(input);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'image');
  if (segments[0].type === 'image') {
    assert.equal(segments[0].alt, '系统架构图');
    assert.equal(segments[0].src, 'data:image/png;base64,sample123');
  }
});

test('parseSegments parses text, image, and LaTeX formula together without conflict', () => {
  const input = '如图所示 ![图 1](data:image/png;base64,xyz)，其中应满足 $P = \\frac{F}{S}$ 关系。';
  const segments = parseSegments(input);
  assert.equal(segments.length, 5);

  assert.equal(segments[0].type, 'text');
  assert.equal(segments[0].content, '如图所示 ');

  assert.equal(segments[1].type, 'image');
  if (segments[1].type === 'image') {
    assert.equal(segments[1].alt, '图 1');
    assert.equal(segments[1].src, 'data:image/png;base64,xyz');
  }

  assert.equal(segments[2].type, 'text');
  assert.equal(segments[2].content, '，其中应满足 ');

  assert.equal(segments[3].type, 'inline-math');
  assert.equal(segments[3].content, 'P = \\frac{F}{S}');

  assert.equal(segments[4].type, 'text');
  assert.equal(segments[4].content, ' 关系。');
});

test('parseSegments handles display math alongside images', () => {
  const input = '$$\\Delta E = h\\nu$$\n![能带示意图](data:image/jpeg;base64,band)';
  const lines = input.split('\n');

  const segsLine1 = parseSegments(lines[0]);
  assert.equal(segsLine1.length, 1);
  assert.equal(segsLine1[0].type, 'display-math');
  assert.equal(segsLine1[0].content, '\\Delta E = h\\nu');

  const segsLine2 = parseSegments(lines[1]);
  assert.equal(segsLine2.length, 1);
  assert.equal(segsLine2[0].type, 'image');
  if (segsLine2[0].type === 'image') {
    assert.equal(segsLine2[0].alt, '能带示意图');
    assert.equal(segsLine2[0].src, 'data:image/jpeg;base64,band');
  }
});

test('parseSegments falls back to promote standalone bare data:image URL to image', () => {
  const input = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const segments = parseSegments(input);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'image');
  if (segments[0].type === 'image') {
    assert.equal(segments[0].alt, '预览附图');
    assert.equal(segments[0].src, input);
  }
});
