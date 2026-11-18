import axios from 'axios';
import { activeKeyCache, saveActiveKey } from './activeKeyStore.js';

/**
 * Boosts peak amplitude of 16-bit Mono PCM audio if recorded with low gain/quiet mic.
 * Prevents whispery or quiet microphone input from being dropped by the transcription model.
 */
export function boostPcmVolume(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 2) return pcmBuffer;
  let maxAbs = 0;
  for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
    const val = Math.abs(pcmBuffer.readInt16LE(i));
    if (val > maxAbs) maxAbs = val;
  }
  // If peak is quiet (between 200 and 12,000 out of max 32,767), boost up to 24,000 (~73% peak)
  if (maxAbs > 200 && maxAbs < 12000) {
    const gain = Math.min(6.0, 24000 / maxAbs);
    const boosted = Buffer.alloc(pcmBuffer.length);
    for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
      let sample = pcmBuffer.readInt16LE(i) * gain;
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;
      boosted.writeInt16LE(Math.round(sample), i);
    }
    return boosted;
  }
  return pcmBuffer;
}

/**
 * Converts raw 16-bit Mono PCM buffer to a compliant standard 44-byte RIFF/WAVE buffer.
 */
export function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format = 1
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

export async function transcribeAudio(audioBuffer, mimeType, headers = {}) {
  let apiKey =
    headers['x-provider-api-key'] ||
    headers['x-custom-gemini-key'] ||
    activeKeyCache.apiKey ||
    activeKeyCache.key ||
    process.env.GEMINI_API_KEY ||
    '';

  if (!apiKey && headers['authorization']) {
    const m = headers['authorization'].match(/^Bearer\s+(.+)$/i);
    if (m && m[1] && m[1] !== 'dummy_token' && m[1] !== 'nexon_local_token' && m[1].length > 15) {
      apiKey = m[1].trim();
    }
  }

  if (apiKey && !activeKeyCache.apiKey) {
    saveActiveKey(apiKey, headers['x-provider'] || 'gemini');
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return '';
  }

  let effectiveMime = mimeType || 'audio/wav';
  let processedBuffer = audioBuffer;

  // Auto-detect audio container and normalize MIME type
  if (audioBuffer.length >= 44 && audioBuffer.slice(0, 4).toString() === 'RIFF') {
    effectiveMime = 'audio/wav';
    try {
      const pcmPayload = audioBuffer.slice(44);
      const boosted = boostPcmVolume(pcmPayload);
      if (boosted !== pcmPayload) {
        processedBuffer = Buffer.concat([audioBuffer.slice(0, 44), boosted]);
      }
    } catch (_) {}
  } else if (audioBuffer.length >= 3 && (audioBuffer.slice(0, 3).toString() === 'ID3' || (audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0))) {
    effectiveMime = 'audio/mp3';
  } else if (audioBuffer.length >= 4 && audioBuffer.slice(0, 4).toString() === 'OggS') {
    effectiveMime = 'audio/ogg';
  } else if (!mimeType || mimeType === 'application/octet-stream') {
    // Raw PCM: boost and wrap with standard 16kHz WAV header
    const boosted = boostPcmVolume(audioBuffer);
    processedBuffer = pcmToWav(boosted, 16000, 1, 16);
    effectiveMime = 'audio/wav';
  }

  // 1. If Groq API key:
  if (apiKey.startsWith('gsk_')) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([processedBuffer], { type: effectiveMime }), 'audio.wav');
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

  // 2. If OpenAI key:
  if (apiKey.startsWith('sk-') && !apiKey.startsWith('AIza')) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([processedBuffer], { type: effectiveMime }), 'audio.wav');
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

  // 3. Gemini key:
  if (apiKey) {
    const base64Audio = processedBuffer.toString('base64');
    const requestedModel = headers['x-provider-model'] || activeKeyCache.model;
    const modelCandidates = [
      requestedModel,
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b'
    ].filter(Boolean);

    const models = [...new Set(modelCandidates)];

    const promptText = `Accurately transcribe all spoken words in this audio into written text verbatim.
- Language: English (including Indian English), Hindi, or Hinglish verbatim.
- Do NOT hallucinate, summarize, or omit words.
- Output ONLY the transcription text.
- Do NOT output timestamps, labels, notes, quotes, or markdown formatting.
- Return an empty string only if there is absolutely no spoken voice (pure silence).`;

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
                  text: promptText
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.0
          }
        };
        const resp = await axios.post(url, payload, { timeout: 15000 });
        let text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        if (text) {
          text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
          text = text.replace(/^["']|["']$/g, '').trim();
          console.log(`[stt] Gemini (${model}) transcribed: "${text}"`);
          return text;
        }
      } catch (err) {
        console.warn(`[stt] Gemini ${model} error:`, err?.response?.data?.error?.message || err.message);
      }
    }
  }

  return '';
}
