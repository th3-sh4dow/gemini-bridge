/**
 * Provider registry.
 *
 * Mirrors the app's bundled copy of `assets/byok_llm_providers.json` so the
 * client and this bridge agree on provider ids, key prefixes, default models
 * and upstream base URLs. If you add a provider here, add it there too.
 *
 * `kind` tells the proxy how to talk to the upstream:
 *   - gemini    -> generativelanguage.googleapis.com native REST
 *   - anthropic -> api.anthropic.com /v1/messages
 *   - openai    -> OpenAI-compatible /chat/completions (OpenAI, OpenRouter,
 *                  Groq, Together, vLLM, Ollama, LM Studio, ...)
 */

export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    tier: 2,
    keyHint: 'AIza...',
    setupUrl: 'https://aistudio.google.com/api-keys',
    kind: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    envBaseUrl: 'GEMINI_BASE_URL',
    defaultModel: 'gemini-3.1-flash-lite',
    prefixes: ['AIza']
  },

  anthropic: {
    id: 'anthropic',
    displayName: 'Claude',
    tier: 2,
    keyHint: 'sk-ant-...',
    setupUrl: 'https://console.anthropic.com/settings/keys',
    kind: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    envBaseUrl: 'ANTHROPIC_BASE_URL',
    defaultModel: 'claude-haiku-4-5-20251001',
    prefixes: ['sk-ant-'],
    models: [
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
      { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku' },
      { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet' }
    ]
  },

  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    tier: 1,
    keyHint: 'sk-or-...',
    setupUrl: 'https://openrouter.ai/keys',
    kind: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    envBaseUrl: 'OPENROUTER_BASE_URL',
    defaultModel: 'google/gemini-3.1-flash-lite',
    prefixes: ['sk-or-']
  },

  openai: {
    id: 'openai',
    displayName: 'ChatGPT',
    tier: 2,
    keyHint: 'sk-...',
    setupUrl: 'https://platform.openai.com/api-keys',
    kind: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    envBaseUrl: 'OPENAI_BASE_URL',
    defaultModel: 'gpt-4o-mini',
    prefixes: ['sk-proj-', 'sk-']
  }
};

/**
 * Covers "any OpenAI-compatible endpoint" (Groq, Together, DeepSeek, a local
 * Ollama/LM Studio, a company gateway...). Never auto-detected: the client has
 * to name it explicitly, because we cannot guess a key format for it.
 */
export const CUSTOM_PROVIDER = {
  id: 'custom',
  displayName: 'Custom endpoint',
  tier: 2,
  keyHint: 'your-provider-key',
  setupUrl: '',
  kind: 'openai',
  defaultBaseUrl: null,
  defaultModel: 'gpt-4o-mini',
  prefixes: []
};

// Same order the app uses in detectOrder: cheapest/most specific first.
const DETECT_ORDER = ['openrouter', 'anthropic', 'gemini', 'openai'];

/** Normalize a provider id coming from the client (`x-provider`). */
export function normalizeProviderId(raw) {
  const id = String(raw || '').trim().toLowerCase();
  if (!id) return null;
  if (id === 'anthropic' || id === 'claude') return 'anthropic';
  if (id === 'openai' || id === 'chatgpt' || id === 'gpt') return 'openai';
  if (id === 'google' || id === 'gemini') return 'gemini';
  if (id === 'openrouter') return 'openrouter';
  if (id === 'custom' || id === 'openai-compatible' || id === 'compatible') return 'custom';
  return id;
}

export function getProvider(rawId) {
  const id = normalizeProviderId(rawId);
  if (!id) return null;
  if (PROVIDERS[id]) return PROVIDERS[id];
  if (id === 'custom') return CUSTOM_PROVIDER;
  return null;
}

/**
 * Work out which provider a bare key belongs to, using the same prefixes as the
 * app. Order matters: `sk-ant-` and `sk-or-` must win over the generic `sk-`.
 */
export function detectProviderFromKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  for (const id of DETECT_ORDER) {
    const provider = PROVIDERS[id];
    if (provider.prefixes.some((p) => key.startsWith(p))) return provider;
  }
  return null;
}

/** Model to use: explicit client choice, else the provider's default. */
export function resolveModel(provider, explicitModel) {
  const model = String(explicitModel || '').trim();
  if (model) return model;
  return provider?.defaultModel || 'gemini-3.1-flash-lite';
}

/**
 * Base URL to use: the client's own override (custom endpoints / self-hosted
 * gateways) wins, then an env override, then the provider default.
 */
export function resolveBaseUrl(provider, headerBaseUrl) {
  const fromClient = String(headerBaseUrl || '').trim();
  if (fromClient) return fromClient.replace(/\/+$/, '');
  if (provider?.envBaseUrl && process.env[provider.envBaseUrl]) {
    return String(process.env[provider.envBaseUrl]).replace(/\/+$/, '');
  }
  return provider?.defaultBaseUrl || null;
}
