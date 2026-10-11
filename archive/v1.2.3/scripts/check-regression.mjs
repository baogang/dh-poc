import { parseArgs } from 'node:util';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJSON, readJSONL, writeJSON, now, uid, hash } from '../src/util.mjs';
import { checkRegression } from './regression-policy.mjs';
import { sourceFingerprint } from '../src/evaluate.mjs';

const { values } = parseArgs({ options: {
  suite: { type: 'string', default: 'all' }, split: { type: 'string', default: 'regression' },
  'dataset-version': { type: 'string', default: 'v1.2' },
  strategy: { type: 'string', default: 'flat' }, 'catalog-count': { type: 'string', default: '16' },
  'max-age-ms': { type: 'string', default: '3600000' }, output: { type: 'string' },
  'require-current-source': { type: 'boolean', default: false },
} });
try {
  if (!['semantic', 'planning', 'engineering', 'all'].includes(values.suite) ||
    !['all', 'dev', 'regression', 'holdout'].includes(values.split) ||
    !['v1', 'v1.1', 'v1.2'].includes(values['dataset-version'])) throw new Error('Unsupported suite, split or dataset version');
  const maxAge = Number(values['max-age-ms']);
  if (!Number.isFinite(maxAge) || maxAge <= 0) throw new Error('max-age-ms must be positive');
  const history = await readJSONL('reports/history/index.jsonl');
  const currentSource = values['require-current-source'] ? await sourceFingerprint() : null;
  const suites = values.suite === 'all' ? ['semantic', 'planning', 'engineering'] : [values.suite];
  const runs = [];
  for (const suite of suites) {
    const entry = [...history].reverse().find(item => item.suite === suite && item.split === values.split &&
      item.mode === (suite === 'engineering' ? 'offline' : 'live'));
    if (!entry) throw new Error(`No ${suite}/${values.split} run; run the evaluation first`);
    const directory = dirname(entry.report);
    const [config, summary, rows, manifest] = await Promise.all([
      readJSON(directory + '/config.json'), readJSON(directory + '/summary.json'),
      readJSON(directory + '/results.json'),
      readJSONL(`datasets/${values['dataset-version']}/${suite}/manifest.jsonl`),
    ]);
    const expectedIds = manifest.filter(item => values.split === 'all' || item.split === values.split).map(item => item.case_id);
    const result = checkRegression({ config, summary, rows, expectedIds });
    const age = Date.now() - Date.parse(summary.finished_at);
    result.checks.push({ name: 'report_freshness', passed: Number.isFinite(age) && age >= 0 && age <= maxAge,
      observed: age, required: `0..${maxAge} ms` });
    result.checks.push({ name: 'requested_configuration', passed: config.dataset_version === values['dataset-version'] &&
      config.strategy === values.strategy && config.catalog_count === Number(values['catalog-count']),
      observed: { dataset: config.dataset_version, strategy: config.strategy, catalog_count: config.catalog_count },
      required: { dataset: values['dataset-version'], strategy: values.strategy, catalog_count: Number(values['catalog-count']) } });
    if (currentSource) result.checks.push({ name: 'current_runtime_source',
      passed: config.source.hash === currentSource.hash, observed: config.source.hash, required: currentSource.hash });
    result.passed = result.checks.every(item => item.passed);
    runs.push({ suite, directory, run_id: config.run_id, source_hash: config.source.hash, ...result });
  }
  const gateFiles = ['scripts/check-regression.mjs', 'scripts/regression-policy.mjs', '.github/workflows/regression.yml', 'package.json'];
  const gateArtifacts = Object.fromEntries(await Promise.all(gateFiles.map(async path =>
    [path, hash(await readFile(path, 'utf8'))])));
  const report = { created_at: now(), passed: runs.every(run => run.passed), production_ready: false,
    source_check_mode: currentSource ? 'current_runtime' : 'recorded_historical_snapshot',
    current_source_hash: currentSource?.hash ?? null,
    gate_source: { hash: hash(gateArtifacts), files: gateArtifacts,
      note: 'Gate code, thresholds and CI hashed separately from the evaluated runtime snapshot' }, runs };
  const output = values.output ?? `reports/gates/${now().replaceAll(/[:.]/g, '-')}-${uid('gate').slice(-8)}.json`;
  await writeJSON(output, report);
  console.log(JSON.stringify({ passed: report.passed, report: output, runs: runs.map(run => ({ suite: run.suite,
    passed: run.passed, failed_checks: run.checks.filter(item => !item.passed) })) }));
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ passed: false, error: error.message }));
  process.exitCode = 1;
}
