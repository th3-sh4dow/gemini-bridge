import express from 'express';
import multer from 'multer';
import { handleGenerateContent, UpstreamError } from '../services/proxy.js';
import { buildProviderPresets, inspectKey } from '../services/inspect.js';
import { voiceTurnHandler } from './voice.js';
import { activeKeyCache, saveActiveKey, withActiveKey } from '../services/activeKeyStore.js';
import { synthesizeSpeech } from '../services/tts.js';
import { transcribeAudio, boostPcmVolume, pcmToWav } from '../services/stt.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

export { activeKeyCache, withActiveKey };

// Middleware: capture any API key provided by the client
router.use((req, res, next) => {
  const geminiKey = req.headers['x-custom-gemini-key'];
  const providerKey = req.headers['x-provider-api-key'];
  let key = providerKey || geminiKey;
  if (!key && req.headers['authorization']) {
    const m = req.headers['authorization'].match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (candidate !== 'dummy_token' && candidate !== 'nexon_local_token' && candidate.length > 15) {
        key = candidate;
      }
    }
  }
  if (key && typeof key === 'string' && key.trim()) {
    saveActiveKey(
      key.trim(),
      req.headers['x-provider'] || activeKeyCache.provider,
      req.headers['x-provider-model'] || activeKeyCache.model
    );
  }
  next();
});

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
  withActiveKey(req);
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
  withActiveKey(req);
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
  const rawKey = body.apiKey || body.key || '';
  if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
    saveActiveKey(
      rawKey.trim(),
      body.providerId || body.provider || activeKeyCache.provider,
      activeKeyCache.model
    );
  }
  try {
    const result = await inspectKey(
      rawKey,
      body.providerId || body.provider || req.headers['x-provider']
    );
    if (result && result.valid && result.recommendedModelId) {
      saveActiveKey(activeKeyCache.apiKey, activeKeyCache.provider, result.recommendedModelId);
    }
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
// Freemium / Subscription / Account Management
// Always return subscribed pro+byok status so all features unlock
// ---------------------------------------------------------------------------

router.get('/user', (req, res) => {
  res.json({
    plan: 'pro+byok',
    isDeleted: false,
    totalTasksFree: 0,
    enforcedPlan: 'byok'
  });
});

router.post('/user/preferences', (req, res) => {
  res.json({ success: true, ok: true });
});

router.post('/user/permissions', (req, res) => {
  res.json({ success: true, ok: true });
});

router.post('/user/downgrade', (req, res) => {
  res.json({ success: true, ok: true });
});

router.post('/user/upgrade', (req, res) => {
  res.json({ success: true, ok: true });
});

router.post('/user/delete', (req, res) => {
  res.json({ success: true, ok: true });
});

router.get('/user/handle', (req, res) => {
  res.json({ name: 'Panda User', handle: '@user' });
});

router.post('/user/handle', (req, res) => {
  res.json({ success: true, ok: true });
});

router.post('/user/pandaBriefingStatus', (req, res) => {
  res.json({ success: true, ok: true });
});

router.post('/user/pandaBriefingFeedback', (req, res) => {
  res.json({ success: true, ok: true });
});

router.post('/user/pandaBriefingViewDuration', (req, res) => {
  res.json({ success: true, ok: true });
});

router.get('/user/triggers', (req, res) => {
  res.json({ triggers: [] });
});

router.post('/user/triggers', (req, res) => {
  res.json({ success: true, ok: true });
});

// App update version check
router.get('/app/version', (req, res) => {
  res.json({
    latestVersionCode: 135,
    minVersionCode: 100,
    downloadUrl: '',
    releaseNotes: 'Up to date'
  });
});

// Agent conversation tracking
router.post('/agent/conversation/start', (req, res) => {
  res.json({ ok: true, conversationId: req.body?.conversationId || 'conv-1' });
});

router.post('/agent/message', (req, res) => {
  res.json({ ok: true });
});

router.post('/agent/conversation/end', (req, res) => {
  res.json({ ok: true });
});

// Memories API
const inMemoryMemories = [
  {
    id: 'mem_1',
    text: 'Prefers concise and direct responses',
    category: 'preferences',
    source: 'voice',
    createdAt: new Date(Date.now() - 3600000).toISOString()
  },
  {
    id: 'mem_2',
    text: 'Enjoys lo-fi music playlists when working',
    category: 'interests',
    source: 'device',
    createdAt: new Date(Date.now() - 7200000).toISOString()
  }
];

router.get('/memories', (req, res) => {
  res.json({ success: true, memories: inMemoryMemories });
});

router.post('/memories', (req, res) => {
  const item = {
    id: 'mem_' + Date.now(),
    text: req.body?.text || '',
    category: req.body?.category || 'general',
    source: req.body?.source || 'user',
    createdAt: new Date().toISOString()
  };
  inMemoryMemories.unshift(item);
  res.json({ success: true, memory: item });
});

router.put('/memories/:id', (req, res) => {
  res.json({ success: true });
});

router.delete('/memories/:id', (req, res) => {
  const idx = inMemoryMemories.findIndex(m => m.id === req.params.id);
  if (idx !== -1) inMemoryMemories.splice(idx, 1);
  res.json({ success: true });
});

// Community / Default Triggers
router.get('/default-triggers', (req, res) => {
  res.json([]);
});

router.get('/community/triggers', (req, res) => {
  res.json([]);
});

router.get('/community/triggers/editor-picks', (req, res) => {
  res.json([]);
});

router.post('/community/triggers', (req, res) => {
  res.json({ success: true });
});

router.post('/community/triggers/download', (req, res) => {
  res.json({ success: true });
});

router.post('/community/triggers/like', (req, res) => {
  res.json({ success: true });
});

router.get('/leaderboard', (req, res) => {
  res.json([]);
});

// Portal (Panda Feed)
router.get('/portal/feed', (req, res) => {
  res.json({ messages: [], hasMore: false });
});

router.post('/portal/post', (req, res) => {
  res.json({
    id: 'p_' + Date.now(),
    uid: 'u1',
    author: 'User',
    text: req.body?.text || '',
    parentId: req.body?.parentId || null,
    replyCount: 0,
    upvotes: 0,
    downvotes: 0,
    isPro: true,
    createdAt: new Date().toISOString(),
    deleted: false,
    currentUserVote: null
  });
});

router.post('/portal/triggerPanda', (req, res) => {
  res.json({
    id: 'p_' + Date.now(),
    uid: 'panda',
    author: 'Panda',
    text: 'Task initiated.',
    parentId: null,
    replyCount: 0,
    upvotes: 0,
    downvotes: 0,
    isPro: true,
    createdAt: new Date().toISOString(),
    deleted: false,
    currentUserVote: null
  });
});

router.post('/portal/markRead', (req, res) => {
  res.json({ success: true });
});

router.post('/portal/vote', (req, res) => {
  res.json({ success: true });
});

router.delete('/portal/message/:id', (req, res) => {
  res.json({ success: true });
});

// Composio and toolkits
router.post('/composio/analyze-task', (req, res) => {
  res.json({ route: 'device', confidence: 1.0 });
});

router.post('/composio/chat', (req, res) => {
  const accept = req.headers['accept'] || '';
  if (accept.includes('text/event-stream') || req.headers['content-type']?.includes('json')) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`event: message\ndata: ${JSON.stringify({ text: "I'm ready to help!" })}\n\n`);
    res.write(`event: done\ndata: {}\n\n`);
    return res.end();
  }
  return res.json({ reply: "I'm ready to help!" });
});

