import axios from 'axios';
import { activeKeyCache, saveActiveKey } from './activeKeyStore.js';

export async function transcribeAudio(audioBuffer, mimeType, headers = {}) {
  let apiKey =
    headers['x-provider-api-key'] ||
    headers['x-custom-gemini-key'] ||
    activeKeyCache.apiKey ||
    process.env.GEMINI_API_KEY ||
    '';

  if (!apiKey && headers['authorization']) {
    const m = headers['authorization'].match(/^Bearer\s+(.+)$/i);
    if (m && m[1] && m[1] !== 'dummy_token') {
      apiKey = m[1].trim();
    }
  }

  if (apiKey && !activeKeyCache.apiKey) {
    saveActiveKey(apiKey, headers['x-provider'] || 'gemini');
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return '';
  }

  const effectiveMime = mimeType || 'audio/wav';

  // 1. If Groq API key (starts with gsk_):
  if (apiKey.startsWith('gsk_')) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: effectiveMime }), 'audio.wav');
      formData.append('model', 'whisper-large-v3-turbo');
      const resp = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000
      });
      const text = resp.data?.text?.trim() || '';
      if (text) return text;
    } catch (err) {
      console.error('[stt] Groq transcription error:', err?.response?.data || err.message);
    }
  }

  // 2. If OpenAI key (starts with sk- and not gsk- / AIza):
  if (apiKey.startsWith('sk-') && !apiKey.startsWith('AIza')) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: effectiveMime }), 'audio.wav');
      formData.append('model', 'whisper-1');
      const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000
      });
      const text = resp.data?.text?.trim() || '';
      if (text) return text;
    } catch (err) {
      console.error('[stt] OpenAI transcription error:', err?.response?.data || err.message);
    }
  }

  // 3. If Gemini key or any key that can talk to Gemini:
  if (apiKey) {
    const base64Audio = audioBuffer.toString('base64');
    const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-1.5-flash-8b'];
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const payload = {
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: effectiveMime,
                    data: base64Audio
                  }
                },
                {
                  text: 'Accurately transcribe the speech in this audio verbatim. If silent or unintelligible, output nothing. Return ONLY the transcribed text, with no labels, markdown, or commentary.'
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.0
          }
        };
        const resp = await axios.post(url, payload, { timeout: 15000 });
        const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        if (text) return text;
      } catch (err) {
        console.warn(`[stt] Gemini ${model} error:`, err?.response?.data?.error?.message || err.message);
      }
    }
  }

  return '';
}
