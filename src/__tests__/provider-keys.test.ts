import { providerKeysFromEnv } from '../eval/providerKeys';

describe('provider keys', () => {
  test('maps known environment variables and a JSON override', () => {
    const keys = providerKeysFromEnv({
      OPENAI_API_KEY: 'sk-test-forward',
      GOOGLE_API_KEY: 'g-test',
      TRACCIA_PROVIDER_KEYS: '{"typesafe":"ts-test-forward"}',
    });
    expect(keys.openai).toBe('sk-test-forward');
    expect(keys.gemini).toBe('g-test');
    expect(keys.typesafe).toBe('ts-test-forward');
  });

  test('rejects a JSON value without repeating it', () => {
    expect(() => providerKeysFromEnv({ TRACCIA_PROVIDER_KEYS: '{"openai":"sk-test-secret"' })).toThrow(
      'TRACCIA_PROVIDER_KEYS must be a JSON object',
    );
    try {
      providerKeysFromEnv({ TRACCIA_PROVIDER_KEYS: '{"openai":"sk-test-secret"' });
    } catch (err: any) {
      expect(String(err.message)).not.toContain('sk-test-secret');
    }
  });
});
