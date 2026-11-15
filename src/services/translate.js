/**
 * Translation between the shapes the app speaks and the shapes each upstream
 * provider speaks.
 *
 * The app always talks Gemini: requests carry `contents[]` whose parts are
 * `{text}`, `{functionCall:{name,args}}` or `{functionResponse:{name,response}}`,
 * and it reads replies from `candidates[].content.parts[]`. To let a user run
 * Claude or GPT, we translate out to that provider and translate the reply back
 * into the Gemini shape the app already knows how to parse.
 */

const ANTHROPIC_VERSION = '2023-06-01';

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

/** Pull the content array out of the various bodies the app can send. */
export function extractContents(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.contents)) return body.contents;
  if (body.content && Array.isArray(body.content.parts)) {
    return [{ role: body.content.role || 'user', parts: body.content.parts }];
  }
  if (Array.isArray(body.parts)) return [{ role: 'user', parts: body.parts }];
  if (typeof body.text === 'string') return [{ role: 'user', parts: [{ text: body.text }] }];
  if (typeof body.Reply === 'string') return [{ role: 'user', parts: [{ text: body.Reply }] }];
  return [];
}

/** Parts of one content entry, tolerating a bare string entry. */
function partsOf(entry) {
  if (typeof entry === 'string') return [{ text: entry }];
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.parts)) return entry.parts;
  if (typeof entry.text === 'string') return [{ text: entry.text }];
  return [];
}

/** Gemini calls the assistant "model"; everything else is a user turn. */
function roleOf(entry) {
  const role = String(entry?.role || 'user').toLowerCase();
  if (role === 'model' || role === 'assistant') return 'assistant';
  return 'user';
}

/** The system prompt, wherever the app happened to put it. */
export function extractSystemPrompt(body) {
  if (!body || typeof body !== 'object') return '';
  const fromInstruction = body.systemInstruction || body.system_instruction;
  if (fromInstruction) {
    const parts = Array.isArray(fromInstruction.parts)
      ? fromInstruction.parts
      : [{ text: fromInstruction.text || fromInstruction }];
    const text = parts
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }
  if (typeof body.system === 'string') return body.system.trim();
  return '';
}

function stringifyToolResult(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

function generationConfig(body) {
  const cfg = body?.generationConfig || body?.generation_config || {};
  const temperature = cfg.temperature ?? body?.temperature;
  const maxTokens =
    cfg.maxOutputTokens ?? body?.max_tokens ?? body?.maxOutputTokens ?? 2048;
  const stop =
    cfg.stopSequences ?? body?.stop ?? body?.stop_sequences ?? undefined;
  return {
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    maxTokens: typeof maxTokens === 'number' ? maxTokens : 2048,
    stop: Array.isArray(stop) ? stop : undefined
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Gemini declares tools as `[{functionDeclarations:[...]}]`. */
export function extractFunctionDeclarations(body) {
  const tools = body?.tools;
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    const decls = tool?.functionDeclarations || tool?.function_declarations;
    if (Array.isArray(decls)) out.push(...decls);
  }
  return out.filter((d) => d && d.name);
}

function toOpenAITools(declarations) {
  if (!declarations.length) return undefined;
  return declarations.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description || '',
      parameters: d.parameters || { type: 'object', properties: {} }
    }
  }));
}

function toAnthropicTools(declarations) {
  if (!declarations.length) return undefined;
  return declarations.map((d) => ({
    name: d.name,
    description: d.description || '',
    input_schema: d.parameters || { type: 'object', properties: {} }
  }));
}

// ---------------------------------------------------------------------------
// Gemini request -> OpenAI request
// ---------------------------------------------------------------------------