const DEFAULT_TOOLKITS = [
  {
    slug: 'whatsapp',
    name: 'WhatsApp',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/whatsapp.png',
    description: 'Send messages and manage chats on WhatsApp',
    categories: ['Communication', 'Messaging']
  },
  {
    slug: 'linkedin',
    name: 'LinkedIn',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/linkedin.png',
    description: 'Manage LinkedIn posts and network',
    categories: ['Social', 'Productivity']
  },
  {
    slug: 'googlecontacts',
    name: 'Google Contacts',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/google-contacts.png',
    description: 'Access and manage your contacts',
    categories: ['Productivity']
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/gmail.png',
    description: 'Read and send emails via Gmail',
    categories: ['Email', 'Productivity']
  },
  {
    slug: 'slack',
    name: 'Slack',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/slack.png',
    description: 'Send messages and manage channels in Slack',
    categories: ['Communication', 'Teamwork']
  },
  {
    slug: 'youtube',
    name: 'YouTube',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/youtube.png',
    description: 'Search and play videos on YouTube',
    categories: ['Media', 'Entertainment']
  },
  {
    slug: 'spotify',
    name: 'Spotify',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/spotify.png',
    description: 'Stream and control music on Spotify',
    categories: ['Media', 'Music']
  }
];

const DEFAULT_ACCOUNTS = [
  {
    id: 'acc_whatsapp',
    toolkitSlug: 'whatsapp',
    toolkitName: 'WhatsApp',
    status: 'ACTIVE',
    createdAt: '2024-01-01T00:00:00Z',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/whatsapp.png'
  },
  {
    id: 'acc_linkedin',
    toolkitSlug: 'linkedin',
    toolkitName: 'LinkedIn',
    status: 'ACTIVE',
    createdAt: '2024-01-01T00:00:00Z',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/linkedin.png'
  },
  {
    id: 'acc_googlecontacts',
    toolkitSlug: 'googlecontacts',
    toolkitName: 'Google Contacts',
    status: 'ACTIVE',
    createdAt: '2024-01-01T00:00:00Z',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/google-contacts.png'
  },
  {
    id: 'acc_gmail',
    toolkitSlug: 'gmail',
    toolkitName: 'Gmail',
    status: 'ACTIVE',
    createdAt: '2024-01-01T00:00:00Z',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/gmail.png'
  },
  {
    id: 'acc_slack',
    toolkitSlug: 'slack',
    toolkitName: 'Slack',
    status: 'ACTIVE',
    createdAt: '2024-01-01T00:00:00Z',
    logoUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/slack.png'
  }
];

