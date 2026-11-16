import express from 'express';
import { handleGenerateContent, UpstreamError } from '../services/proxy.js';
import { buildProviderPresets, inspectKey } from '../services/inspect.js';
import { voiceTurnHandler } from './voice.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// LLM paths the app calls. Every one of them accepts the user's own key
// (Gemini, Claude, OpenAI, OpenRouter or a custom OpenAI-compatible endpoint)
// and returns a Gemini-shaped reply with noCredits:false, so the app never
// shows a paywall and never needs a subscription to work.
// ---------------------------------------------------------------------------

/** Pick an HTTP status for a failed upstream call. */
function bridgeStatus(err) {
  const upstream = err?.upstreamStatus;
  if (upstream === 401 || upstream === 403) return 401;
  if (upstream === 429) return 429;
  if (upstream === 400) return 400;
  return 502;
}

/** Empty Gemini-shaped reply, always with noCredits:false. */
function emptyReply(error) {
  return {
    candidates: [],
    audioContent: null,
    noCredits: false,
    promptFeedback: null,
    ...(error ? { error } : {})
  };
}

async function llmRoute(req, res, label, pathSuffix) {
  try {
    const result = await handleGenerateContent(req, pathSuffix);
    return res.json(result);
  } catch (err) {
    const message = err?.message || 'Bridge error';
    console.error(`[bridge] /v1/${label} error:`, message);
    return res.status(bridgeStatus(err)).json(emptyReply(message));
  }
}

// Main LLM response generation (Z5/x -> f24204d)
router.post('/gemini/generateContent', (req, res) =>
  llmRoute(req, res, 'gemini/generateContent', 'generateContent')
);

// Memories extraction (f24205e). The app only looks at whether this succeeded,
// and it posts an empty body when there is nothing to extract.
router.post('/gemini/generateMemories', (req, res) => {
  const body = req.body || {};
  const hasContent =
    (Array.isArray(body.contents) && body.contents.length > 0) ||
    typeof body.text === 'string';
  if (!hasContent) {
    return res.json({ ok: true, noCredits: false, saved: false });
  }
  return llmRoute(req, res, 'gemini/generateMemories', 'generateMemories');
});

// Agent tool-call turns (Z5/C1808e -> agentCall)
export function toAgentOutput(result) {
  if (result && Array.isArray(result.action)) {
    return result;
  }

  const parts = result?.candidates?.[0]?.content?.parts || [];
  let thinking = null;
  let evaluationPreviousGoal = null;
  let memory = null;
  let nextGoal = null;
  const action = [];

  for (const part of parts) {
    if (part.functionCall) {
      const name = part.functionCall.name;
      const args = part.functionCall.args || {};

      if (name === 'update_state') {
        thinking = args.thinking || thinking;
        evaluationPreviousGoal = args.evaluation_previous_goal || args.evaluationPreviousGoal || evaluationPreviousGoal;
        memory = args.memory || memory;
        nextGoal = args.next_goal || args.nextGoal || nextGoal;
        action.push({ update_state: args });
      } else {
        action.push({ [name]: args });
      }
    } else if (part.text) {
      if (!thinking) thinking = part.text;
    }
  }

  if (action.length === 0) {
    action.push({
      done: {
        success: true,
        text: thinking || 'Done'
      }
    });
  }

  return {
    thinking: thinking || null,
    evaluationPreviousGoal: evaluationPreviousGoal || null,
    memory: memory || null,
    nextGoal: nextGoal || null,
    audioContent: null,
    action
  };
}

router.post('/gemini/agentCall', async (req, res) => {
  try {
    const result = await handleGenerateContent(req, 'generateContent');
    return res.json(toAgentOutput(result));
  } catch (err) {
    const message = err?.message || 'Bridge error';
    console.error('[bridge] /v1/gemini/agentCall error:', message);
    return res.status(bridgeStatus(err)).json({
      thinking: null,
      evaluationPreviousGoal: null,
      memory: null,
      nextGoal: null,
      audioContent: null,
      action: [
        { done: { success: false, text: message } }
      ]
    });
  }
});

// Voice conversation turn, streamed as SSE (Z5/M0 -> Z5/N0).
router.post('/voice/turn', voiceTurnHandler);

// ---------------------------------------------------------------------------
// Provider / key management (Y4/W, Y5/i)
// ---------------------------------------------------------------------------

// Provider dropdown. Matches com.blurr.voice.byok.ProviderPreset.
router.get('/llm/providers', (req, res) => {
  res.json({ providers: buildProviderPresets() });
});

// Key validation + model discovery. Matches InspectKeyResponse.
router.post('/llm/inspect-key', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await inspectKey(
      body.apiKey || body.key || '',
      body.providerId || body.provider || req.headers['x-provider']
    );
    return res.json(result);
  } catch (err) {
    console.error('[bridge] /v1/llm/inspect-key error:', err?.message || err);
    return res.status(500).json({
      providerId: null,
      displayName: null,
      valid: false,
      models: [],
      recommendedModelId: null,
      setupUrl: null,
      privacyPolicyUrl: null,
      privacyPolicyTitle: null,
      privacyPolicyBullets: [],
      privacyPolicySummary: null,
      error: 'inspect_failed',
      message: 'Could not validate the key right now. Try again in a moment.'
    });
  }
});

// JEV proxy endpoint (Y5/i)
router.post('/jev/systemone', (req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Safe stubs for the remaining api.heypanda.org paths so non-LLM features
// degrade quietly instead of crashing.
// ---------------------------------------------------------------------------

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.post('/chat/sync', (req, res) => {
  res.json({ ok: true, noCredits: false });
});

router.get('/tts/voices', (req, res) => {
  res.json({ voices: [{ name: 'alloy', status: 'ok' }] });
});

router.post('/stt/transcribe', (req, res) => {
  res.json({ text: '' });
});

router.post('/senses/stats', (req, res) => {
  res.json({ ok: true });
});

router.post('/browserAgent/generateContent', (req, res) => {
  if (!req.headers['x-custom-gemini-key'] && !req.headers['x-provider-api-key']) {
    req.headers['x-custom-gemini-key'] = process.env.GEMINI_API_KEY || 'AIzaSyCDKUoyXSSfgiRfj70bAtwCZZyIVc0q3a4';
  }
  return llmRoute(req, res, 'browserAgent/generateContent', 'generateContent');
});

router.post('/browserAgent/chatTurn', (req, res) => {
  if (!req.headers['x-custom-gemini-key'] && !req.headers['x-provider-api-key']) {
    req.headers['x-custom-gemini-key'] = process.env.GEMINI_API_KEY || 'AIzaSyCDKUoyXSSfgiRfj70bAtwCZZyIVc0q3a4';
  }
  return llmRoute(req, res, 'browserAgent/chatTurn', 'generateContent');
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

// Catch-all so an unknown path never makes the app panic.
router.all('*', (req, res) => {
  res.status(200).json({ ok: true, noCredits: false });
});

export { router as bridgeRouter };
