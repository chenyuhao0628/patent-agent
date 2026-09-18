import katex from 'katex';

/**
 * Common Unicode math symbols mapped to standard LaTeX macros.
 */
const UNICODE_MATH_MAP: Record<string, string> = {
  '×': '\\times ',
  '÷': '\\div ',
  '·': '\\cdot ',
  '±': '\\pm ',
  '≠': '\\neq ',
  '≤': '\\le ',
  '≥': '\\ge ',
  '≈': '\\approx ',
  '∞': '\\infty ',
  '∂': '\\partial ',
  '√': '\\sqrt',
  '∑': '\\sum ',
  '∏': '\\prod ',
  '∫': '\\int ',
  '∈': '\\in ',
  'α': '\\alpha ',
  'β': '\\beta ',
  'γ': '\\gamma ',
  'δ': '\\delta ',
  'ε': '\\epsilon ',
  'θ': '\\theta ',
  'λ': '\\lambda ',
  'μ': '\\mu ',
  'π': '\\pi ',
  'σ': '\\sigma ',
  'τ': '\\tau ',
  'φ': '\\phi ',
  'ω': '\\omega ',
  'Δ': '\\Delta ',
  'Ω': '\\Omega ',
};

/**
 * Standardize Unicode mathematical symbols into LaTeX equivalents.
 */
export function normalizeMathChars(text: string): string {
  let result = text;
  for (const [char, replacement] of Object.entries(UNICODE_MATH_MAP)) {
    if (result.includes(char)) {
      result = result.replaceAll(char, replacement);
    }
  }
  return result;
}

/**
 * Check whether a candidate string is a valid LaTeX formula parseable by KaTeX.
 */
export function isValidLatex(latex: string): boolean {
  const trimmed = latex.replace(/^[：:，。；！？、“”‘’（）《》\s]+|[：:，。；！？、“”‘’（）《》\s]+$/g, '').trim();
  if (!trimmed) return false;
  try {
    const html = katex.renderToString(trimmed, { throwOnError: false, strict: 'ignore' });
    return !html.includes('katex-error');
  } catch {
    return false;
  }
}

/**
 * Check if a trimmed string fragment exhibits strong mathematical formula characteristics.
 */
function isFormulaCandidate(fragment: string): boolean {
  const trimmed = fragment.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 500) return false;
  // Exclude fragments with Chinese characters
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return false;
  // Exclude programming statements / keywords
  if (/\b(?:const|let|var|function|def|import|export|class|public|private|return|if|for|while|type|interface|switch|case|default|break|continue|int|float|double|char|bool|boolean|void)\b/i.test(trimmed)) return false;
  // Exclude common English prose starters
  if (/^(?:where|wherein|step|note|case|let|assuming|then|because|since|if|fig|figure|table|page|section|and|or|not|with|without|from|to|by|at|in|on|of|for)\b/i.test(trimmed)) return false;
  // Exclude pure currency e.g. "$100" or "100$" or "100 USD"
  if (/^\$?\d+(?:\.\d+)?(?:\s*(?:元|USD|EUR|RMB|\$))?$/i.test(trimmed)) return false;
  // Exclude increment / decrement operators e.g. "i++" or "++i"
  if (/^\+{2}\w+|\w+\+{2}|\-{2}\w+|\w+\-{2}$/.test(trimmed)) return false;

  // Check for distinctive mathematical markers:
  const hasRelation = /[=≠≤≥]|\\le\b|\\ge\b|\\neq\b|\\approx\b|\\sim\b|\\propto\b/.test(trimmed);
  const hasMathSymbols = /[∑∏∫±×÷·≠≤≥√∞∂∇∈∉⊂⊆∪∩∧∨¬]/.test(trimmed);
  const hasLatexMacro = /\\[a-zA-Z]+/.test(trimmed);
  const hasMathFunc = /\b(?:exp|norm|log|ln|sin|cos|tan|det|dim|max|min|arg|lim)\s*\(/i.test(trimmed);
  const hasSubOrSuper = /\b[A-Za-z]+_[a-zA-Z0-9{}]+|\b[A-Za-z]+\^[a-zA-Z0-9{}]|\^[0-9]+|_[0-9]+/.test(trimmed);
  const hasFraction = /\b[a-zA-Z0-9]+(?:\s*[\+\-\*]\s*[a-zA-Z0-9]+)*\s*\/\s*[a-zA-Z0-9]+/.test(trimmed);
  const hasGreek = /[αβγδεθλμπστφωΔΩ]/.test(trimmed);

  // If it's a simple comparison with bare < or > like "i < n", make sure it has math markers or function
  if (!hasRelation && /[<>]/.test(trimmed)) {
    if (!hasMathSymbols && !hasLatexMacro && !hasMathFunc && !hasSubOrSuper && !hasGreek) {
      return false;
    }
  }

  if (hasRelation && (hasMathSymbols || hasLatexMacro || hasMathFunc || hasSubOrSuper || hasFraction || hasGreek || /[A-Za-z]/.test(trimmed))) {
    return true;
  }
  if (hasMathSymbols || hasLatexMacro || hasMathFunc || (hasSubOrSuper && hasRelation)) {
    return true;
  }

  return false;
}

