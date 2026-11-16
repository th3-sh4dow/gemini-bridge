/**
 * End-to-end provider tests.
 *
 * Boots a mock upstream, points every provider base URL at it, starts the real
 * bridge process and drives it over HTTP exactly like the app does. This proves
 * a Claude key, an OpenAI key, an OpenRouter key and a Gemini key all reach the
 * right upstream with the right auth, and that replies (including tool calls)
 * come back in the Gemini shape the app parses.
 *
 *   node --test test/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(here, '..');

const seen = [];
let upstream;
let upstreamPort;
let bridge;
let bridgePort;

const GEMINI_KEY = 'AIzaTESTKEY123';
const CLAUDE_KEY = 'sk-ant-api03-TESTKEY';
const OPENAI_KEY = 'sk-proj-TESTKEY';
const OPENROUTER_KEY = 'sk-or-v1-TESTKEY';
const CUSTOM_KEY = 'my-gateway-key';
const CUSTOM_BASE = () => `http://127.0.0.1:${upstreamPort}/gateway/v1`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(url, attempts = 100) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      http
        .get(url, (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          if (left <= 0) return reject(new Error(`health check failed: ${res.statusCode}`));
          setTimeout(() => tryOnce(left - 1), 100);
        })
        .on('error', () => {
          if (left <= 0) return reject(new Error('bridge never came up'));
          setTimeout(() => tryOnce(left - 1), 100);
        });
    };
    tryOnce(attempts);
  });
}

function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = { raw };
        }
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });

        const json = (obj, status = 200) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };

        // ---- model listing ----
        if (req.method === 'GET' && req.url.startsWith('/v1beta/models')) {
          return json({
            models: [
              { name: 'models/gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/text-embedding-004', displayName: 'Embed', supportedGenerationMethods: ['embedContent'] }
            ]
          });
        }
        if (req.method === 'GET' && req.url.endsWith('/models')) {
          return json({
            data: [
              { id: 'gpt-4o-mini' },
              { id: 'o3-mini' },
              { id: 'llama-3.1-70b-instruct' },
              { id: 'qwen2.5-72b-instruct' },
              { id: 'text-embedding-3-small' },
              { id: 'whisper-1' },
              { id: 'dall-e-3' }
            ]
          });
        }

        // ---- anthropic ----
        if (req.method === 'POST' && req.url.endsWith('/v1/messages')) {
          if (body.max_tokens === 1) {
            return json({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
          }
          const wantsTool = (body.tools || []).length > 0;
          if (wantsTool) {
            return json({
              content: [
                { type: 'text', text: 'Let me check.' },
                { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Pune' } }
              ],
              stop_reason: 'tool_use',
              usage: { input_tokens: 11, output_tokens: 7 }
            });
          }
          return json({
            content: [{ type: 'text', text: 'Hello from Claude.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 }
          });
        }

        // ---- openai-compatible ----
        if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
          const wantsTool = (body.tools || []).length > 0;
          if (wantsTool) {
            return json({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"city":"Pune"}' }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ],
              usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
            });
          }
          return json({
            choices: [{ message: { role: 'assistant', content: 'Hello from GPT.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
          });
        }

        // ---- gemini ----
        if (req.method === 'POST' && /:generateContent/.test(req.url)) {
          return json({
            candidates: [
              { content: { parts: [{ text: 'Hello from Gemini.' }], role: 'model' }, finishReason: 'STOP' }
            ],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 }
          });
        }

        return json({ error: 'unhandled mock route' }, 404);
      });
    });

    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = upstream.address().port;
      resolve();
    });
  });
}

async function post(pathname, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${bridgePort}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer nexon_local_token', ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

async function get(pathname) {
  const res = await fetch(`http://127.0.0.1:${bridgePort}${pathname}`);
  return { status: res.status, json: await res.json() };
}

const CHAT_BODY = {
  contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }]
};

const TOOL_BODY = {
  contents: [{ role: 'user', parts: [{ text: 'Weather in Pune?' }] }],
  systemInstruction: { parts: [{ text: 'You are Panda.' }] },
  tools: [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
        }
      ]
    }
  ]
};

before(async () => {
  await startUpstream();
  bridgePort = await freePort();
  const base = `http://127.0.0.1:${upstreamPort}`;
  bridge = spawn(process.execPath, ['src/server.js'], {
    cwd: bridgeDir,
    env: {
      ...process.env,
      PORT: String(bridgePort),
      NODE_ENV: 'test',
      BRIDGE_LOG: '_minimal_',
      GEMINI_BASE_URL: base,
      ANTHROPIC_BASE_URL: base,
      OPENAI_BASE_URL: base,
      OPENROUTER_BASE_URL: base
    },
    stdio: 'ignore'
  });
  await waitForHealth(`http://127.0.0.1:${bridgePort}/health`);
});

after(() => {
  bridge?.kill();
  upstream?.close();
});

// ---------------------------------------------------------------------------

test('Claude key is routed to Anthropic with x-api-key auth', async () => {
  const { status, json } = await post('/v1/gemini/generateContent', CHAT_BODY, {
    'x-provider': 'anthropic',
    'x-provider-api-key': CLAUDE_KEY,
    'x-provider-model': 'claude-haiku-4-5-20251001'
  });

  assert.equal(status, 200);
  assert.equal(json.noCredits, false);
  assert.equal(json.candidates[0].content.parts[0].text, 'Hello from Claude.');

  const hit = seen.find((r) => r.url.endsWith('/v1/messages') && r.body.max_tokens !== 1);
  assert.ok(hit, 'anthropic upstream was called');
  assert.equal(hit.headers['x-api-key'], CLAUDE_KEY);
  assert.equal(hit.headers['anthropic-version'], '2023-06-01');
  assert.equal(hit.body.model, 'claude-haiku-4-5-20251001');
  assert.equal(hit.body.messages[0].role, 'user');
  assert.equal(hit.body.messages[0].content[0].text, 'Say hello');
});

test('Claude tool calls come back as Gemini functionCall parts', async () => {
  const { json } = await post('/v1/gemini/generateContent', TOOL_BODY, {
    'x-provider': 'anthropic',
    'x-provider-api-key': CLAUDE_KEY,
    'x-provider-model': 'claude-sonnet-4-5-20250929'
  });

  const parts = json.candidates[0].content.parts;
  const call = parts.find((p) => p.functionCall);
  assert.ok(call, 'functionCall part present');
  assert.equal(call.functionCall.name, 'get_weather');
  assert.deepEqual(call.functionCall.args, { city: 'Pune' });

  const hit = seen.filter((r) => r.url.endsWith('/v1/messages')).at(-1);
  assert.equal(hit.body.system, 'You are Panda.');
  assert.equal(hit.body.tools[0].name, 'get_weather');
  assert.equal(hit.body.tools[0].input_schema.required[0], 'city');
});

test('OpenAI key uses Bearer auth and converts tool_calls', async () => {
  const { json } = await post('/v1/gemini/generateContent', TOOL_BODY, {
    'x-provider': 'openai',
    'x-provider-api-key': OPENAI_KEY,
    'x-provider-model': 'gpt-4o-mini'
  });

  const call = json.candidates[0].content.parts.find((p) => p.functionCall);
  assert.ok(call);
  assert.equal(call.functionCall.name, 'get_weather');
  assert.deepEqual(call.functionCall.args, { city: 'Pune' });

  const hit = seen.filter((r) => r.url.endsWith('/chat/completions')).at(-1);
  assert.equal(hit.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(hit.body.model, 'gpt-4o-mini');
  assert.equal(hit.body.messages[0].role, 'system');
  assert.equal(hit.body.tools[0].function.name, 'get_weather');
});

test('OpenRouter key routes to the openrouter base URL', async () => {
  const { json } = await post('/v1/gemini/generateContent', CHAT_BODY, {
    'x-provider': 'openrouter',
    'x-provider-api-key': OPENROUTER_KEY,
    'x-provider-model': 'google/gemini-3.1-flash-lite'
  });
  assert.equal(json.candidates[0].content.parts[0].text, 'Hello from GPT.');
  const hit = seen.filter((r) => r.url.endsWith('/chat/completions')).at(-1);
  assert.equal(hit.headers.authorization, `Bearer ${OPENROUTER_KEY}`);
});

test('Gemini key goes to generateContent with the key in the query string', async () => {
  const { json } = await post('/v1/gemini/generateContent', CHAT_BODY, {
    'x-custom-gemini-key': GEMINI_KEY,
    'x-provider-model': 'gemini-3.1-flash-lite'
  });
  assert.equal(json.candidates[0].content.parts[0].text, 'Hello from Gemini.');
  assert.equal(json.noCredits, false);

  const hit = seen.filter((r) => /:generateContent/.test(r.url)).at(-1);
  assert.ok(hit.url.includes(`key=${GEMINI_KEY}`));
  assert.equal(hit.body.contents[0].parts[0].text, 'Say hello');
});

test('a custom base URL is honoured for any OpenAI-compatible gateway', async () => {
  const { json } = await post('/v1/gemini/generateContent', CHAT_BODY, {
    'x-provider': 'custom',
    'x-provider-api-key': CUSTOM_KEY,
    'x-provider-model': 'llama-3.1-70b',
    'x-provider-base-url': CUSTOM_BASE()
  });
  assert.equal(json.candidates[0].content.parts[0].text, 'Hello from GPT.');
  const hit = seen.filter((r) => r.url.startsWith('/gateway/v1/chat/completions')).at(-1);
  assert.ok(hit, 'custom gateway was called');
  assert.equal(hit.headers.authorization, `Bearer ${CUSTOM_KEY}`);
  assert.equal(hit.body.model, 'llama-3.1-70b');
});

test('provider is inferred from the key when x-provider is absent', async () => {
  const { json } = await post('/v1/gemini/generateContent', CHAT_BODY, {
    'x-provider-api-key': CLAUDE_KEY
  });
  assert.equal(json.candidates[0].content.parts[0].text, 'Hello from Claude.');
});

test('no key yields a clean Gemini-shaped error with noCredits:false', async () => {
  const { json } = await post('/v1/gemini/generateContent', CHAT_BODY, {});
  assert.equal(json.noCredits, false);
  assert.equal(json.candidates.length, 0);
  assert.match(json.error, /API key/i);
});

test('an empty memories call returns success without calling upstream', async () => {
  const before = seen.length;
  const { json } = await post('/v1/gemini/generateMemories', {}, {
    'x-provider': 'anthropic',
    'x-provider-api-key': CLAUDE_KEY
  });
  assert.equal(json.ok, true);
  assert.equal(seen.length, before, 'no upstream call for an empty body');
});

test('provider presets match the app ProviderPreset schema and include Claude', async () => {
  const { json } = await get('/v1/llm/providers');
  const ids = json.providers.map((p) => p.id);
  for (const id of ['gemini', 'anthropic', 'openai', 'openrouter']) {
    assert.ok(ids.includes(id), `${id} offered`);
  }
  const claude = json.providers.find((p) => p.id === 'anthropic');
  assert.equal(claude.displayName, 'Claude');
  assert.equal(typeof claude.tier, 'number');
  assert.equal(claude.keyHint, 'sk-ant-...');
  assert.equal(claude.recommendedModelId, 'claude-haiku-4-5-20251001');
  for (const p of json.providers) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.displayName, 'string');
    assert.equal(typeof p.tier, 'number');
    assert.equal(typeof p.keyHint, 'string');
    assert.equal(typeof p.setupUrl, 'string');
    assert.ok(Array.isArray(p.privacyPolicyBullets));
  }
});

test('inspect-key validates a Claude key against the provider', async () => {
  const { json } = await post('/v1/llm/inspect-key', { apiKey: CLAUDE_KEY });
  assert.equal(json.valid, true);
  assert.equal(json.providerId, 'anthropic');
  assert.equal(json.displayName, 'Claude');
  assert.ok(json.models.some((m) => m.id === 'claude-haiku-4-5-20251001'));
  assert.equal(json.recommendedModelId, 'claude-haiku-4-5-20251001');
});

test('inspect-key discovers Gemini models and filters non-chat ones', async () => {
  const { json } = await post('/v1/llm/inspect-key', { apiKey: GEMINI_KEY });
  assert.equal(json.valid, true);
  assert.equal(json.providerId, 'gemini');
  const ids = json.models.map((m) => m.id);
  assert.ok(ids.includes('gemini-3.1-flash-lite'));
  assert.ok(!ids.includes('text-embedding-004'), 'embedding model filtered out');
});

test('inspect-key offers every chat model, not a curated few', async () => {
  const { json } = await post('/v1/llm/inspect-key', { apiKey: OPENAI_KEY });
  assert.equal(json.valid, true);
  const ids = json.models.map((m) => m.id);

  // Everything conversational the key can reach is offered.
  for (const id of ['gpt-4o-mini', 'o3-mini', 'llama-3.1-70b-instruct', 'qwen2.5-72b-instruct']) {
    assert.ok(ids.includes(id), `${id} should be offered`);
  }

  // Only non-conversational models are dropped.
  for (const id of ['text-embedding-3-small', 'whisper-1', 'dall-e-3']) {
    assert.ok(!ids.includes(id), `${id} should be excluded`);
  }

  assert.ok(json.models.length >= 4);
});

test('inspect-key exposes a broad Claude catalogue', async () => {
  const { json } = await post('/v1/llm/inspect-key', { apiKey: CLAUDE_KEY });
  const ids = json.models.map((m) => m.id);
  assert.ok(ids.length >= 10, `expected a broad Claude list, got ${ids.length}`);
  assert.ok(ids.includes('claude-opus-4-5-20251101'));
  assert.ok(ids.includes('claude-3-haiku-20240307'));
});

test('inspect-key rejects an unrecognised key shape', async () => {
  const { json } = await post('/v1/llm/inspect-key', { apiKey: 'totally-bogus' });
  assert.equal(json.valid, false);
  assert.equal(json.error, 'unrecognized_key');
});

test('inspect-key reports a provider 401 as an invalid key', async () => {
  const original = upstream.listeners('request')[0];
  upstream.removeAllListeners('request');
  upstream.on('request', (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
  });
  try {
    const { json } = await post('/v1/llm/inspect-key', { apiKey: CLAUDE_KEY });
    assert.equal(json.valid, false);
    assert.equal(json.error, 'invalid_key');
  } finally {
    upstream.removeAllListeners('request');
    upstream.on('request', original);
  }
});

// ---------------------------------------------------------------------------
// Voice turns (SSE)
// ---------------------------------------------------------------------------

function parseSSE(text) {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const frame = {};
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) frame.event = line.slice(7).trim();
        else if (line.startsWith('data: ')) {
          try {
            frame.data = JSON.parse(line.slice(6));
          } catch {
            frame.data = line.slice(6);
          }
        }
      }
      return frame;
    });
}

async function voiceTurn(body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/voice/turn`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer nexon_local_token',
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type'), events: parseSSE(text) };
}

test('voice turn streams speech then decision then done with Claude', async () => {
  const { status, contentType, events } = await voiceTurn(
    { message: 'What is the time?', options: { languageCode: 'en-IN', pace: 1 } },
    { 'x-provider': 'anthropic', 'x-provider-api-key': CLAUDE_KEY, 'x-provider-model': 'claude-haiku-4-5-20251001' }
  );

  assert.equal(status, 200);
  assert.match(contentType, /text\/event-stream/);

  const speech = events.find((e) => e.event === 'speech');
  const decision = events.find((e) => e.event === 'decision');
  const done = events.find((e) => e.event === 'done');

  assert.ok(speech, 'speech event emitted');
  assert.equal(typeof speech.data.text, 'string');
  assert.ok(speech.data.text.length > 0);

  assert.ok(decision, 'decision event emitted');
  assert.equal(decision.data.type, 'Reply');
  assert.equal(decision.data.shouldEnd, 'Continue');
  assert.equal(decision.data.reply, speech.data.text);
  assert.ok(done, 'done event emitted');

  const hit = seen.filter((r) => r.url.endsWith('/v1/messages')).at(-1);
  assert.equal(hit.headers['x-api-key'], CLAUDE_KEY, 'voice used the user key');
});

test('voice turn works with a Gemini key too', async () => {
  const { events } = await voiceTurn(
    { message: 'Hello there' },
    { 'x-custom-gemini-key': GEMINI_KEY, 'x-provider-model': 'gemini-3.1-flash-lite' }
  );
  const speech = events.find((e) => e.event === 'speech');
  assert.ok(speech);
  assert.equal(speech.data.text, 'Hello from Gemini.');
});

test('voice turn emits type: Task and carries instruction for action intents', async () => {
  const { status, events } = await voiceTurn(
    { message: 'Play lo-fi music on YouTube' },
    { 'x-custom-gemini-key': GEMINI_KEY, 'x-provider-model': 'gemini-3.1-flash-lite' }
  );
  assert.equal(status, 200);
  const decision = events.find((e) => e.event === 'decision');
  assert.ok(decision, 'decision event emitted');
  assert.equal(decision.data.type, 'Task');
  assert.equal(decision.data.instruction, 'Play lo-fi music on YouTube');
});

test('an empty voice turn reports an error event instead of hanging', async () => {
  const { events } = await voiceTurn({ message: '   ' }, { 'x-provider-api-key': CLAUDE_KEY });
  const error = events.find((e) => e.event === 'error');
  assert.ok(error);
  assert.match(error.data.error, /Empty voice turn/i);
  assert.ok(events.find((e) => e.event === 'done'));
});

test('agentCall transforms Gemini reply into AgentOutput with action array', async () => {
  const { json } = await post(
    '/v1/gemini/agentCall',
    {
      contents: [{ role: 'user', parts: [{ text: 'Open Settings' }] }]
    },
    { 'x-custom-gemini-key': GEMINI_KEY, 'x-provider-model': 'gemini-3.1-flash-lite' }
  );
  assert.ok(Array.isArray(json.action), 'action must be an array');
  assert.ok(json.action.length > 0, 'action array must not be empty');
  assert.ok('thinking' in json);
  assert.ok('evaluationPreviousGoal' in json);
  assert.ok('memory' in json);
  assert.ok('nextGoal' in json);
});
