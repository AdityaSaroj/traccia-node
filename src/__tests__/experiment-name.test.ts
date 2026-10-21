import { experimentName } from '../eval/experimentName';

describe('experiment name', () => {
  test('a task script uses the dataset name plus eval', () => {
    expect(experimentName({ dataset: 'ci-manual', script: 'task.py', env: {} })).toBe('ci-manual eval');
  });

  test('a meaningful script name is the subject', () => {
    expect(experimentName({ dataset: 'support-golden', script: 'experiments/support_agent.py', env: {} })).toBe(
      'support_agent eval',
    );
  });

  test('a branch is appended and an explicit name wins', () => {
    expect(
      experimentName({ dataset: 'ci-manual', script: 'task.py', env: { TRACCIA_GIT_HEAD_REF: 'feat/tone' } }),
    ).toBe('ci-manual eval · feat/tone');
    expect(
      experimentName({
        name: 'Refund Check',
        dataset: 'ci-manual',
        script: 'task.py',
        env: { TRACCIA_GIT_HEAD_REF: 'feat/tone' },
      }),
    ).toBe('Refund Check');
  });
});
