import axios from 'axios';

/**
 * Core proxy logic.
 *
 * Panda app sends requests to api.heypanda.org with headers like:
 *   - x-custom-gemini-key  (Gemini BYOK key)
 *   - x-provider-api-key   (generic provider key)
 *   - x-provider           (e.g. "gemini", "openai", "openrouter")
 *   - x-provider-model     (model id)
 *   - x-provider-base-url  (optional custom base URL)
 *
 * We extract the user's key from those headers, call the real Gemini/OpenRouter
 * API directly, then return the same JSON shape but with noCredits: false
 * so the app never sees the paywall.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const LOG = (process.env.BRIDGE_LOG || '_minimal_').toLowerCase();

function log(...args) {
  if (LOG === '_verbose_') console.log('[bridge]', ...args);
}

function logBody(label, obj) {
  if (LOG === '_verbose_') console.log(`[bridge] ${label}:`, JSON.stringify(obj).slice(0, 1200));
}

// ---- Extract the API key the app is trying to use ----

export function extractProviderKey(headers = {}) {
  // Gemini-specific BYOK header (C1837x line 395, 460)
  const geminiKey = (headers['x-custom-gemini-key'] || '').trim();
  if (geminiKey) return { key: geminiKey, provider: 'gemini' };

  // Generic provider headers (C1808e line 179-185)
  const provider = (headers['x-provider'] || '').trim().toLowerCase();
  const providerKey = (headers['x-provider-api-key'] || '').trim();
  if (providerKey) return { key: providerKey, provider };

  return { key: null, provider: null };
}

// ---- Decide what upstream URL to hit ----

export function buildGeminiUrl(provider, model, pathSuffix) {
  // Gemini:  https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
  // OpenRouter/OpenAI-compatible: rely on x-provider-base-url if present,
  // otherwise default to OpenRouter.
  if (provider === 'gemini' || !provider) {
    const base = process.env.GEMINI_BASE_URL || GEMINI_BASE;
    const m = (model || 'gemini-2.0-flash').replace(/^gemini-/, 'gemini-');
    if (pathSuffix === 'generateMemories') {
      return `${base}/v1beta/models/${m}:generateContent`;
    }
    return `${base}/v1beta/models/${m}:${pathSuffix}`;
  }

  if (provider === 'openai') {
    const base = 'https://api.openai.com/v1';
    if (pathSuffix === 'generateMemories') {
      return `${base}/chat/completions`;
    }
    return `${base}/chat/completions`;
  }

  if (provider === 'openrouter') {
    const base = 'https://openrouter.ai/api/v1';
    if (pathSuffix === 'generateMemories') {
      return `${base}/chat/completions`;
    }
    return `${base}/chat/completions`;
  }

  // fallback: generic OpenAI-compatible path
  return 'https://openrouter.ai/api/v1/chat/completions';
}

// ---- Detect model from headers, with sane defaults ----

export function detectModelFromHeaders(headers = {}) {
  const fromHeader = (headers['x-provider-model'] || '').trim();
  if (fromHeader) return fromHeader;

  // If the request body already includes a model, prefer it
  return 'gemini-2.0-flash';
}

// ---- Convert Panda's Gemini generateContent body to upstream shape ----

function toUpstreamBody(provider, body) {
  if (provider === 'gemini' || !provider) {
    // Gemini expects { contents: [...] }
    const contents = body.contents || body.candidates || body;
    return { contents };
  }

  // OpenAI/OpenRouter compatible: convert contents -> messages
  const contents = body.contents || body.candidates || body;
  const messages = Array.isArray(contents)
    ? contents.map((c) => {
        if (typeof c === 'string') return { role: 'user', content: c };
        const role = c.role || c.Type || 'user';
        const text = c.text || c.content?.parts?.[0]?.text || c.Reply || '';
        return { role, content: text };
      })
    : [];

  const modelHint = body.model || '';
  return {
    model: modelHint || 'google/gemini-2.0-flash',
    messages,
    max_tokens: body.max_tokens || body.maxOutputTokens || 2048,
    temperature: body.temperature ?? 0.7
  };
}

// ---- Convert upstream response back to Panda's expected shape ----

function toPandaShape(upstreamRes, provider, pathSuffix) {
  const data = upstreamRes.data;

  // Gemini native response
  if (data.candidates || data.usageMetadata) {
    const candidates = (data.candidates || []).map((c) => {
      const parts = (c.content && c.content.parts) || [];
      const text = parts.map((p) => p.text || p).join('');
      return {
        content: {
          parts: parts.map((p) => ({ text: p.text || p })),
          role: c.content?.role || 'model'
        },
        finishReason: c.finishReason,
        averageLogprobs: c.averageLogprobs
      };
    });

    return {
      candidates,
      audioContent: null,
      noCredits: false,            // <-- always false: no paywall
      promptFeedback: data.promptFeedback || null,
      usageMetadata: data.usageMetadata || null
    };
  }

  // OpenAI / OpenRouter style response
  if (data.choices) {
    const candidates = data.choices.map((ch) => ({
      content: {
        parts: [{ text: ch.message?.content || '' }],
        role: ch.message?.role || 'model'
      },
      finishReason: ch.finish_reason || 'stop',
      averageLogprobs: null
    }));

    return {
      candidates,
      audioContent: null,
      noCredits: false,
      promptFeedback: null,
      usageMetadata: {
        promptTokenCount: data.usage?.prompt_tokens || 0,
        candidatesTokenCount: data.usage?.completion_tokens || 0,
        totalTokenCount: data.usage?.total_tokens || 0
      }
    };
  }

  // Fallback: just echo with noCredits flag forced off
  return {
    candidates: [],
    audioContent: null,
    noCredits: false,
    promptFeedback: null,
    ...data
  };
}

// ---- Main proxy handler ----

export async function proxyGeminiRequest(req, res, pathSuffix = 'generateContent') {
  const startTime = Date.now();

  const providerKey = extractProviderKey(req.headers);
  log('request', req.path, 'providerKey?', !!providerKey.key, 'provider?', providerKey.provider);

  const model = detectModelFromHeaders(req.headers);
  const upstreamUrl = buildGeminiUrl(providerKey.provider, model, pathSuffix);
  log('upstream url:', upstreamUrl);

  // Forward the request body as-is for Gemini; convert for OpenAI-style
  const pandaBody = req.body || {};
  const upstreamBody = toUpstreamBody(providerKey.provider, pandaBody);
  logBody('outbound body', upstreamBody);

  const headersOut = {};

  // Auth header depends on provider
  if (providerKey.provider === 'gemini') {
    // Gemini REST API: key in query string
    const urlWithKey = `${upstreamUrl}?key=${encodeURIComponent(providerKey.key)}`;
    headersOut['Content-Type'] = 'application/json';
    log('using query-key auth for Gemini');
    try {
      const up = await axios.post(urlWithKey, upstreamBody, {
        headers: headersOut,
        timeout: 30000
      });
      log('upstream status:', up.status, 'ms:', Date.now() - startTime);
      logBody('inbound body', up.data);
      return toPandaShape(up, providerKey.provider, pathSuffix);
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.message || 'Gemini upstream error';
      log('upstream error:', msg);
      // Re-throw so the route handler returns 502 with noCredits:false
      const errObj = new Error(msg);
      errObj.upstreamStatus = err?.response?.status;
      throw errObj;
    }
  }

  if (providerKey.provider === 'openai' || providerKey.provider === 'openrouter') {
    headersOut['Authorization'] = `Bearer ${providerKey.key}`;
    headersOut['Content-Type'] = 'application/json';
    log('using Bearer auth for', providerKey.provider);
    try {
      const up = await axios.post(upstreamUrl, upstreamBody, {
        headers: headersOut,
        timeout: 30000
      });
      log('upstream status:', up.status, 'ms:', Date.now() - startTime);
      logBody('inbound body', up.data);
      return toPandaShape(up, providerKey.provider, pathSuffix);
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.response?.data || err?.message || 'Upstream error';
      log('upstream error:', msg);
      const errObj = new Error(msg);
      errObj.upstreamStatus = err?.response?.status;
      throw errObj;
    }
  }

  // No key at all — return a clean noCredits:false empty response so the
  // app doesn't crash or show a paywall.
  log('no provider key found; returning empty noCredits:false');
  return {
    candidates: [],
    audioContent: null,
    noCredits: false,
    promptFeedback: null,
    error: 'No API key supplied'
  };
}