/**
 * Re-identifies plain-text / unrecognized formulas in patent text and converts them into standard LaTeX with delimiters.
 * - Idempotent: existing $...$, $$...$$, \[...\], \(...\) are strictly preserved.
 * - Segregates formulas from Chinese prose and natural punctuation.
 * - Normalizes Unicode math symbols (e.g. × -> \times).
 * - Validates with KaTeX to ensure no broken LaTeX delimiters are introduced.
 */
export function reidentifyFormulas(text: string): { text: string; count: number } {
  if (!text) return { text: '', count: 0 };

  // Step 1: Protect existing delimited formulas and escaped dollars
  const placeholders: string[] = [];
  const existingPattern = /\\\$|(?:\$\$[\s\S]+?\$\$)|(?:\\\[[\s\S]+?\\\])|(?:\$[^\$\n\r]+?\$)|(?:\\\([\s\S]+?\\\))/g;

  const protectedText = text.replace(existingPattern, match => {
    const token = `@@FORMULA_PROTECTED_${placeholders.length}@@`;
    placeholders.push(match);
    return token;
  });

  let convertedCount = 0;

  // Step 2: Process line by line
  const lines = protectedText.split('\n');
  const processedLines = lines.map(line => {
    if (!line.trim()) return line;

    // Skip entire line if it contains obvious programming structures
    if (/\b(?:for|while|if|switch|case|function|return|import|export|class)\s*\(|\b(?:const|let|var)\s+\w+\s*=/.test(line)) {
      return line;
    }

    // Check if the entire line (excluding leading list markers like "式(1):" or "其中:") is a standalone formula
    const standaloneMatch = line.match(/^(\s*(?:(?:式|公式)\s*[\(（]?\d+[\)）]?[：:]?\s*|其中[：:]?\s*)?)([^\u4e00-\u9fa5]+?)(\s*[\.,;，。；]?\s*)$/);
    if (standaloneMatch) {
      const prefix = standaloneMatch[1] ?? '';
      const rawCandidate = standaloneMatch[2].trim();
      const suffix = standaloneMatch[3] ?? '';
      const candidate = rawCandidate.replace(/^[：:，。；！？、“”‘’（）《》\s]+|[：:，。；！？、“”‘’（）《》\s]+$/g, '').trim();

      if (!candidate.includes('@@FORMULA_PROTECTED_') && isFormulaCandidate(candidate)) {
        const normalized = normalizeMathChars(candidate);
        if (isValidLatex(normalized)) {
          convertedCount++;
          return `${prefix}$$${normalized}$$${suffix}`;
        }
      }
    }

    // Process inline segments: split along Chinese text, natural punctuation and protected tokens
    const parts = line.split(/(@@FORMULA_PROTECTED_\d+@@|[\u4e00-\u9fa5]+|[，。；！？、“”‘’（）《》\(\)\[\]])/g);
    const convertedParts = parts.map(part => {
      if (!part || part.startsWith('@@FORMULA_PROTECTED_') || /[\u4e00-\u9fa5]/.test(part)) {
        return part;
      }
      const trimmed = part.replace(/^[：:，。；！？、“”‘’（）《》\s]+|[：:，。；！？、“”‘’（）《》\s]+$/g, '').trim();
      if (isFormulaCandidate(trimmed)) {
        const normalized = normalizeMathChars(trimmed);
        if (isValidLatex(normalized)) {
          convertedCount++;
          // Preserve leading and trailing whitespace and punctuation
          const leadingWs = part.slice(0, part.indexOf(trimmed));
          const trailingWs = part.slice(part.indexOf(trimmed) + trimmed.length);
          return `${leadingWs}$${normalized}$${trailingWs}`;
        }
      }
      return part;
    });

    return convertedParts.join('');
  });

  let result = processedLines.join('\n');

  // Step 3: Restore protected formulas using a replacer function to avoid $ replacement issues in string.replace
  placeholders.forEach((original, idx) => {
    result = result.replaceAll(`@@FORMULA_PROTECTED_${idx}@@`, () => original);
  });

  return { text: result, count: convertedCount };
}

/**
 * Wrap a selected portion of text with LaTeX delimiters ($ for inline, $$ for block).
 */
export function wrapSelectionAsFormula(
  text: string,
  start: number,
  end: number,
  display = false
): { text: string; newCursor: number } {
  const delimiter = display ? '$$' : '$';
  const selected = text.slice(start, end).trim();
  const before = text.slice(0, start);
  const after = text.slice(end);

  const content = selected ? normalizeMathChars(selected) : (display ? 'E = mc^2' : 'x');
  const wrapped = `${delimiter}${content}${delimiter}`;
  const newText = `${before}${wrapped}${after}`;
  const newCursor = start + wrapped.length;

  return { text: newText, newCursor };
}
