import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CalibrationExample, CalibrationPolicy } from '@aihot/contracts/calibration';
import { calibrationTokens, evaluateCalibration, loadActiveCalibration, predictCalibration, sameCalibrationFamily, trainCalibration } from '@aihot/backend/editorial/calibration';
import type { Db } from '@aihot/backend/db';

const example = (id: string, overrides: Partial<CalibrationExample> = {}): CalibrationExample => ({ id, title: 'football', body: '', category: 'ai', selected: true, goldCategory: 'sports', goldSelected: false, ...overrides });
const train = Array.from({ length: 160 }, (_, i) => example(`train-${i}`, i < 3 ? { goldSelected: true } : i < 6 ? { title: 'rejectmarker', goldCategory: 'ai' } : { title: '', goldCategory: 'ai', goldSelected: true }));
const holdout = Array.from({ length: 40 }, (_, i) => example(`holdout-${i}`, i < 2 ? { goldSelected: true } : i < 4 ? { title: 'rejectmarker', goldCategory: 'ai' } : { title: '', goldCategory: 'ai', goldSelected: true }));

test('learns only supported consistent corrections from training and passes an independent holdout', () => {
  const policy = trainCalibration(train, 'candidate');
  assert.equal(policy.rules.length, 2);
  assert.equal(policy.rules[0]!.support, 3);
  assert.deepEqual(trainCalibration(train, 'candidate'), policy);
  const prediction = predictCalibration(policy, example('runtime'));
  assert.equal(prediction.category, 'sports');
  assert.equal(prediction.selected, true, 'cross-family classification retains the baseline selection');
  assert.equal(predictCalibration(policy, example('reject', { title: 'rejectmarker' })).selected, false);
  const report = evaluateCalibration(policy, 160, holdout);
  assert.equal(report.passed, true);
  assert.equal(report.category.corrected, 2);
  assert.equal(report.selectionAi.corrected, 2);
  assert.equal(report.selectionAi.candidateFalseSelects, 0);
  assert.equal(report.selectionNonAi.evaluated, 0);
});

test('ignores unsupported, duplicated, inconsistent labels and never learns positive selection', () => {
  assert.equal(trainCalibration([example('a'), example('b')], 'x').rules.length, 0);
  assert.equal(trainCalibration([example('a'), example('a'), example('a')], 'x').rules.length, 0);
  assert.equal(trainCalibration([example('a'), example('b'), example('c', { goldCategory: 'ai', goldSelected: true })], 'x').rules.length, 0);
  const policy = trainCalibration([example('a'), example('b'), example('c')].map(row => ({ ...row, goldCategory: 'ai', goldSelected: true, selected: false })), 'x');
  assert.equal(policy.rules.length, 0);
});

test('matches original category and complete tokens, preserves baseline for category conflicts', () => {
  const policy = trainCalibration([example('a'), example('b'), example('c')], 'x');
  assert.equal(predictCalibration(policy, example('d', { category: 'finance' })).category, 'finance');
  assert.equal(predictCalibration(policy, example('d', { title: 'footballer' })).category, 'ai');
  const conflicting: CalibrationPolicy = { ...policy, rules: [...policy.rules, { id: 'conflict', dimension: 'category', token: 'football', fromCategory: 'ai', value: 'finance', support: 3, corrected: 3 }] };
  assert.equal(predictCalibration(conflicting, example('d')).category, 'ai');
  assert.equal(predictCalibration(policy, example('d', { selected: false })).selected, false);
});

test('holdout regressions, small improvements, empty rules and missing labels prevent activation', () => {
  const policy = trainCalibration(train, 'x');
  const regressed = evaluateCalibration(policy, 160, holdout.map((row, i) => i === 0 ? { ...row, goldCategory: 'ai' } : i === 2 ? { ...row, goldSelected: true } : row));
  assert.equal(regressed.passed, false);
  assert.equal(regressed.category.regressed, 1);
  assert.equal(regressed.selectionAi.regressed, 1);
  assert.equal(evaluateCalibration(policy, 160, holdout.map((row, i) => i === 1 ? { ...row, title: '' } : row)).passed, false);
  assert.equal(evaluateCalibration({ ...policy, rules: [] }, 160, holdout).passed, false);
  assert.equal(evaluateCalibration(policy, 160, holdout.map(row => ({ ...row, goldSelected: null }))).passed, false);
  assert.equal(evaluateCalibration(policy, 160, [...holdout.slice(1), holdout[1]!]).passed, false);
});

