import axios from 'axios';
import {
  CUSTOM_PROVIDER,
  detectProviderFromKey,
  getProvider,
  resolveBaseUrl,
  resolveModel
} from './providers.js';
import {
  ANTHROPIC_VERSION,
  extractContents,
  fromAnthropicResponse,
  fromGeminiResponse,
  fromOpenAIResponse,
  toAnthropicRequest,
  toOpenAIRequest
} from './translate.js';

/**
 * The one place that talks to model providers on the user's behalf.
 *
 * The app sends its own key on every call; we forward it to whichever provider
 * that key belongs to and hand the reply back in the Gemini shape the app
 * parses. No key, no credits, no subscription gate lives here — the user pays
 * their provider directly, we never sit in the billing path.
 *
 * Headers the app sends (see Z5/x, Z5/N0, Z5/C1808e, Y4/W, Y5/i):
 *   x-custom-gemini-key   Gemini-only BYOK key
 *   x-provider            provider id ("gemini" | "anthropic" | "openai" | "openrouter")
 *   x-provider-api-key    the user's key for that provider
 *   x-provider-model      model id
 *   x-provider-base-url   optional custom endpoint (Ollama, Groq, gateway, ...)
 */

const LOG = (process.env.BRIDGE_LOG || '_minimal_').toLowerCase();
const REQUEST_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 60000);

function log(...args) {
  if (LOG === '_verbose_') console.log('[bridge]', ...args);
}

function logBody(label, obj) {
  if (LOG !== '_verbose_') return;
  try {
    console.log(`[bridge] ${label}:`, JSON.stringify(obj).slice(0, 1200));
  } catch {
    /* ignore unserializable */
  }
}

class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UpstreamError';
    this.upstreamStatus = status;
  }
}

/**
 * Work out the key and the provider from the request headers.
 * An explicit `x-provider` wins; otherwise we infer from the key's shape.
 */
export function resolveCredentials(headers = {}) {
  const rawProvider = String(headers['x-provider'] || '').trim();
  const providerKeyHeader = String(headers['x-provider-api-key'] || '').trim();
  const geminiKeyHeader = String(headers['x-custom-gemini-key'] || '').trim();
  const model = String(headers['x-provider-model'] || '').trim();
  const baseUrl = String(headers['x-provider-base-url'] || '').trim();

  const apiKey = providerKeyHeader || geminiKeyHeader || '';

  let provider = getProvider(rawProvider);
  if (!provider && apiKey) provider = detectProviderFromKey(apiKey);
  if (!provider && providerKeyHeader && baseUrl) provider = CUSTOM_PROVIDER;

  // Gemini's own header can only ever mean Gemini.
  if (!rawProvider && geminiKeyHeader) provider = getProvider('gemini');

  return {
    provider,
    apiKey,
    model,
    baseUrl,
    usedByok: Boolean(apiKey)
  };
}

function upstreamErrorMessage(err, fallback) {
  const data = err?.response?.data;
  const message =
    data?.error?.message ||
    (typeof data?.error === 'string' ? data.error : null) ||
    data?.message ||
    err?.message ||
    fallback;
  return typeof message === 'string' ? message : JSON.stringify(message);
}

/** Gemini native REST: key goes in the query string. */
async function callGemini({ provider, apiKey, model, baseUrl }, body, pathSuffix) {
  const root = resolveBaseUrl(provider, baseUrl);
  const suffix = pathSuffix === 'generateMemories' ? 'generateContent' : pathSuffix;
  const url = `${root}/v1beta/models/${encodeURIComponent(model)}:${suffix}?key=${encodeURIComponent(apiKey)}`;

  const contents = extractContents(body);
  const payload = { ...body, contents };
  delete payload.noCredits;
  delete payload.model;

  log('gemini ->', url.replace(/key=[^&]+/, 'key=***'));
  const response = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS
  });
  return fromGeminiResponse(response.data);
}

/** Anthropic Messages API: x-api-key header + required version header. */
async function callAnthropic({ provider, apiKey, model, baseUrl }, body) {
  const root = resolveBaseUrl(provider, baseUrl);
  const url = `${root}/v1/messages`;
  const payload = toAnthropicRequest(body, model);

  log('anthropic ->', url, 'model:', model, 'msgs:', payload.messages.length);
  const response = await axios.post(url, payload, {
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    timeout: REQUEST_TIMEOUT_MS
  });
  return fromAnthropicResponse(response.data);
}

/** OpenAI-compatible Chat Completions (OpenAI, OpenRouter, Groq, Ollama, ...). */
async function callOpenAICompatible({ provider, apiKey, model, baseUrl }, body) {
  const root = resolveBaseUrl(provider, baseUrl) || 'https://api.openai.com/v1';
  const url = `${root}/chat/completions`;
  const payload = toOpenAIRequest(body, model);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  // OpenRouter asks for identifying headers; harmless elsewhere.
  if (provider?.id === 'openrouter') {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL || 'https://github.com/';
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME || 'Panda BYOK';
  }

  log('openai-compatible ->', url, 'provider:', provider?.id, 'model:', model);
  const response = await axios.post(url, payload, {
    headers,
    timeout: REQUEST_TIMEOUT_MS
  });
  return fromOpenAIResponse(response.data);
}

/**
 * handleGenerateContent — the single entry point for every LLM call.
 * Returns a Gemini-shaped object the app already knows how to parse.
 */
export async function handleGenerateContent(req, pathSuffix = 'generateContent') {
  const started = Date.now();
  const creds = resolveCredentials(req.headers);
  const body = req.body || {};

  log('request', req.path, {
    provider: creds.provider?.id || null,
    byok: creds.usedByok,
    model: creds.model || null
  });

  if (!creds.provider) {
    return {
      candidates: [],
      audioContent: null,
      noCredits: false,
      promptFeedback: null,
      error:
        'No API key recognised. Add your Gemini, Claude, OpenAI or OpenRouter key in settings.'
    };
  }

  if (!creds.apiKey) {
    return {
      candidates: [],
      audioContent: null,
      noCredits: false,
      promptFeedback: null,
      error: `No ${creds.provider.displayName} API key found in the request.`
    };
  }

  if (creds.provider.id === 'custom' && !creds.baseUrl) {
    return {
      candidates: [],
      audioContent: null,
      noCredits: false,
      promptFeedback: null,
      error: 'A custom endpoint needs a base URL.'
    };
  }

  const model = resolveModel(creds.provider, creds.model);
  const args = { ...creds, model };

  try {
    let result;
    if (creds.provider.kind === 'anthropic') {
      result = await callAnthropic(args, body);
    } else if (creds.provider.kind === 'openai') {
      result = await callOpenAICompatible(args, body);
    } else {
      result = await callGemini(args, body, pathSuffix);
    }
    log('done in', Date.now() - started, 'ms');
    logBody('reply', result);
    return result;
  } catch (err) {
    const message = upstreamErrorMessage(err, 'Upstream request failed');
    const status = err?.response?.status;
    log('upstream error', status, message);
    // Rethrow so the route can pick a meaningful HTTP status, but keep the
    // Gemini-shaped body so the app always understands the failure.
    throw new UpstreamError(message, status);
  }
}

/** Kept for the existing route imports. */
export async function proxyGeminiRequest(req, _res, pathSuffix) {
  return handleGenerateContent(req, pathSuffix);
}

export { UpstreamError };
