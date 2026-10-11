export const POLICY_VERSION = 'exploratory-v3.0.0';

// POC exploration thresholds. Passing this policy does not qualify production quality.
export function checkRegression({ config, summary, rows, expectedIds }) {
  const checks = [];
  const check = (name, passed, observed, required) => checks.push({ name, passed, observed, required });
  const metric = (name, value, minimum) => check(name,
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= 1,
    value ?? null, `>= ${minimum}, finite rate`);
  check('run_finished', summary.status === 'finished', summary.status, 'finished');
  check('suite_matches', summary.suite === config.suite, summary.suite, config.suite);
  check('source_consistent', summary.source_consistent === true &&
    typeof config.source?.hash === 'string' && config.source.hash === summary.source_end_hash,
    summary.source_end_hash ?? null, config.source?.hash ?? 'missing source hash');
  check('execution_mode', config.mode === (config.suite === 'engineering' ? 'offline' : 'live'),
    config.mode, config.suite === 'engineering' ? 'offline' : 'live');
  const ids = rows.map(row => row.case_id);
  const sameIds = candidate => Array.isArray(candidate) && candidate.length === expectedIds.length &&
    new Set(candidate).size === expectedIds.length && expectedIds.every(id => candidate.includes(id));
  check('frozen_case_coverage', expectedIds.length > 0 && sameIds(ids) && sameIds(config.selected_case_ids) &&
    summary.metrics?.cases === expectedIds.length, { results: rows.length, summary: summary.metrics?.cases,
    expected: expectedIds.length }, 'every frozen case in the selected split, exactly once');
  check('executor_errors', rows.every(row => !row.error), rows.filter(row => row.error).length, 0);
  const m = summary.metrics ?? {};
  if (config.suite === 'emotion') {
    metric('final_schema_evidence_validity', m.valid_rate, 1);
    metric('sentiment_macro_f1', m.sentiment?.macro_f1, .85);
    check('core_scoring_contract', m.definition?.startsWith('Core match=') &&
      Array.isArray(Object.keys(m.sentiment?.per_label??{})) &&
      ['positive','neutral','negative'].every(k=>k in (m.sentiment?.per_label??{})) &&
      Object.keys(m.sentiment?.per_label??{}).length===3 &&
      !('indicators' in m) && !('emotions' in m), m.definition??null, 'V3 core pair and three labels only');
  } else if (config.suite === 'planning') {
    metric('task_pass_rate', m.task_pass_rate, .85);
    metric('operation_precision', (m.tool_selection??m.operation_selection)?.precision, .9);
    metric('operation_recall', (m.tool_selection??m.operation_selection)?.recall, .9);
  } else if (config.suite === 'engineering') {
    metric('engineering_contract_pass_rate', m.pass_rate, 1);
  } else check('supported_suite', false, config.suite, 'emotion|planning|engineering');
  return { policy_version: POLICY_VERSION, passed: checks.every(item => item.passed), checks,
    production_ready: false,
    retired_checks: {scenario_indicators:'Removed from runtime and scoring by task card 1; historical gates retained.',diagnostic_emotions:'Runtime capability retained; quality scoring retired by task card 3.'},
    scope: 'exploratory V3 regression only; synthetic provisional labels require expert review. Sentiment Macro-F1 >= .85 and final contract validity = 1 retained. New clarification metrics are reported without an invented acceptance threshold.' };
}