export function toOpenAIRequest(body, model) {
  const messages = [];
  const system = extractSystemPrompt(body);
  if (system) messages.push({ role: 'system', content: system });

  // tool_use id we handed out, keyed by function name, so a later
  // functionResponse can point at the matching tool call.
  const idByName = new Map();
  let callSeq = 0;

  for (const entry of extractContents(body)) {
    const role = roleOf(entry);
    const texts = [];
    const calls = [];
    const results = [];

    for (const part of partsOf(entry)) {
      if (typeof part === 'string') {
        texts.push(part);
      } else if (typeof part.text === 'string' && part.text) {
        texts.push(part.text);
      } else if (part.functionCall) {
        const name = part.functionCall.name;
        const id = `call_${++callSeq}`;
        idByName.set(name, id);
        calls.push({
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      } else if (part.functionResponse) {
        const name = part.functionResponse.name;
        results.push({
          role: 'tool',
          tool_call_id: idByName.get(name) || `call_${name}`,
          content: stringifyToolResult(part.functionResponse.response)
        });
      }
    }

    if (texts.length) {
      messages.push({ role, content: texts.join('\n') });
    }
    if (calls.length) {
      messages.push({
        role: 'assistant',
        content: texts.length ? texts.join('\n') : null,
        tool_calls: calls
      });
    }
    if (results.length) messages.push(...results);
  }

  const { temperature, maxTokens, stop } = generationConfig(body);
  const out = { model, messages, temperature, max_tokens: maxTokens };
  if (stop) out.stop = stop;

  const tools = toOpenAITools(extractFunctionDeclarations(body));
  if (tools) {
    out.tools = tools;
    out.tool_choice = 'auto';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gemini request -> Anthropic request
// ---------------------------------------------------------------------------

export function toAnthropicRequest(body, model) {
  const messages = [];
  const idByName = new Map();
  let callSeq = 0;

  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    // Anthropic expects alternating turns and merged same-role blocks.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const entry of extractContents(body)) {
    const role = roleOf(entry);
    const blocks = [];

    for (const part of partsOf(entry)) {
      if (typeof part === 'string') {
        blocks.push({ type: 'text', text: part });
      } else if (typeof part.text === 'string' && part.text) {
        blocks.push({ type: 'text', text: part.text });
      } else if (part.functionCall) {
        const name = part.functionCall.name;
        const id = `toolu_${++callSeq}`;
        idByName.set(name, id);
        blocks.push({
          type: 'tool_use',
          id,
          name,
          input: part.functionCall.args || {}
        });
      } else if (part.functionResponse) {
        const name = part.functionResponse.name;
        blocks.push({
          type: 'tool_result',
          tool_use_id: idByName.get(name) || `toolu_${name}`,
          content: stringifyToolResult(part.functionResponse.response)
        });
      }
    }

    // A user turn that only holds tool results is still a user turn.
    if (blocks.some((b) => b.type === 'tool_result')) push('user', blocks);
    else push(role, blocks);
  }

  // Anthropic requires a leading user message.
  if (!messages.length || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
  }

  const { temperature, maxTokens, stop } = generationConfig(body);
  const out = { model, max_tokens: maxTokens, temperature, messages };
  if (stop) out.stop_sequences = stop;

  const system = extractSystemPrompt(body);
  if (system) out.system = system;

  const tools = toAnthropicTools(extractFunctionDeclarations(body));
  if (tools) out.tools = tools;

  return out;
}

// ---------------------------------------------------------------------------
// Upstream reply -> Gemini reply
// ---------------------------------------------------------------------------

/** Wrap parts into the `candidates[]` envelope the app parses. */
function asGeminiReply(parts, finishReason, usage) {
  return {
    candidates: [
      {
        content: { parts, role: 'model' },
        finishReason: finishReason || 'STOP',
        averageLogprobs: null
      }
    ],
    audioContent: null,
    noCredits: false,
    promptFeedback: null,
    usageMetadata: usage
  };
}

function mapFinishReason(reason) {
  switch (String(reason || '').toLowerCase()) {
    case 'tool_calls':
    case 'tool_use':
      return 'STOP';
    case 'length':
    case 'max_tokens':
      return 'MAX_TOKENS';
    case 'content_filter':
    case 'refusal':
      return 'SAFETY';
    default:
      return 'STOP';
  }
}

export function fromOpenAIResponse(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message || {};
  const parts = [];

  if (typeof message.content === 'string' && message.content) {
    parts.push({ text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block === 'string') parts.push({ text: block });
      else if (block?.type === 'text' && block.text) parts.push({ text: block.text });
    }
  }

  for (const call of message.tool_calls || []) {
    if (call?.type && call.type !== 'function') continue;
    let args = {};
    try {
      args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      args = { raw: call?.function?.arguments };
    }
    parts.push({ functionCall: { name: call?.function?.name || 'unknown', args } });
  }

  if (!parts.length) parts.push({ text: '' });

  return asGeminiReply(parts, mapFinishReason(choice?.finish_reason), {
    promptTokenCount: data?.usage?.prompt_tokens || 0,
    candidatesTokenCount: data?.usage?.completion_tokens || 0,
    totalTokenCount: data?.usage?.total_tokens || 0
  });
}

export function fromAnthropicResponse(data) {
  const parts = [];
  for (const block of data?.content || []) {
    if (block?.type === 'text' && block.text) {
      parts.push({ text: block.text });
    } else if (block?.type === 'tool_use') {
      parts.push({
        functionCall: { name: block.name, args: block.input || {} }
      });
    }
  }
  if (!parts.length) parts.push({ text: '' });

  return asGeminiReply(parts, mapFinishReason(data?.stop_reason), {
    promptTokenCount: data?.usage?.input_tokens || 0,
    candidatesTokenCount: data?.usage?.output_tokens || 0,
    totalTokenCount:
      (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0)
  });
}

/** Gemini replies pass through, only normalized and stripped of `noCredits`. */
export function fromGeminiResponse(data) {
  const candidates = (data?.candidates || []).map((candidate) => {
    const parts = (candidate?.content?.parts || []).map((p) => {
      if (p?.functionCall) return { functionCall: p.functionCall };
      if (p?.inlineData) return { inlineData: p.inlineData };
      return { text: typeof p?.text === 'string' ? p.text : '' };
    });
    return {
      content: {
        parts: parts.length ? parts : [{ text: '' }],
        role: candidate?.content?.role || 'model'
      },
      finishReason: candidate?.finishReason || 'STOP',
      averageLogprobs: candidate?.averageLogprobs ?? null
    };
  });

  if (!candidates.length) {
    return {
      candidates: [],
      audioContent: null,
      noCredits: false,
      promptFeedback: data?.promptFeedback || null,
      error: data?.error?.message || data?.error || undefined
    };
  }

  return {
    candidates,
    audioContent: data?.audioContent || null,
    noCredits: false,
    promptFeedback: data?.promptFeedback || null,
    usageMetadata: data?.usageMetadata || null
  };
}

export { ANTHROPIC_VERSION };