router.get('/toolkits', (req, res) => {
  res.json({ toolkits: DEFAULT_TOOLKITS });
});

router.get('/toolkits/:id', (req, res) => {
  const item = DEFAULT_TOOLKITS.find(t => t.slug === req.params.id) || DEFAULT_TOOLKITS[0];
  res.json(item);
});

router.get('/connected-accounts', (req, res) => {
  res.json({ accounts: DEFAULT_ACCOUNTS });
});

router.get('/connected-accounts/:id', (req, res) => {
  const item = DEFAULT_ACCOUNTS.find(a => a.id === req.params.id || a.toolkitSlug === req.params.id) || DEFAULT_ACCOUNTS[0];
  res.json(item);
});

// Past actions & Tasks
const inMemoryPastActions = [
  {
    task: "Open YouTube and start a lo-fi mix",
    status: "completed",
    success: true,
    errorMessage: null,
    startedAt: {
      _seconds: Math.floor((Date.now() - 300000) / 1000),
      _nanoseconds: 0
    },
    completedAt: {
      _seconds: Math.floor((Date.now() - 285000) / 1000),
      _nanoseconds: 0
    }
  },
  {
    task: "Check morning weather and briefing",
    status: "completed",
    success: true,
    errorMessage: null,
    startedAt: {
      _seconds: Math.floor((Date.now() - 3600000) / 1000),
      _nanoseconds: 0
    },
    completedAt: {
      _seconds: Math.floor((Date.now() - 3590000) / 1000),
      _nanoseconds: 0
    }
  }
];

router.get('/pastActions', (req, res) => {
  // Return top-level JSON array required by n5/w.smali PastActionsApi
  res.json(inMemoryPastActions);
});

