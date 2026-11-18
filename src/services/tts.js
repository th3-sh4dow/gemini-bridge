import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { MPEGDecoder } from 'mpg123-decoder';
import axios from 'axios';

// Maps app voice names to Edge Neural voices
function mapVoice(voiceId, languageCode) {
  const v = (voiceId || '').toLowerCase();
  const lang = (languageCode || '').toLowerCase();

  if (lang.includes('hi') || v.includes('sarvam') || v.includes('meera') || v.includes('swara')) {
    return 'hi-IN-SwaraNeural';
  }
  if (v.includes('shubh') || v.includes('madhur') || v.includes('prabhat')) {
    return 'hi-IN-MadhurNeural';
  }
  if (lang.includes('in') && (v.includes('neerja') || v.includes('female'))) {
    return 'en-IN-NeerjaNeural';
  }

  // Male Chirp voices
  const maleVoices = ['achird', 'algenib', 'algieba', 'alnilam', 'charon', 'enceladus', 'fenrir', 'iapetus', 'orus', 'puck', 'rasalgethi', 'sadachbia', 'sadaltager', 'schedar', 'umbriel', 'zubenelgenubi', 'male', 'guy', 'christopher'];
  if (maleVoices.some(m => v.includes(m))) {
    return 'en-US-ChristopherNeural';
  }

  // Default natural female voice
  return 'en-US-AriaNeural';
}

/**
 * Resamples Float32Array from inSampleRate to outSampleRate (linear interpolation).
 */
function resampleFloat32(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLength = Math.round(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const idx0 = Math.floor(srcIdx);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = srcIdx - idx0;
    output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return output;
}

/**
 * Decodes an MP3 Buffer into raw 24kHz 16-bit Mono PCM.
 */
async function decodeMp3To24kMonoPcm(mp3Buffer) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, sampleRate } = decoder.decode(mp3Buffer);
    if (!channelData || channelData.length === 0 || channelData[0].length === 0) {
      throw new Error('Decoder produced empty channelData');
    }

    const numChannels = channelData.length;
    const numSamples = channelData[0].length;
    
    // Mix down to mono Float32Array
    const monoFloat = new Float32Array(numSamples);
    if (numChannels === 1) {
      monoFloat.set(channelData[0]);
    } else {
      for (let i = 0; i < numSamples; i++) {
        let sum = 0;
        for (let ch = 0; ch < numChannels; ch++) {
          sum += channelData[ch][i];
        }
        monoFloat[i] = sum / numChannels;
      }
    }

    // Resample to 24000 Hz if necessary
    const resampled = sampleRate === 24000 ? monoFloat : resampleFloat32(monoFloat, sampleRate, 24000);

    // Convert to 16-bit signed PCM buffer (little-endian)
    const pcmBuffer = Buffer.alloc(resampled.length * 2);
    for (let i = 0; i < resampled.length; i++) {
      let s = Math.max(-1, Math.min(1, resampled[i]));
      let val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      pcmBuffer.writeInt16LE(Math.round(val), i * 2);
    }

    return pcmBuffer;
  } finally {
    decoder.free();
  }
}

/**
 * Synthesize speech via Edge TTS and return raw 24kHz 16-bit Mono PCM with timeout.
 */
async function synthesizeViaEdge(text, voiceName) {
  const edgePromise = (async () => {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);

    const chunks = [];
    audioStream.on('data', c => chunks.push(c));

    await new Promise((resolve, reject) => {
      audioStream.on('end', resolve);
      audioStream.on('error', reject);
    });

    const mp3 = Buffer.concat(chunks);
    return await decodeMp3To24kMonoPcm(mp3);
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Edge TTS timed out after 2500ms')), 2500)
  );

  return Promise.race([edgePromise, timeoutPromise]);
}

/**
 * Fallback synthesis via Google Translate TTS with sentence chunking.
 */
async function synthesizeViaGoogleTranslate(text, languageCode = 'en') {
  const tl = languageCode.startsWith('hi') ? 'hi' : 'en';
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > 180) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  if (chunks.length === 0) chunks.push(text.slice(0, 180));

  const pcmBuffers = [];
  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${tl}&q=${encodeURIComponent(chunk)}`;
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/'
      },
      timeout: 5000
    });
    const mp3 = Buffer.from(response.data);
    const pcm = await decodeMp3To24kMonoPcm(mp3);
    pcmBuffers.push(pcm);
  }

  return Buffer.concat(pcmBuffers);
}

/**
 * Synthesizes text into 24kHz 16-bit signed Mono PCM bytes.
 * Matches Android AudioTrack: ENCODING_PCM_16BIT, CHANNEL_OUT_MONO, sampleRate=24000.
 */
export async function synthesizeSpeech(text, voiceId, languageCode) {
  if (!text || !text.trim()) {
    return Buffer.alloc(0);
  }

  const voiceName = mapVoice(voiceId, languageCode);
  try {
    return await synthesizeViaEdge(text, voiceName);
  } catch (edgeErr) {
    console.warn('[tts] Edge TTS synthesis failed, falling back to Google Translate TTS:', edgeErr.message);
    return await synthesizeViaGoogleTranslate(text, languageCode);
  }
}
