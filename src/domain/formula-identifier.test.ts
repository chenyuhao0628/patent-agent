import test from 'node:test';
import assert from 'node:assert/strict';
import { reidentifyFormulas, wrapSelectionAsFormula, normalizeMathChars, isValidLatex } from './formula-identifier.ts';

test('reidentifyFormulas: recognizes standalone bare formulas', () => {
  const input = '优选地，控制参数满足如下关系：\nS = a^2 + b^2\n以实现自适应调节。';
  const { text, count } = reidentifyFormulas(input);
  assert.equal(count, 1);
  assert.ok(text.includes('$$S = a^2 + b^2$$'));
  assert.ok(text.startsWith('优选地，控制参数满足如下关系：\n'));
});

test('reidentifyFormulas: recognizes inline bare math expressions with subscripts', () => {
  const input = '其中，特征变量满足 x_1 + x_2 = y_k，并且阈值固定。';
  const { text, count } = reidentifyFormulas(input);
  assert.equal(count, 1);
  assert.ok(text.includes('$x_1 + x_2 = y_k$'));
  assert.ok(text.includes('其中，特征变量满足 '));
  assert.ok(text.includes('，并且阈值固定。'));
});

test('reidentifyFormulas: normalizes Unicode math symbols and Greek letters', () => {
  const input = '根据能量守恒，ΔE = m × c^2 ± 0.05，其中 α = 0.5。';
  const { text, count } = reidentifyFormulas(input);
  assert.ok(count >= 1);
  assert.ok(text.includes('\\times') || text.includes('\\pm') || text.includes('\\Delta'));
});

test('reidentifyFormulas: is strictly idempotent (does not double-wrap existing formulas)', () => {
  const input = '已知公式为 $E = mc^2$，以及块级公式：\n$$\\sum_{i=1}^n x_i = 10$$\n还有普通裸公式：\ny = 2x + 1';
  const first = reidentifyFormulas(input);
  assert.ok(first.text.includes('$E = mc^2$'));
  assert.ok(!first.text.includes('$$E = mc^2$$'));
  assert.ok(first.text.includes('$$\\sum_{i=1}^n x_i = 10$$'));
  assert.ok(!first.text.includes('$$$$\\sum'));

  // Second pass must yield identical result
  const second = reidentifyFormulas(first.text);
  assert.equal(second.text, first.text);
  assert.equal(second.count, 0);
});

test('reidentifyFormulas: excludes programming keywords and currency values', () => {
  const input = '循环定义如下：for (int i = 0; i < n; i++)，采购预算为 $100 每件。';
  const { text, count } = reidentifyFormulas(input);
  assert.equal(count, 0);
  assert.equal(text, input);
});

test('reidentifyFormulas: handles Chinese patent formula sentences with parameters explanation', () => {
  const input = '式(1)：H = \\frac{A + B}{C}；式中：H为高度，A为基底宽度，B为侧翼厚度。';
  const { text, count } = reidentifyFormulas(input);
  assert.ok(count >= 1);
  assert.ok(text.includes('\\frac{A + B}{C}'));
  assert.ok(text.includes('式中：H为高度'));
});

test('wrapSelectionAsFormula: correctly wraps selection with $ or $$', () => {
  const text = '计算公式为 L = 2W + 5 进行设定。';
  const start = text.indexOf('L = 2W + 5');
  const end = start + 'L = 2W + 5'.length;

  const inline = wrapSelectionAsFormula(text, start, end, false);
  assert.equal(inline.text, '计算公式为 $L = 2W + 5$ 进行设定。');

  const block = wrapSelectionAsFormula(text, start, end, true);
  assert.equal(block.text, '计算公式为 $$L = 2W + 5$$ 进行设定。');
});