router.post('/pastActions', (req, res) => {
  const body = req.body || {};
  const action = {
    task: body.task || body.title || 'Completed task',
    status: body.status || 'completed',
    success: body.success !== false,
    errorMessage: body.errorMessage || null,
    startedAt: {
      _seconds: body.startedAt?._seconds || Math.floor((Date.now() - 15000) / 1000),
      _nanoseconds: 0
    },
    completedAt: {
      _seconds: body.completedAt?._seconds || Math.floor(Date.now() / 1000),
      _nanoseconds: 0
    }
  };
  inMemoryPastActions.unshift(action);
  res.json({ success: true, action });
});

router.get('/tasks', (req, res) => {
  res.json({ tasks: inMemoryPastActions });
});

router.post('/tasks', (req, res) => {
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Browser agent, health & voice stubs
// ---------------------------------------------------------------------------

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.post('/chat/sync', (req, res) => {
  res.json({ ok: true, noCredits: false });
});

router.get('/tts/voices', (req, res) => {
  res.json({ voices: [{ name: 'alloy', status: 'ok' }] });
});

// Text-To-Speech endpoint: returns raw 24kHz 16-bit Mono PCM bytes
// matching Android AudioTrack in com.blurr.voice.utilities.TTSManager
router.post('/tts/synthesize', async (req, res) => {
  const body = req.body || {};
  const text = body.text || '';
  const voiceId = body.voiceId || body.voice || '';
  const languageCode = body.options?.language_code || body.options?.languageCode || body.languageCode || 'en-US';

  try {
    const pcmBuffer = await synthesizeSpeech(text, voiceId, languageCode);
    res.set('Content-Type', 'audio/l16; rate=24000; channels=1');
    res.set('Content-Length', pcmBuffer.length);
    return res.status(200).send(pcmBuffer);
  } catch (err) {
    console.error('[bridge] /v1/tts/synthesize error:', err.message);
    res.set('Content-Type', 'audio/l16; rate=24000; channels=1');
    return res.status(200).send(Buffer.alloc(0));
  }
});

// In-memory buffer for STT streaming sessions from SarvamSttApi
const sttSessions = new Map();

function cleanupSttSessions() {
  const now = Date.now();
  for (const [id, session] of sttSessions.entries()) {
    if (now - session.created > 120000) {
      sttSessions.delete(id);
    }
  }
}

// Speech-To-Text transcribe: accepts multipart/form-data audio file or JSON body
// Returns { transcript: string, text: string } expected by SarvamSttApi.java & SpeechCoordinator
router.post('/stt/transcribe', upload.single('file'), async (req, res) => {
  withActiveKey(req);
  let text = req.body?.text || req.body?.transcript || '';
  if (!text && req.file && req.file.buffer) {
    try {
      console.log(`[bridge] /v1/stt/transcribe receiving audio: size=${req.file.buffer.length}b, mime=${req.file.mimetype}`);
      text = await transcribeAudio(req.file.buffer, req.file.mimetype, req.headers);
      console.log(`[bridge] /v1/stt/transcribe transcription result: "${text}"`);
    } catch (err) {
      console.error('[bridge] /v1/stt/transcribe error:', err.message);
    }
  }
  return res.json({ transcript: text, text });
});

// STT session append: receives raw PCM chunk
router.post('/stt/session/append', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const sessionId = req.headers['x-stt-session-id'] || req.query.sessionId || 'default';
  const chunk = req.body;
  if (!sttSessions.has(sessionId)) {
    sttSessions.set(sessionId, {
      created: Date.now(),
      chunks: []
    });
  }
  const session = sttSessions.get(sessionId);
  if (Buffer.isBuffer(chunk) && chunk.length > 0) {
    session.chunks.push(chunk);
    console.log(`[bridge] /v1/stt/session/append session=${sessionId} chunk=${chunk.length}b, count=${session.chunks.length}`);
  }
  return res.json({ ok: true, transcript: '' });
});

// STT session finish: assembles PCM, converts to WAV, boosts audio gain, transcribes
router.post('/stt/session/finish', async (req, res) => {
  withActiveKey(req);
  const sessionId = req.headers['x-stt-session-id'] || req.query.sessionId || 'default';
  console.log(`[bridge] /v1/stt/session/finish session=${sessionId}`);

  const session = sttSessions.get(sessionId);
  sttSessions.delete(sessionId);
  cleanupSttSessions();

  if (!session || session.chunks.length === 0) {
    console.log(`[bridge] /v1/stt/session/finish session=${sessionId} empty or not found`);
    return res.json({ ok: true, transcript: '', text: '' });
  }

  const pcmBuffer = Buffer.concat(session.chunks);
  console.log(`[bridge] /v1/stt/session/finish assembled PCM size=${pcmBuffer.length}b (~${(pcmBuffer.length / 32000).toFixed(2)}s)`);

  if (pcmBuffer.length < 3200) {
    console.log('[bridge] /v1/stt/session/finish audio too short (<100ms)');
    return res.json({ ok: true, transcript: '', text: '' });
  }

  try {
    const boostedPcm = boostPcmVolume(pcmBuffer);
    const wavBuffer = pcmToWav(boostedPcm, 16000, 1, 16);
    const text = await transcribeAudio(wavBuffer, 'audio/wav', req.headers);
    console.log(`[bridge] /v1/stt/session/finish transcription: "${text}"`);
    return res.json({ ok: true, transcript: text || '', text: text || '' });
  } catch (err) {
    console.error('[bridge] /v1/stt/session/finish error:', err.message);
    return res.json({ ok: true, transcript: '', text: '' });
  }
});

router.get('/user/freemium-status', (req, res) => {
  res.json({
    plan: 'pro+byok',
    totalTasksFree: 999999,
    hasActiveSubscription: true,
    enforcedPlan: 'byok'
  });
});

router.get('/app-defaults/tryTasks', (req, res) => {
  res.json({});
});

router.post('/auth/migrate', (req, res) => res.json({ ok: true }));
router.post('/auth/send-otp', (req, res) => res.json({ ok: true, success: true }));
router.post('/auth/verify-otp', (req, res) => res.json({ ok: true, success: true }));

router.post('/tasks/start', (req, res) => res.json({ ok: true }));
router.post('/tasks/complete', (req, res) => res.json({ ok: true }));
router.post('/tasks/feedback', (req, res) => res.json({ ok: true }));

router.post('/memory/judge', (req, res) => res.json({ shouldStore: true, confidence: 1.0 }));

router.post('/plugins/install', (req, res) => res.json({ ok: true }));
router.get('/plugins/listings', (req, res) => res.json([]));
router.get('/plugins/listings/:id', (req, res) => res.json({}));
router.post('/plugins/rate', (req, res) => res.json({ ok: true }));
router.get('/plugins/rating', (req, res) => res.json({ rating: 5, reviews: [] }));
router.get('/plugins/stats', (req, res) => res.json({ downloads: 100 }));

router.get('/remote/clients', (req, res) => res.json({ clients: [] }));
router.get('/remote/clients/:id', (req, res) => res.json({}));
router.get('/remote/tasks/:id', (req, res) => res.json({}));

router.post('/support/intake', (req, res) => res.json({ ok: true }));
router.post('/support/tickets', (req, res) => res.json({ ok: true, ticketId: 'ticket-1' }));

router.post('/user/device-a11y', (req, res) => res.json({ ok: true }));
router.post('/user/login-a11y', (req, res) => res.json({ ok: true }));
router.post('/user/trial-device', (req, res) => res.json({ ok: true, trialEligible: false }));
router.post('/user/fcm-token', (req, res) => res.json({ ok: true }));
router.post('/user/fcm-test', (req, res) => res.json({ ok: true }));
router.post('/cron/fcm-send', (req, res) => res.json({ ok: true }));
router.get('/js-views/preset/:id', (req, res) => res.json({ ok: true }));

router.post('/senses/stats', (req, res) => {
  res.json({ ok: true });
});

router.post('/browserAgent/generateContent', (req, res) => {
  withActiveKey(req);
  return llmRoute(req, res, 'browserAgent/generateContent', 'generateContent');
});

router.post('/browserAgent/chatTurn', (req, res) => {
  withActiveKey(req);
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
