export const POLICY_VERSION = 'exploratory-v1.0.0';

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
  if (config.suite === 'semantic') {
    metric('final_schema_evidence_validity', m.valid_rate, 1);
    metric('sentiment_macro_f1', m.sentiment?.macro_f1, .85);
    metric('emotion_macro_f1', m.emotions?.macro_f1, .8);
    for (const label of ['SA01', 'SA02', 'SA03', 'SA04', 'SA05']) {
      const item = m.indicators?.per_label?.[label];
      metric(`${label}_precision`, item?.precision, .85);
      metric(`${label}_recall`, item?.recall, label === 'SA04' ? .95 : .85);
      const support = label === 'SA04' && config.split === 'all' ? 30 : 1;
      check(`${label}_positive_support`, Number.isInteger(item?.support) && item.support >= support,
        item?.support ?? null, `>= ${support}`);
    }
  } else if (config.suite === 'planning') {
    metric('task_pass_rate', m.task_pass_rate, .85);
    metric('operation_precision', m.operation_selection?.precision, .9);
    metric('operation_recall', m.operation_selection?.recall, .9);
  } else if (config.suite === 'engineering') {
    metric('engineering_contract_pass_rate', m.pass_rate, 1);
  } else check('supported_suite', false, config.suite, 'semantic|planning|engineering');
  return { policy_version: POLICY_VERSION, passed: checks.every(item => item.passed), checks,
    production_ready: false,
    scope: 'exploratory regression only; provisional labels, intent ontology and production acceptance remain separate' };
}
