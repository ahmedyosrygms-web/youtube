#!/usr/bin/env bash
# سكربت اختبار e2e لتوليد الفيديو: استدعاء generate_video ثم متابعة get_task كل ~10 ثوانٍ
set -u
BASE="http://localhost:3000/mcp"
H1='Content-Type: application/json'
H2='Accept: application/json, text/event-stream'

echo "[$(date +%T)] استدعاء generate_video..."
RESP=$(curl -sS --max-time 300 -X POST "$BASE" -H "$H1" -H "$H2" -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"generate_video","arguments":{"prompt":"A red paper lantern floating up into a night sky over an old city, cinematic, warm light","duration":5,"resolution":"480p","wait_seconds":25}}}')

TASK_ID=$(echo "$RESP" | python3 -c "
import json,sys
raw=sys.stdin.read()
data=json.loads(raw.split('data: ')[-1])
txt=data['result']['content'][0]['text']
import re
m=re.search(r'task_id: ([0-9a-f\-]+)', txt)
print(m.group(1) if m else '')
")
echo "[$(date +%T)] task_id: ${TASK_ID:-<اكتمل فورًا أو لا يوجد>}"
echo "$RESP" | python3 -c "
import json,sys
raw=sys.stdin.read()
data=json.loads(raw.split('data: ')[-1])
print('الاستجابة الأولى:', data['result']['content'][0]['text'][:200])
"

if [ -z "${TASK_ID}" ]; then
  echo "لا يوجد task_id — انتهى"
  exit 0
fi

# متابعة get_task كل 10 ثوانٍ حتى الاكتمال (بحد أقصى 12 دقيقة)
for i in $(seq 1 72); do
  sleep 10
  R=$(curl -sS --max-time 60 -X POST "$BASE" -H "$H1" -H "$H2" -d "{\"jsonrpc\":\"2.0\",\"id\":$((100+i)),\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$TASK_ID\"}}}")
  OUT=$(echo "$R" | python3 -c "
import json,sys
raw=sys.stdin.read()
try:
    data=json.loads(raw.split('data: ')[-1])
    print(data['result']['content'][0]['text'])
except Exception as e:
    print('PARSE_ERROR: '+str(e)+' :: '+raw[:200])
")
  STATUS=$(echo "$OUT" | head -1)
  echo "[$(date +%T)] محاولة $i: $STATUS"
  if echo "$OUT" | grep -q "✅"; then
    echo "=== اكتملت ==="
    echo "$OUT"
    echo "$TASK_ID" > /tmp/video_task_id.txt
    echo "$OUT" | grep -o 'https://[^ )]*' | head -1 > /tmp/video_url.txt
    exit 0
  fi
  if echo "$OUT" | grep -q "❌"; then
    echo "=== فشلت ==="
    echo "$OUT"
    exit 1
  fi
done
echo "انتهى الوقت دون اكتمال"
exit 2
