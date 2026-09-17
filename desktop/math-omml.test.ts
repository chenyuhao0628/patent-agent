import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTextAndFormulas, latexToOmml } from './math-omml.ts';

test('splitTextAndFormulas handles text without formulas', () => {
  const result = splitTextAndFormulas('这是一段普通的专利技术特征说明。');
  assert.deepEqual(result, [
    { type: 'text', content: '这是一段普通的专利技术特征说明。' }
  ]);
});

test('splitTextAndFormulas detects inline formulas and display formulas', () => {
  const input = '根据公式 $E = mc^2$ 进行计算，具体如下：\n$$\\frac{a + b}{c} = 1$$\n计算完成。';
  const result = splitTextAndFormulas(input);
  assert.equal(result.length, 5);
  assert.equal(result[0].type, 'text');
  assert.equal(result[0].content, '根据公式 ');
  assert.equal(result[1].type, 'inline-math');
  assert.equal(result[1].content, 'E = mc^2');
  assert.equal(result[2].type, 'text');
  assert.equal(result[2].content, ' 进行计算，具体如下：\n');
  assert.equal(result[3].type, 'display-math');
  assert.equal(result[3].content, '\\frac{a + b}{c} = 1');
  assert.equal(result[4].type, 'text');
  assert.equal(result[4].content, '\n计算完成。');
});

test('splitTextAndFormulas handles escaped dollars \\$', () => {
  const input = '售价为 \\$100 美元，对应的压力为 $P = F/S$。';
  const result = splitTextAndFormulas(input);
  assert.equal(result.length, 3);
  assert.equal(result[0].type, 'text');
  assert.equal(result[0].content, '售价为 $100 美元，对应的压力为 ');
  assert.equal(result[1].type, 'inline-math');
  assert.equal(result[1].content, 'P = F/S');
  assert.equal(result[2].type, 'text');
  assert.equal(result[2].content, '。');
});

test('latexToOmml converts valid LaTeX to OMML XML', () => {
  const omml = latexToOmml('\\frac{a}{b}');
  assert.ok(omml);
  assert.match(omml, /<m:oMath/);
  assert.match(omml, /<m:f>/);
  assert.match(omml, /<m:num>/);
  assert.match(omml, /<m:den>/);
});

test('latexToOmml with display wraps in m:oMathPara', () => {
  const omml = latexToOmml('x^2 + y^2 = r^2', true);
  assert.ok(omml);
  assert.match(omml, /<m:oMathPara/);
  assert.match(omml, /<m:oMath/);
  assert.match(omml, /<m:sSup>/);
});

test('latexToOmml handles empty or malformed input gracefully without crashing', () => {
  assert.equal(latexToOmml(''), null);
  assert.equal(latexToOmml('   '), null);
});
