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

test('splitTextAndFormulas auto-promotes naked formula lines to display-math', () => {
  const f1 = 'W_t = exp(-( (1/(N(N-1)))·∑_{k=1}^{N}∑_{h≠k}^{N-1}(L_{t,k,h}-\\bar{L}_t)^2 ))';
  const res1 = splitTextAndFormulas(f1);
  assert.equal(res1.length, 1);
  assert.equal(res1[0].type, 'display-math');
  assert.equal(res1[0].content, f1);

  // OMML conversion also succeeds
  const omml1 = latexToOmml(res1[0].content, true);
  assert.ok(omml1);
  assert.match(omml1, /<m:oMathPara/);

  const f2 = 'a_k = { a×(1+norm(D_k)/∑_{i=1}^{n-1}P_ki), norm(D_k)>0.6; a, norm(D_k)≤0.6 }';
  const res2 = splitTextAndFormulas(f2);
  assert.equal(res2.length, 1);
  assert.equal(res2[0].type, 'display-math');
  assert.equal(res2[0].content, f2);

  const f3 = 'P = \\frac{F}{S}';
  const res3 = splitTextAndFormulas(f3);
  assert.equal(res3.length, 1);
  assert.equal(res3[0].type, 'display-math');
});

test('splitTextAndFormulas rejects non-formula text from being falsely promoted', () => {
  const negativeCases = [
    'wherein L_t is a threshold value;',
    'const x_val = 100;',
    'let w_t = get_weight();',
    '步骤S101：计算综合参数 W_t = exp(...)；',
    '这是一段普通的专利说明。',
    'a = b',
    'import { foo } from "bar";',
  ];

  for (const text of negativeCases) {
    const res = splitTextAndFormulas(text);
    assert.equal(res.length, 1, `Failed on: ${text}`);
    assert.equal(res[0].type, 'text', `Expected text for: ${text}, got: ${res[0].type}`);
  }
});
