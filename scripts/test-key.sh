#!/usr/bin/env bash
# Test the bridge with your own provider key, without pasting the key anywhere.
#
# Usage (key stays in your shell, never in the chat):
#   export GEMINI_KEY=AIza...            # or CLAUDE_KEY=sk-ant-... / OPENAI_KEY=sk-... / OPENROUTER_KEY=sk-or-...
#   bash scripts/test-key.sh
#
# Optional:
#   BASE_URL=http://localhost:3000  # test a local bridge instead of the deployed one
#   PROVIDER=anthropic              # override the detected provider
set -u

BASE_URL="${BASE_URL:-https://gemini-bridge-dat6.onrender.com}"

if [ -n "${GEMINI_KEY:-}" ]; then
  KEY="$GEMINI_KEY"; PROVIDER="${PROVIDER:-gemini}"
  MODEL="${MODEL:-gemini-2.5-flash}"
  HDR_KEY="x-custom-gemini-key: $KEY"
elif [ -n "${CLAUDE_KEY:-}" ]; then
  KEY="$CLAUDE_KEY"; PROVIDER="${PROVIDER:-anthropic}"
  MODEL="${MODEL:-claude-haiku-4-5-20251001}"
  HDR_KEY="x-provider-api-key: $KEY"
elif [ -n "${OPENAI_KEY:-}" ]; then
  KEY="$OPENAI_KEY"; PROVIDER="${PROVIDER:-openai}"
  MODEL="${MODEL:-gpt-4o-mini}"
  HDR_KEY="x-provider-api-key: $KEY"
elif [ -n "${OPENROUTER_KEY:-}" ]; then
  KEY="$OPENROUTER_KEY"; PROVIDER="${PROVIDER:-openrouter}"
  MODEL="${MODEL:-google/gemini-2.5-flash}"
  HDR_KEY="x-provider-api-key: $KEY"
else
  echo "Set one of GEMINI_KEY / CLAUDE_KEY / OPENAI_KEY / OPENROUTER_KEY first." >&2
  exit 1
fi

echo "Bridge : $BASE_URL"
echo "Provider: $PROVIDER   Model: $MODEL"
echo "Key    : ${KEY:0:6}...${KEY: -3}  (masked)"
echo

echo "1) Key inspection (does the provider accept this key?)"
curl -sS --max-time 60 -X POST "$BASE_URL/v1/llm/inspect-key" \
  -H 'Content-Type: application/json' \
  -d "{\"apiKey\":\"$KEY\"}" \
  | python -c "import sys,json;d=json.load(sys.stdin);print('   valid=',d.get('valid'),'provider=',d.get('providerId'),'models=',len(d.get('models') or []),'error=',d.get('error'),d.get('message'))" 2>/dev/null \
  || echo "   (could not parse response)"
echo

echo "2) Normal chat turn (Gemini-shaped reply)"
curl -sS --max-time 120 -X POST "$BASE_URL/v1/gemini/generateContent" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer nexon_local_token' \
  -H "x-provider: $PROVIDER" \
  -H "$HDR_KEY" \
  -H "x-provider-model: $MODEL" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with exactly: bridge ok"}]}]}' \
  | python -c "
import sys,json
d=json.load(sys.stdin)
c=(d.get('candidates') or [{}])[0].get('content',{}).get('parts') or []
txt=''.join(p.get('text','') for p in c)
print('   noCredits =', d.get('noCredits'))
print('   reply     =', (txt or d.get('error','<empty>'))[:200])
" 2>/dev/null || echo "   (could not parse response)"
echo

echo "3) Voice turn (SSE: speech -> decision -> done)"
curl -sS --max-time 120 -N -X POST "$BASE_URL/v1/voice/turn" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'Authorization: Bearer nexon_local_token' \
  -H "x-provider: $PROVIDER" \
  -H "$HDR_KEY" \
  -H "x-provider-model: $MODEL" \
  -d '{"message":"Say hello in one short sentence.","options":{"languageCode":"en-IN"}}' \
  | head -20
echo
echo "Done. If step 2 returned text and step 3 showed speech/decision events, the app's own key path works."
