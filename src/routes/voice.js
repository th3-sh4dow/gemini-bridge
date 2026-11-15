import { handleGenerateContent } from '../services/proxy.js';

/**
 * Voice turn endpoint: POST /v1/voice/turn
 *
 * The app opens this after each spoken utterance (Z5/M0) and streams the reply
 * as Server-Sent Events. The frame contract is fixed by the app's own SSE
 * parser (Z5/N0):
 *
 *   event: speech    {"text": "..."}          what to show / speak
 *   event: decision  {"type":"Reply",
 *                     "reply":"...",
 *                     "instruction":"",
 *                     "shouldEnd":"Continue",
 *                     "originalReply":"..."}   what to do next
 *   event: meta      {"level":"..."}          optional status
 *   event: error     {"error":"...","status":N}
 *   event: done      {}
 *
 * The request body carries:
 *   message      the user's utterance
 *   options      {languageCode, pace}
 *   tts          {provider, voiceId, ...}
 *   clientState  {agentRunning}
 *
 * The user's own provider key arrives in the same x-provider* headers as every
 * other route, so voice works with Claude, GPT, Gemini or OpenRouter.
 */

const VOICE_SYSTEM_PROMPT = [
  'You are a concise, friendly voice assistant.',
  'You are being spoken aloud, so reply in one to three short sentences of plain speech.',
  'Never use markdown, bullet points, emoji, code blocks or lists.',
  'Answer the user directly and stop.'
].join(' ');

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function messageFromBody(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  if (typeof body.text === 'string' && body.text.trim()) return body.text.trim();
  if (typeof body.utterance === 'string' && body.utterance.trim()) return body.utterance.trim();
  // Fall back to the last user turn if the app ever sends a full transcript.
  const contents = Array.isArray(body.contents) ? body.contents : [];
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const entry = contents[i];
    if (String(entry?.role || 'user').toLowerCase() !== 'user') continue;
    const text = (entry.parts || [])
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    if (text) return text;
  }
  return '';
}

function replyTextFrom(geminiReply) {
  const parts = geminiReply?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
  return text;
}

export async function voiceTurnHandler(req, res) {
  const body = req.body || {};
  const message = messageFromBody(body);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!message) {
    sse(res, 'error', { error: 'Empty voice turn: no message was sent.', status: 400 });
    sse(res, 'done', {});
    return res.end();
  }

  const language = body?.options?.languageCode || body?.languageCode || '';
  const systemInstruction =
    VOICE_SYSTEM_PROMPT + (language ? ` The user's language code is ${language}; reply in that language.` : '');

  const upstreamReq = {
    headers: req.headers,
    body: {
      contents: [{ role: 'user', parts: [{ text: message }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
    }
  };

  try {
    const result = await handleGenerateContent(upstreamReq, 'generateContent');
    const reply = replyTextFrom(result);

    if (!reply) {
      const reason = result?.error || 'The model returned an empty reply.';
      sse(res, 'error', { error: reason, status: 502 });
      sse(res, 'decision', {
        type: 'Reply',
        reply: reason,
        instruction: '',
        shouldEnd: 'Finished',
        originalReply: ''
      });
      sse(res, 'done', {});
      return res.end();
    }

    // Speech first: this is what the app shows and speaks.
    sse(res, 'speech', { text: reply });

    // Then the decision. "Continue" keeps the conversation open, matching a
    // plain `reply` tool call in the chat path.
    sse(res, 'decision', {
      type: 'Reply',
      reply,
      instruction: '',
      shouldEnd: 'Continue',
      originalReply: reply
    });

    sse(res, 'done', {});
    return res.end();
  } catch (err) {
    const status = err?.upstreamStatus || 502;
    console.error('[bridge] /v1/voice/turn error:', err?.message || err);
    sse(res, 'error', { error: err?.message || 'Voice turn failed', status });
    sse(res, 'done', {});
    return res.end();
  }
}
