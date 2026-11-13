import express from 'express';
import axios from 'axios';
import { proxyGeminiRequest, detectModelFromHeaders, buildGeminiUrl } from '../services/proxy.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Routes that the Panda app actually hits on api.heypanda.org
// We only need to proxy the Gemini generateContent path for the core chat.
// 모든 SSM マッスルと T5/C1837x が POST するパスをここで受ける。
// ---------------------------------------------------------------------------

// Main LLM response generation (C1837x -> f24204d)
router.post('/gemini/generateContent', async (req, res) => {
  try {
    const result = await proxyGeminiRequest(req, res, 'generateContent');
    return res.json(result);
  } catch (err) {
    console.error('[bridge] /v1/gemini/generateContent error:', err?.message || err);
    return res.status(502).json({
      error: err?.message || 'Bridge error',
      noCredits: false,
      candidates: [],
      promptFeedback: null
    });
  }
});

// Memories generation (f24205e) — also proxied for completeness
router.post('/gemini/generateMemories', async (req, res) => {
  try {
    const result = await proxyGeminiRequest(req, res, 'generateMemories');
    return res.json(result);
  } catch (err) {
    console.error('[bridge] /v1/gemini/generateMemories error:', err?.message || err);
    return res.status(502).json({
      error: err?.message || 'Bridge error',
      noCredits: false
    });
  }
});

// Agent call endpoint (C1808e -> f24204e / agentCall)
router.post('/gemini/agentCall', async (req, res) => {
  try {
    const result = await proxyGeminiRequest(req, res, 'agentCall');
    return res.json(result);
  } catch (err) {
    console.error('[bridge] /v1/gemini/agentCall error:', err?.message || err);
    return res.status(502).json({
      error: err?.message || 'Bridge error',
      noCredits: false
    });
  }
});

// LLM provider list (Y4.W) — return a static minimal set so the app doesn't
// try to fetch from the real heypanda.org.
router.get('/llm/providers', (req, res) => {
  res.json({
    providers: [
      {
        id: 'gemini',
        displayName: 'Gemini',
        tier: 2,
        keyHint: 'AIza...',
        setupUrl: 'https://aistudio.google.com/api-keys',
        sdkProvider: 'google',
        recommendedModelId: 'gemini-2.0-flash',
        baseUrl: 'https://generativelanguage.googleapis.com'
      },
      {
        id: 'openai',
        displayName: 'ChatGPT',
        tier: 2,
        keyHint: 'sk-...',
        setupUrl: 'https://platform.openai.com/api-keys',
        sdkProvider: 'openai',
        recommendedModelId: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1'
      },
      {
        id: 'openrouter',
        displayName: 'OpenRouter',
        tier: 1,
        keyHint: 'sk-or-...',
        setupUrl: 'https://openrouter.ai/keys',
        sdkProvider: 'openai-compatible',
        recommendedModelId: 'google/gemini-2.0-flash',
        baseUrl: 'https://openrouter.ai/api/v1'
      }
    ]
  });
});

// Key inspection (Y4.W / inspect-key) — accept any key that looks valid,
// return a minimal positive response so the app thinks the key is good.
router.post('/llm/inspect-key', (req, res) => {
  const body = req.body || {};
  const suppliedKey = (body.apiKey || '').trim();

  // Basic prefix check (same logic as the app's local detection)
  const looksValid =
    suppliedKey.startsWith('AIza') ||
    suppliedKey.startsWith('sk-or-') ||
    suppliedKey.startsWith('sk-proj-') ||
    suppliedKey.startsWith('sk-') &&
    !suppliedKey.startsWith('sk-ant-') ||
    suppliedKey.startsWith('sk-ant-');

  if (!looksValid) {
    return res.json({
      providerId: null,
      displayName: null,
      valid: false,
      models: [],
      recommendedModelId: null,
      setupUrl: 'https://aistudio.google.com/api-keys',
      privacyPolicyUrl: null,
      privacyPolicyTitle: null,
      privacyPolicyBullets: [],
      privacyPolicySummary: null,
      error: 'Unrecognized API key format',
      message: 'We could not recognize this key. Try a Gemini, OpenAI, OpenRouter, or Anthropic key.'
    });
  }

  // Decide provider label from prefix
  let providerId = 'gemini';
  let displayName = 'Gemini';
  let recommendedModelId = 'gemini-2.0-flash';
  let baseUrl = 'https://generativelanguage.googleapis.com';

  if (suppliedKey.startsWith('sk-or-')) {
    providerId = 'openrouter';
    displayName = 'OpenRouter';
    recommendedModelId = 'google/gemini-2.0-flash';
    baseUrl = 'https://openrouter.ai/api/v1';
  } else if (suppliedKey.startsWith('sk-proj-') || suppliedKey.startsWith('sk-')) {
    providerId = 'openai';
    displayName = 'ChatGPT';
    recommendedModelId = 'gpt-4o-mini';
    baseUrl = 'https://api.openai.com/v1';
  } else if (suppliedKey.startsWith('sk-ant-')) {
    providerId = 'anthropic';
    displayName = 'Claude';
    recommendedModelId = 'claude-3-5-haiku-20241015';
    baseUrl = 'https://api.anthropic.com/v1';
  }

  res.json({
    providerId,
    displayName,
    valid: true,
    models: [
      { id: recommendedModelId, name: recommendedModelId }
    ],
    recommendedModelId,
    setupUrl:
      providerId === 'gemini'
        ? 'https://aistudio.google.com/api-keys'
        : providerId === 'openai'
          ? 'https://platform.openai.com/api-keys'
          : providerId === 'openrouter'
            ? 'https://openrouter.ai/keys'
            : 'https://console.anthropic.com/settings/keys',
    privacyPolicyUrl: null,
    privacyPolicyTitle: null,
    privacyPolicyBullets: [],
    privacyPolicySummary: null,
    error: null,
    message: 'Key is valid'
  });
});

// JEV proxy endpoint (Y5.i) — minimal passthrough so the app's key-storage
// code doesn't blow up.
router.post('/jev/systemone', (req, res) => {
  res.json({ ok: true });
});

export { router as bridgeRouter };
