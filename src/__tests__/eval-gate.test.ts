import * as fs from 'fs';
import * as path from 'path';
import { applyBaseline, decide, preflight, reportFromRows, validateBaseline } from '../eval/gate';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ci_gate_cases.json'), 'utf8'),
);

describe('ci gate', () => {
  test('shared fixture codes match Python', () => {
    for (const item of fixture) {
      const outcome = decide(item.report);
      expect(outcome.exit_code).toBe(item.exit_code);
      if ('code' in item) expect(outcome.code).toBe(item.code);
      if ('quality_gate' in item) expect(outcome.quality_gate).toBe(item.quality_gate);
    }
  });

  test('preflight rules', () => {
    expect(preflight({ scorers: [], min_pass_rate: 0.9 })?.code).toBe('no_scorer');
    expect(preflight({ scorers: ['exact_match'], max_drop: 0.05 })?.code).toBe('baseline_required');
    expect(
      preflight({
        scorers: ['exact_match'],
        baseline_prompt: 'support',
        baseline_experiment: 'exp',
        max_drop: 0.05,
      })?.code,
    ).toBe('baseline_conflict');
    expect(preflight({ scorers: ['exact_match'], informational: ['tone'], min_pass_rate: 0.9 })?.code).toBe(
      'unknown_scorer',
    );
    expect(preflight({ scorers: ['tone'], informational: ['tone'], min_pass_rate: 0.9 })?.code).toBe('no_scorer');
    expect(preflight({ scorers: ['exact_match'], min_pass_rate: 0.9 })).toBeNull();
  });

  test('missing judgment is incomplete coverage', () => {
    const rows = [
      { item_id: 'a', panels: [{ scores: [{ name: 'exact_match', passed: true, score: 1 }] }] },
      { item_id: 'b', panels: [{ scores: [] }] },
    ];
    const scorers = reportFromRows(rows, [], undefined, ['exact_match']);
    expect(scorers[0].expected).toBe(2);
    expect(scorers[0].missing).toBe(1);
    const outcome = decide({ rows, min_pass_rate: 0.9, dataset_verified: true, scorers });
    expect(outcome.exit_code).toBe(3);
    expect(outcome.code).toBe('scorer_coverage');
  });

  test('unverified dataset is not a quality gate', () => {
    const outcome = decide({
      rows: [{ item_id: 'a' }],
      min_pass_rate: 0.9,
      dataset_verified: false,
      scorers: [{ name: 'exact_match', pass_rate: 1, expected: 1, completed: 1, missing: 0, errored: 0 }],
    });
    expect(outcome.exit_code).toBe(3);
    expect(outcome.quality_gate).toBe(false);
    expect(outcome.code).toBe('dataset_unverified');
  });

  test('baseline evidence is scoped to the selected panel', () => {
    const evidence = [
      { name: 'faithfulness', panel_index: 0, verified: false },
      { name: 'faithfulness', panel_index: 1, verified: true },
    ];
    const scorers = [{ name: 'faithfulness', pass_rate: 1, definition_hash: 'sha256:h' }];
    const options = { baseline_experiment: 'exp', scorers: ['faithfulness'], max_drop: 0.05 };
    expect(
      validateBaseline({ panel_index: 0, dataset_verified: true, scorers, scorer_evidence: evidence }, options)?.code,
    ).toBe('scorer_unverified');
    expect(
      validateBaseline({ panel_index: 1, dataset_verified: true, scorers, scorer_evidence: evidence }, options),
    ).toBeNull();
    const report: Record<string, any> = {
      rows: [{ item_id: 'a' }],
      max_drop: 0.05,
      dataset_verified: true,
      dataset_fingerprint: 'same',
      scorers: [{
        name: 'faithfulness',
        pass_rate: 1,
        definition_hash: 'sha256:h',
        expected: 1,
        completed: 1,
        missing: 0,
        errored: 0,
      }],
    };
    applyBaseline(report, { panel_index: 0, dataset_fingerprint: 'same', scorers, scorer_evidence: evidence });
    expect(report.scorers[0].verified).toBe(false);
    expect(decide(report).code).toBe('scorer_unverified');
  });

  test('renamed scorer still requires evidence for its id', () => {
    const options = { baseline_experiment: 'exp', scorers: ['new-name'], max_drop: 0.05 };
    const baseline = {
      panel_index: 0,
      dataset_verified: true,
      scorers: [{ name: 'new-name', scorer_id: 'sc-1', pass_rate: 1, definition_hash: 'sha256:h' }],
      scorer_evidence: [{ name: 'old-name', scorer_id: 'sc-1', panel_index: 0, verified: false }],
    };
    expect(validateBaseline(baseline, options)?.code).toBe('scorer_unverified');
    expect(validateBaseline({ ...baseline, scorer_evidence: [] }, options)?.code).toBe('scorer_unverified');
    expect(
      validateBaseline(
        {
          ...baseline,
          scorer_evidence: [{ name: 'old-name', scorer_id: 'sc-1', panel_index: 0, verified: true }],
        },
        options,
      ),
    ).toBeNull();
    const report: Record<string, any> = {
      rows: [{ item_id: 'a' }],
      max_drop: 0.05,
      dataset_verified: true,
      dataset_fingerprint: 'same',
      scorers: [{
        name: 'new-name',
        pass_rate: 1,
        definition_hash: 'sha256:h',
        expected: 1,
        completed: 1,
        missing: 0,
        errored: 0,
      }],
    };
    applyBaseline(report, { ...baseline, dataset_fingerprint: 'same' });
    expect(report.scorers[0].verified).toBe(false);
    expect(decide(report).code).toBe('scorer_unverified');
  });

  test('concurrency override keeps the latency limit', () => {
    const report: Record<string, any> = {
      rows: [{ item_id: 'a', panels: [{ latency_ms: 1000, task_cost: { usd: 0, coverage: 'complete' }, scores: [] }] }],
      max_latency_increase: 0.2,
      allow_concurrency_mismatch: true,
      latency_concurrency: 8,
      dataset_fingerprint: 'same',
      scorers: [],
    };
    applyBaseline(report, { dataset_fingerprint: 'same', mean_latency_ms: 10, latency_concurrency: 1, scorers: [] });
    expect(report.latency_concurrency_mismatch).toBe(true);
    expect(report.latency_increase).toBe(99);
    const outcome = decide(report);
    expect(outcome.exit_code).toBe(1);
    expect(outcome.code).toBe('latency_increase');
  });

  test('partial judge cost fails and duplicate hashes match', () => {
    const partial: Record<string, any> = {
      rows: [{
        item_id: 'a',
        panels: [{
          scores: [
            { type: 'llm_judge', definition_hash: 'h', invocation: { id: 'one', cost_usd: 1 } },
            { type: 'llm_judge', definition_hash: 'h' },
          ],
        }],
      }],
      max_judge_cost_increase: 0.2,
      dataset_fingerprint: 'same',
      scorers: [],
    };
    const baseline = {
      dataset_fingerprint: 'same',
      judge_cost_usd: 2,
      judge_cost_coverage: 'complete',
      judge_definition_hashes: ['h'],
      scorers: [],
    };
    applyBaseline(partial, baseline);
    expect(decide(partial).code).toBe('cost_incomplete');

    const same: Record<string, any> = {
      rows: [{
        item_id: 'a',
        panels: [{
          scores: [
            { type: 'llm_judge', definition_hash: 'h', invocation: { id: 'one', cost_usd: 1 } },
            { type: 'llm_judge', definition_hash: 'h', invocation: { id: 'one', cost_usd: 1 } },
          ],
        }],
      }],
      max_judge_cost_increase: 0.2,
      dataset_fingerprint: 'same',
      scorers: [],
    };
    applyBaseline(same, { ...baseline, judge_cost_usd: 1 });
    expect(same.judge_workload_mismatch).toBeUndefined();
    expect(same.judge_cost_increase).toBe(0);
  });

  test('unhashed local scorer is not hidden by baseline preflight', () => {
    const baseline = {
      panel_index: 0,
      dataset_verified: true,
      scorers: [{ name: 'exact_match', pass_rate: 1, definition_hash: 'sha256:exact' }],
      scorer_evidence: [{ name: 'exact_match', panel_index: 0, verified: true }],
    };
    const options = {
      baseline_experiment: 'exp',
      scorers: ['local:accuracy'],
      max_drop: 0.05,
      unhashed_scorers: ['accuracy'],
    };
    expect(validateBaseline(baseline, options)).toBeNull();
    expect(validateBaseline(baseline, { ...options, scorers: ['accuracy'], unhashed_scorers: [] })?.code).toBe('baseline_missing');
    const outcome = decide({
      rows: [{ item_id: 'a' }],
      max_drop: 0.05,
      scorers: [{
        name: 'accuracy',
        definition_identity: 'source_fallback',
        pass_rate: 1,
        expected: 1,
        completed: 1,
        missing: 0,
        errored: 0,
        verified: false,
      }],
    });
    expect(outcome.exit_code).toBe(3);
    expect(outcome.code).toBe('scorer_definition_unhashed');
    expect(outcome.quality_gate).toBe(false);
  });

  test('renamed scorer matches its baseline by id', () => {
    const baseline = {
      panel_index: 0,
      dataset_verified: true,
      dataset_fingerprint: 'same',
      scorers: [{ name: 'ci-rename', scorer_id: 'sc-1', pass_rate: 1, definition_hash: 'sha256:h' }],
      scorer_evidence: [{
        name: 'ci-rename',
        scorer_id: 'sc-1',
        panel_index: 0,
        verified: true,
        definition_hash: 'sha256:h',
      }],
    };
    const options = {
      baseline_experiment: 'exp',
      scorers: ['ci-rename-v2'],
      max_drop: 0.05,
      scorer_ids: { 'ci-rename-v2': 'sc-1' },
    };
    expect(validateBaseline(baseline, options)).toBeNull();
    expect(validateBaseline(baseline, { ...options, scorer_ids: {} })?.code).toBe('baseline_missing');
    const rows = [{
      item_id: 'a',
      panels: [{
        scores: [{
          scorer_name: 'ci-rename-v2',
          scorer_id: 'sc-1',
          passed: true,
          score: 1,
          status: 'judged',
          definition_hash: 'sha256:h',
        }],
      }],
    }];
    const report: Record<string, any> = {
      rows,
      max_drop: 0.05,
      dataset_verified: true,
      dataset_fingerprint: 'same',
      scorers: reportFromRows(rows, [], undefined, ['ci-rename-v2']),
    };
    expect(report.scorers[0].scorer_id).toBe('sc-1');
    applyBaseline(report, baseline);
    const outcome = decide(report);
    expect(report.scorers[0].baseline_pass_rate).toBe(1);
    expect(outcome.exit_code).toBe(0);
    expect(outcome.quality_gate).toBe(true);
  });

  test('a scorer selected by id is grouped under its result name', () => {
    const scorerId = '11111111-1111-1111-1111-111111111111';
    const rows = [{
      item_id: 'a',
      panels: [{
        scores: [{
          scorer_name: 'accuracy',
          scorer_id: scorerId,
          status: 'judged',
          score: 1,
          passed: true,
        }],
      }],
    }];
    const scorers = reportFromRows(rows, [scorerId], undefined, [scorerId]);
    expect(scorers.map((row) => row.name)).toEqual(['accuracy']);
    expect(scorers[0].missing).toBe(0);
    expect(scorers[0].pass_rate).toBe(1);
    expect(scorers[0].informational).toBe(true);
  });

  test('each Jev question has its own pass rate', () => {
    const questions = Array.from({ length: 9 }, (_, i) => ({
      key: `q${i}`,
      status: 'judged',
      passed: true,
      score: 1,
    }));
    questions.push({ key: 'q9', status: 'judged', passed: false, score: 0 });
    const rows = [{
      item_id: 'a',
      panels: [{ scores: [{ scorer_name: 'rubric', role: 'summary', questions }] }],
    }];
    const scorers = reportFromRows(rows, [], undefined, ['rubric']);
    expect(scorers).toHaveLength(10);
    expect(scorers.find((row) => row.name === 'rubric:q9')?.pass_rate).toBe(0);
    expect(scorers.find((row) => row.name === 'rubric:q0')?.pass_rate).toBe(1);
    const outcome = decide({ rows, min_pass_rate: 0.9, dataset_verified: true, scorers });
    expect(outcome.exit_code).toBe(1);
    expect(outcome.code).toBe('threshold_missed');
  });
});
