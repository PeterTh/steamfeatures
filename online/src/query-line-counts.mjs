import { parseExpression, compileExpression } from './query-expression.mjs';

/** Only complete prefixes have a result count; never invent closing parentheses. */
export function expressionLineSteps(text, catalog) {
  parseExpression(text, catalog);
  const steps = []; let offset = 0;
  for (const [line, source] of text.split('\n').entries()) {
    offset += source.length;
    if (source.trim()) {
      try { steps.push({ line, end: offset, tree: parseExpression(text.slice(0, offset), catalog) }); }
      catch { /* A group, value, or operator continues on the next line. */ }
    }
    offset++;
  }
  return steps;
}

/** Count without sorting or copying games. Yield so newer queries can cancel this work. */
export async function countExpressionLines(text, prepared, library = {}, { cancelled = () => false, budgetMs = 3000, finalTotal } = {}) {
  const started = performance.now(), steps = expressionLineSteps(text, prepared), counts = [];
  let yieldedAt = started;
  const check = () => {
    if (cancelled()) return false;
    if (performance.now() - started > budgetMs) throw new Error('Line counts took too long for this query.');
    return true;
  };
  await new Promise(resolve => setTimeout(resolve, 0));
  for (const [index, step] of steps.entries()) {
    if (!check()) return null;
    let count = 0;
    if (index === steps.length - 1 && finalTotal !== undefined) count = finalTotal;
    else {
      const { matches } = compileExpression(step.tree, prepared, library);
      for (let start = 0; start < prepared.games.length; start += 2048) {
        if (!check()) return null;
        const end = Math.min(start + 2048, prepared.games.length);
        for (let i = start; i < end; i++) if (matches(prepared.games[i])) count++;
        if (performance.now() - yieldedAt >= 8) {
          await new Promise(resolve => setTimeout(resolve, 0)); yieldedAt = performance.now();
        }
      }
    }
    counts.push({ line: step.line, count });
  }
  return check() ? counts : null;
}
