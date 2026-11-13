import express from 'express';
import { proxyGeminiRequest } from '../services/proxy.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Gemini LLM paths the app hits (Z5/C1837x, Z5/C1808e, p084g6/f)
// These are the ones that matter for chat + paywall. Every Gemini response
// is returned with noCredits:false so the app never shows the paywall.
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

// Memories generation (f24205e)
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

// Agent call endpoint (C1808e -> agentCall)
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

// ---------------------------------------------------------------------------
// Provider / key management paths the app hits (Y4.W, Y5.i)
// ---------------------------------------------------------------------------

// LLM provider list (Y4.W)
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

// Key inspection (Y4.W)
router.post('/llm/inspect-key', (req, res) => {
  const body = req.body || {};
  const suppliedKey = (body.apiKey || '').trim();

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

  let providerId = 'gemini';
  let displayName = 'Gemini';
  let recommendedModelId = 'gemini-2.0-flash';

  if (suppliedKey.startsWith('sk-or-')) {
    providerId = 'openrouter';
    displayName = 'OpenRouter';
    recommendedModelId = 'google/gemini-2.0-flash';
  } else if (suppliedKey.startsWith('sk-proj-') || suppliedKey.startsWith('sk-')) {
    providerId = 'openai';
    displayName = 'ChatGPT';
    recommendedModelId = 'gpt-4o-mini';
  } else if (suppliedKey.startsWith('sk-ant-')) {
    providerId = 'anthropic';
    displayName = 'Claude';
    recommendedModelId = 'claude-3-5-haiku-20241015';
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

// JEV proxy endpoint (Y5.i)
router.post('/jev/systemone', (req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Safe stubs for other api.heypanda.org paths the app hits.
// If you point the whole hostname at this bridge, these keep the app from
// crashing on non-LLM features while Gemini LLM traffic goes through the
// Gemini proxy above.
// ---------------------------------------------------------------------------

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.post('/chat/sync', (req, res) => {
  // Z4/H path; return a minimal chat-sync style payload.
  res.json({ ok: true, noCredits: false });
});

router.get('/tts/voices', (req, res) => {
  // S4/Y path; return a minimal voices list.
  res.json({ voices: [{ name: 'alloy', status: 'ok' }] });
});

router.post('/stt/transcribe', (req, res) => {
  // P5/C0932n path; return a minimal transcript.
  res.json({ text: '' });
});

router.post('/senses/stats', (req, res) => {
  // A5/l path; return a minimal stats ack.
  res.json({ ok: true });
});

router.post('/browserAgent/generateContent', (req, res) => {
  // X4/S path; return a minimal browser-agent style payload.
  res.json({ candidates: [], noCredits: false, promptFeedback: null });
});

router.post('/browserAgent/chatTurn', (req, res) => {
  res.json({ candidates: [], noCredits: false, promptFeedback: null });
});

router.post('/sessions/:id/log', (req, res) => {
  res.json({ ok: true });
});

router.get('/goals', (req, res) => {
  res.json({ goals: [] });
});

router.get('/life', (req, res) => {
  res.json({ life: [] });
});

router.get('/observations', (req, res) => {
  res.json({ observations: [] });
});

router.post('/search/agent', (req, res) => {
  res.json({ results: [], noCredits: false });
});

router.post('/training/v3/:path(*)', (req, res) => {
  res.json({ ok: true });
});

// Catch-all for anything else on /v1 so the app doesn't get a 404 panic.
router.all('/v1/*', (req, res) => {
  res.status(200).json({ ok: true, noCredits: false });
});

router.all('*', (req, res) => {
  res.status(200).json({ ok: true, noCredits: false });
});

export { router as bridgeRouter };
