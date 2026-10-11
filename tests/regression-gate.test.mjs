import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRegression } from '../scripts/regression-policy.mjs';

function fixture(suite = 'engineering') {
  return { config: { suite, split: 'all', mode: suite === 'engineering' ? 'offline' : 'live',
    source: { hash: 'frozen' }, selected_case_ids: ['A', 'B'] }, expectedIds: ['A', 'B'],
  rows: [{ case_id: 'A' }, { case_id: 'B' }], summary: { suite, status: 'finished',
    source_consistent: true, source_end_hash: 'frozen', metrics: { cases: 2, pass_rate: 1,
      task_pass_rate: 1, operation_selection: { precision: 1, recall: 1 }, valid_rate: 1,
      definition:'Core match=(sentiment + assessment_status correct)/all referenced cases.',
      sentiment: { macro_f1: .9,per_label:{positive:{},neutral:{},negative:{}} } } } };

}
test('passing engineering evidence remains scoped to exploration', () => {
  const result = checkRegression(fixture());
  assert.equal(result.passed, true); assert.equal(result.production_ready, false);
});
test('null precision cannot silently pass a model regression gate', () => {
  const input = fixture('planning'); input.summary.metrics.operation_selection.precision = null;
  assert.equal(checkRegression(input).passed, false);
});
test('full-count duplicate case cannot hide an omitted frozen case', () => {
  const input = fixture(); input.rows[1].case_id = 'A';
  assert.equal(checkRegression(input).passed, false);
});
test('all rows and summary must be present and source must match', () => {
  const input = fixture(); input.summary.source_end_hash = 'different';
  assert.equal(checkRegression(input).passed, false);
  input.summary.source_end_hash = 'frozen'; input.rows.pop();
  assert.equal(checkRegression(input).passed, false);
});
test('three-class sentiment threshold remains; retired fields do not create requirements',()=>{
 const input=fixture('emotion');input.summary.metrics.sentiment.macro_f1=.8363;
 assert.ok(checkRegression(input).checks.some(c=>c.name==='sentiment_macro_f1'&&!c.passed));
 input.summary.metrics.sentiment.macro_f1=.9;const result=checkRegression(input);assert.equal(result.passed,true);
 assert(!result.checks.some(c=>/SA0|emotion_macro/.test(c.name)));assert(result.retired_checks.diagnostic_emotions);
});
test('executor errors fail even when an inconsistent summary reports perfect scores', () => {
  const input = fixture(); input.rows[1].error = { code: 'HTTP_ERROR' };
  assert.equal(checkRegression(input).passed, false);
});
test('incomplete or explicitly inconsistent source reports fail closed', () => {
  const input = fixture(); input.summary.status = 'incomplete';
  assert.equal(checkRegression(input).passed, false);
  input.summary.status = 'finished'; input.summary.source_consistent = false;
  assert.equal(checkRegression(input).passed, false);
});
test('a reduced reported denominator cannot pass complete frozen coverage', () => {
  const input = fixture(); input.summary.metrics.cases = 1;
  assert.equal(checkRegression(input).passed, false);
});
