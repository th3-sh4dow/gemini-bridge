import axios from 'axios';
import {
  CUSTOM_PROVIDER,
  PROVIDERS,
  detectProviderFromKey,
  getProvider,
  normalizeProviderId,
  resolveBaseUrl
} from './providers.js';
import { ANTHROPIC_VERSION } from './translate.js';

/**
 * Validates a user's API key against the provider that issued it.
 *
 * The app calls POST /v1/llm/inspect-key when someone pastes a key into
 * settings and expects this exact response shape (Y4/O):
 *   providerId, displayName, valid, models[], recommendedModelId, setupUrl,
 *   privacyPolicy*, error, message
 *
 * Where an endpoint exists we ask the provider itself (models list for
 * Gemini/OpenAI/OpenRouter, a 1-token message for Claude) so a mistyped or
 * revoked key is caught here instead of failing mid-conversation.
 */

const PROBE_TIMEOUT_MS = Number(process.env.BRIDGE_PROBE_TIMEOUT_MS || 12000);

export const PRIVACY = {
  gemini: {
    url: 'https://policies.google.com/privacy',
    title: "Google's Privacy Policy",
    bullets: [
      'With a free Gemini API key, **Google may use your prompts and responses to improve its products**, and human reviewers may read them.',
      'With a paid key tied to active billing, **Google does not use your prompts or responses to improve products**.'
    ],
    summary:
      'Your prompts go straight from this bridge to Google using your own key; we do not store them.'
  },
  anthropic: {
    url: 'https://www.anthropic.com/legal/privacy',
    title: "Anthropic's Privacy Policy",
    bullets: [
      '**Anthropic does not train on API inputs or outputs by default.**',
      'API data is retained for a limited period for trust-and-safety purposes, then deleted.'
    ],
    summary:
      'Your prompts go straight from this bridge to Anthropic using your own key; we do not store them.'
  },
  openai: {
    url: 'https://openai.com/policies/privacy-policy',
    title: "OpenAI's Privacy Policy",
    bullets: [
      '**OpenAI does not use API data to train models by default.**',
      'API inputs and outputs are retained for up to 30 days for abuse monitoring.'
    ],
    summary: 'Your prompts go straight from this bridge to OpenAI using your own key; we do not store them.'
  },
  openrouter: {
    url: 'https://openrouter.ai/privacy',
    title: "OpenRouter's Privacy Policy",
    bullets: [
      '**OpenRouter does not store prompts or responses unless you opt in.**',
      'Requests are routed to third-party model providers; OpenRouter does not control their handling.'
    ],
    summary: 'Your prompts go straight from this bridge to OpenRouter using your own key; we do not store them.'
  },
  custom: {
    url: null,
    title: null,
    bullets: [],
    summary: null
  }
};

function failure(providerId, displayName, error, message) {
  return {
    providerId,
    displayName,
    valid: false,
    models: [],
    recommendedModelId: null,
    setupUrl: getProvider(providerId)?.setupUrl || 'https://aistudio.google.com/api-keys',
    privacyPolicyUrl: PRIVACY[providerId]?.url || null,
    privacyPolicyTitle: PRIVACY[providerId]?.title || null,
    privacyPolicyBullets: PRIVACY[providerId]?.bullets || [],
    privacyPolicySummary: PRIVACY[providerId]?.summary || null,
    error,
    message
  };
}

function success(provider, models, recommendedModelId, message, extra = {}) {
  const privacy = PRIVACY[provider.id] || PRIVACY.custom;
  return {
    providerId: provider.id,
    displayName: provider.displayName,
    valid: true,
    models: models.length ? models : [{ id: provider.defaultModel, name: provider.defaultModel }],
    recommendedModelId: recommendedModelId || provider.defaultModel,
    setupUrl: provider.setupUrl,
    privacyPolicyUrl: privacy.url,
    privacyPolicyTitle: privacy.title,
    privacyPolicyBullets: privacy.bullets,
    privacyPolicySummary: privacy.summary,
    error: null,
    message,
    ...extra
  };
}

