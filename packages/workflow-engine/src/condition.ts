import type { ConditionExpression } from '@project-orchestrator/contracts';
export type EvaluationContext = Readonly<{ input: unknown; outputs: Readonly<Record<string, unknown>>; constants: Readonly<Record<string, unknown>> }>;
function fail(message: string): never { throw new Error(`CONDITION_EVALUATION_FAILED: ${message}`); }
function pointer(path: string, context: EvaluationContext): unknown {
  if (!path.startsWith('/')) fail('path must be a JSON pointer');
  const parts = path.slice(1).split('/').map((part) => part.replaceAll('~1','/').replaceAll('~0','~'));
  const root = parts.shift();
  let value: unknown = root === 'input' ? context.input : root === 'outputs' ? context.outputs : root === 'constants' ? context.constants : fail('illegal root');
  for (const part of parts) {
    if (value === null || typeof value !== 'object' || !(part in value)) fail(`missing path ${path}`);
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined) fail(`missing path ${path}`);
  return value;
}
const scalar = (value: unknown): value is string|number|boolean|null => value === null || ['string','number','boolean'].includes(typeof value);
export function evaluateCondition(expression: ConditionExpression | undefined, context: EvaluationContext): boolean {
  if (expression === undefined) return true;
  try {
    switch (expression.op) {
      case 'eq': { const value = pointer(expression.path, context); if (!scalar(value)) fail('eq requires scalar'); return value === expression.value; }
      case 'ne': { const value = pointer(expression.path, context); if (!scalar(value)) fail('ne requires scalar'); return value !== expression.value; }
      case 'in': { const value = pointer(expression.path, context); if (!scalar(value) || value === null) fail('in requires scalar'); return expression.values.includes(value); }
      case 'exists': pointer(expression.path, context); return true;
      case 'all': if (expression.items.length === 0) fail('all requires items'); return expression.items.every((item) => evaluateCondition(item, context));
      case 'any': if (expression.items.length === 0) fail('any requires items'); return expression.items.some((item) => evaluateCondition(item, context));
      case 'not': return !evaluateCondition(expression.item, context);
      default: return fail('unsupported operation');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CONDITION_EVALUATION_FAILED:')) throw error;
    return fail(error instanceof Error ? error.message : 'unknown error');
  }
}
