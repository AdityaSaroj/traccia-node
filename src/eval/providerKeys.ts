/**
 * Provider credentials for platform LLM-judge and Jev scorers.
 * Values come from the environment and are never printed.
 */

const PROVIDER_ENV: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  typesafe: ['TYPESAFE_API_KEY'],
  xai: ['XAI_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
};

export function providerKeysFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [provider, names] of Object.entries(PROVIDER_ENV)) {
    for (const name of names) {
      const value = String(env[name] || '').trim();
      if (value) {
        keys[provider] = value;
        break;
      }
    }
  }
  const raw = String(env.TRACCIA_PROVIDER_KEYS || '').trim();
  if (!raw) return keys;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TRACCIA_PROVIDER_KEYS must be a JSON object of provider names to API keys');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TRACCIA_PROVIDER_KEYS must be a JSON object of provider names to API keys');
  }
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const text = String(value || '').trim();
    const provider = String(name || '').trim().toLowerCase();
    if (provider && text) keys[provider] = text;
  }
  return keys;
}