/** GET the provider's model list, filtered to chat-capable models. */
async function listModels(provider, apiKey, baseUrl) {
  const root = resolveBaseUrl(provider, baseUrl);

  if (provider.kind === 'anthropic') {
    return provider.models || [{ id: provider.defaultModel, name: provider.defaultModel }];
  }

  if (provider.kind === 'gemini') {
    const url = `${root}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await axios.get(url, { timeout: PROBE_TIMEOUT_MS });
    return (res.data?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .filter((m) => !String(m.name || '').includes('embedding'))
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        name: m.displayName || String(m.name || '').replace(/^models\//, '')
      }))
      .filter((m) => m.id);
  }

  // OpenAI-compatible
  if (!root) return [];
  const res = await axios.get(`${root}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: PROBE_TIMEOUT_MS
  });
  const raw = res.data?.data || res.data?.models || [];
  return raw
    .map((m) => ({ id: m.id || m.name, name: m.name || m.id }))
    .filter((m) => m.id && /gpt|o1|o3|o4|claude|gemini|llama|mistral|qwen|deepseek|sonnet|haiku|opus/i.test(m.id));
}

/** Anthropic has no public model list, so we spend one token to prove the key. */
async function probeAnthropic(provider, apiKey, baseUrl, model) {
  const root = resolveBaseUrl(provider, baseUrl);
  await axios.post(
    `${root}/v1/messages`,
    {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }]
    },
    {
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      timeout: PROBE_TIMEOUT_MS
    }
  );
}

function statusOf(err) {
  return err?.response?.status;
}

function messageOf(err) {
  const data = err?.response?.data;
  return (
    data?.error?.message ||
    (typeof data?.error === 'string' ? data.error : null) ||
    data?.message ||
    err?.message ||
    'Unknown error'
  );
}

/**
 * The provider dropdown payload. Field names and optionality match the app's
 * `com.blurr.voice.byok.ProviderPreset` serializer exactly, so the client can
 * deserialize this without a single local change.
 */
export function buildProviderPresets() {
  const presets = [];
  for (const provider of [...Object.values(PROVIDERS), CUSTOM_PROVIDER]) {
    const privacy = PRIVACY[provider.id] || PRIVACY.custom;
    presets.push({
      id: provider.id,
      displayName: provider.displayName,
      tier: provider.tier,
      keyHint: provider.keyHint,
      setupUrl: provider.setupUrl,
      privacyPolicyUrl: privacy.url,
      privacyPolicyTitle: privacy.title,
      privacyPolicyBullets: privacy.bullets,
      privacyPolicySummary: privacy.summary,
      recommendedModelId: provider.defaultModel
    });
  }
  return presets;
}

export async function inspectKey(rawKey, requestedProvider) {
  const apiKey = String(rawKey || '').trim();
  if (!apiKey) {
    return failure(null, null, 'missing_key', 'Paste an API key to continue.');
  }

  const provider =
    getProvider(normalizeProviderId(requestedProvider)) ||
    detectProviderFromKey(apiKey);

  if (!provider) {
    return failure(
      null,
      null,
      'unrecognized_key',
      'That key format is not recognised. Use a Gemini, Claude, OpenAI or OpenRouter key, or pick a custom endpoint.'
    );
  }

  const baseUrl = '';
  const model = provider.defaultModel;

  try {
    if (provider.kind === 'anthropic') {
      await probeAnthropic(provider, apiKey, baseUrl, model);
    }
    const models = await listModels(provider, apiKey, baseUrl);
    return success(provider, models, provider.defaultModel, 'Key is valid.');
  } catch (err) {
    const status = statusOf(err);

    // The provider rejected the key outright.
    if (status === 401 || status === 403) {
      return failure(
        provider.id,
        provider.displayName,
        'invalid_key',
        `${provider.displayName} rejected this key. Check it was copied fully and is still active.`
      );
    }

    // Key exists but the account/credits/model may be the problem.
    if (status === 400 || status === 402 || status === 404 || status === 429) {
      return failure(provider.id, provider.displayName, 'key_rejected', messageOf(err));
    }

    // Network trouble: the key looks right, we just could not verify it now.
    return success(
      provider,
      provider.models || [],
      provider.defaultModel,
      'Key format recognised. Could not reach the provider to verify it right now.'
    );
  }
}
