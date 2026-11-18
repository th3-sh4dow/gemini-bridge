import fs from 'fs';
import path from 'path';

const CACHE_FILE = process.env.ACTIVE_KEY_PATH || path.resolve(process.cwd(), '.active_key.json');
const IS_TEST = process.env.NODE_ENV === 'test';

export const activeKeyCache = {
  get key() { return this.apiKey; },
  set key(v) { this.apiKey = v; },
  apiKey: process.env.GEMINI_API_KEY || '',
  provider: 'gemini',
  model: 'gemini-3.1-flash-lite'
};

// Try loading on boot (skip in unit tests to keep tests isolated)
if (!IS_TEST) {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.apiKey) activeKeyCache.apiKey = parsed.apiKey;
      if (parsed.provider) activeKeyCache.provider = parsed.provider;
      if (parsed.model) activeKeyCache.model = parsed.model;
      console.log('[activeKeyStore] Restored active credentials for provider:', activeKeyCache.provider, 'model:', activeKeyCache.model);
    }
  } catch (e) {
    console.warn('[activeKeyStore] Failed to restore cached key:', e.message);
  }
}

export function saveActiveKey(apiKey, provider, model) {
  if (IS_TEST) return;
  if (apiKey) activeKeyCache.apiKey = apiKey;
  if (provider) activeKeyCache.provider = provider;
  if (model) activeKeyCache.model = model;

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(activeKeyCache, null, 2), 'utf-8');
  } catch (e) {
    // Non-fatal if filesystem is read-only
  }
}

export function withActiveKey(req) {
  const effectiveKey = req.headers['x-custom-gemini-key'] || req.headers['x-provider-api-key'] || activeKeyCache.apiKey || activeKeyCache.key;
  if (!req.headers['x-provider-api-key'] && effectiveKey) {
    req.headers['x-provider-api-key'] = effectiveKey;
  }
  if (!req.headers['x-provider'] && activeKeyCache.provider) {
    req.headers['x-provider'] = activeKeyCache.provider;
  }
  if (!req.headers['x-provider-model'] && activeKeyCache.model) {
    req.headers['x-provider-model'] = activeKeyCache.model;
  }
}
