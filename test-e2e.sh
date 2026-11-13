#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
BASE="http://127.0.0.1:${PORT}"
KEY="${GEMINI_TEST_KEY:-}"

if [ -z "$KEY" ]; then
  echo "SKIP: set GEMINI_TEST_KEY to run a live Gemini round-trip"
  exit 0
fi

echo "== health =="
curl -s "$BASE/health" | python -m json.tool || true

echo "== ping =="
curl -s "$BASE/ping" | python -m json.tool || true

echo "== providers =="
curl -s "$BASE/v1/llm/providers" | python -m json.tool || true

echo "== inspect-key (Gemini format) =="
curl -s -X POST "$BASE/v1/llm/inspect-key" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$KEY\"}" | python -m json.tool || true

echo "== generateContent =="
curl -s -X POST "$BASE/v1/gemini/generateContent" \
  -H "Content-Type: application/json" \
  -H "x-custom-gemini-key: $KEY" \
  -d "{\"contents\":[{\"parts\":[{\"text\":\"Say hello in one sentence.\"}]}]}" \
  | python -m json.tool || true