test('reports AI and non AI selection separately including unchanged misses', () => {
  const policy = trainCalibration(train, 'x');
  const rows = holdout.map((row, i) => i > 3 ? { ...row, category: 'sports', goldCategory: 'sports', selected: false, goldSelected: true } : row);
  const report = evaluateCalibration(policy, 160, rows);
  assert.equal(report.selectionAi.corrected, 2);
  assert.equal(report.selectionNonAi.baselineMisses, 36);
  assert.equal(report.selectionNonAi.candidateMisses, 36);
  assert.equal(report.passed, true);
});

test('every rule dimension and selection family needs independent holdout corrections even if no rule matches', () => {
  const policy = trainCalibration(train, 'x');
  const noAiMatches = evaluateCalibration(policy, 160, holdout.map(row => row.title === 'rejectmarker' ? { ...row, title: 'unseenmarker' } : row));
  assert.equal(noAiMatches.category.corrected, 2);
  assert.equal(noAiMatches.selectionAi.corrected, 0);
  assert.equal(noAiMatches.passed, false);
  const withUnvalidatedNonAi: CalibrationPolicy = { ...policy, rules: [...policy.rules, { id: 'unvalidated', dimension: 'selection', fromCategory: 'finance', token: 'unseenmarker', value: false, support: 3, corrected: 3 }] };
  const report = evaluateCalibration(withUnvalidatedNonAi, 160, holdout);
  assert.equal(report.selectionAi.corrected, 2);
  assert.equal(report.category.corrected, 2);
  assert.equal(report.passed, false);
  assert(report.reasons.some(reason => reason.includes('非 AI 精选规则')));
  const unvalidatedCategory: CalibrationPolicy = { ...policy, rules: [{ id: 'unvalidated-category', dimension: 'category', fromCategory: 'finance', token: 'unseenmarker', value: 'sports', support: 3, corrected: 3 }, ...policy.rules.filter(rule => rule.dimension === 'selection')] };
  assert.equal(evaluateCalibration(unvalidatedCategory, 160, holdout).passed, false);
});

test('selection rules cannot cross AI and non AI families, but can correct within non AI categories', () => {
  for (const [before, after, expected] of [['ai', 'sports', true], ['finance', 'ai', true], ['finance', 'sports', false]] as const) {
    const policy = trainCalibration(Array.from({ length: 3 }, (_, i) => example(String(i), { category: before, goldCategory: after })), 'family');
    const result = predictCalibration(policy, example('runtime', { category: before }));
    assert.equal(result.category, after);
    assert.equal(result.selected, expected);
    assert.equal(sameCalibrationFamily(before, after), !expected);
    assert.equal(result.ruleIds.some(id => policy.rules.find(rule => rule.id === id)?.dimension === 'selection'), !expected);
  }
  assert.equal(sameCalibrationFamily(null, 'ai'), false);
});

test('features bound long material and remove stopwords; policy remains capped', () => {
  const tokens = calibrationTokens('the and 报道', '量子芯片发布');
  assert(!tokens.has('the'));
  assert(!tokens.has('报道'));
  assert(tokens.has('量子'));
  assert(tokens.has('芯片'));
  assert(calibrationTokens('x', Array.from({ length: 2000 }, (_, i) => `token${i}`).join(' ')).size <= 512);
  const rows = [example('a'), example('b'), example('c')].map(row => ({ ...row, title: Array.from({ length: 100 }, (_, i) => `token${i}`).join(' ') }));
  assert.equal(trainCalibration(rows, 'x').rules.length, 48);
});

test('active loader requires explicit state and a passed candidate', async () => {
  const policy = trainCalibration(train, 'x');
  const db = (rows: unknown[]) => (async () => rows) as unknown as Db;
  assert.equal(await loadActiveCalibration(db([])), null);
  assert.equal(await loadActiveCalibration(db([{ policy, report: { passed: false } }])), null);
  assert.deepEqual(await loadActiveCalibration(db([{ policy, report: { passed: true } }])), policy);
});
