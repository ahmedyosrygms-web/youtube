# MCP Media Generator — خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي

خادم MCP (Model Context Protocol) يجمع ثلاث قدرات في أداة واحدة، مع لوحة إدارة عربية RTL كاملة:

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** بصوت متزامن أصلي — الموديل: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة وبالترتيب المطلوب

يستدعي نموذج الذكاء الاصطناعي هذه القدرات من أي عميل MCP (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK).

## القواعد الجوهرية المحقّقة

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر؛ تُخزَّن روابط النتائج فقط في قاعدة البيانات.
- **مفاتيح تسلسلية صارمة** — أول مفتاح أُضيف يُجرَّب أولًا (`created_at ASC`)، وليس round-robin.
- **تبديل صامت تلقائي** — عند أي خطأ (مفتاح غير صالح / نفاد رصيد / 429 / 5xx) تُستأنف **نفس المهمة بنفس `task_id`** على المفتاح التالي دون توقف، و**لا يرى نموذج الذكاء الاصطناعي أخطاء المفاتيح أو الرصيد أبدًا**.
- **لا استسلام** — المهمة التي تفشل على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية).
- **إخفاء المفاتيح** — لا يُعاد مفتاح كامل في أي استجابة (`maskKey` = أول 7 + نقاط + آخر 4).
- **حذف تلقائي** — ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة (مذكورة في وصف الأداة وتعليمات السيرفر).

## بنية المستودع

```
├── src/app/mcp/route.ts          # خادم MCP على /mcp (SDK الرسمي + نقل Streamable HTTP)
├── src/app/api/                  # health / keys / tasks — واجهات إدارة اللوحة
├── src/lib/                      # turso + models + keys + providers + generation + merge
├── src/app/page.tsx              # لوحة التحكم العربية (RTL): مفاتيح + مهام + ربط
├── merger/                       # مشروع مستقل كامل: موقع دمج الفيديوهات على Vercel
│   ├── api/                      # دوال Vercel Serverless (Node.js خالص CommonJS)
│   ├── lib/                      # قاعدة البيانات + التخزين + محرك ffmpeg + التنظيف
│   ├── public/index.html         # واجهة عربية RTL ثيم داكن + توثيق API
│   └── scripts/                  # اختبارات وحدات + HTTP (36 اختبارًا)
└── scripts/                      # أدوات صيانة واختبار المشروع الرئيسي
```

## الأدوات الخمس على /mcp

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة — تعيد الرابط جاهزًا أو `task_id` للمتابعة |
| `generate_video` | توليد فيديو بصوت — يعيد `task_id` ويُتابع بـ `get_task` |
| `merge_videos` | دمج 2–10 مقاطع بترتيبها (`urls` أو `task_ids`) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — استعلام كل ~10 ثوانٍ |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

## المتغيرات البيئية (المشروع الرئيسي)

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso مثل `libsql://<db>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | نعم | رابط خدمة الدمج المنشورة (انظر أدناه) |
| `MCP_ACCESS_TOKEN` | لا | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز أسماء الموديلات لكل مزود |

انسخ `.env.example` إلى `.env.local` واملأ القيم — **لا تُرفع ملفات `.env*` إلى Git أبدًا**.

## التشغيل محليًا

```bash
npm install            # أو bun install
cp .env.example .env.local   # ثم املأ القيم الحقيقية
npm run dev            # http://localhost:3000
```

أضف مفتاح `kie.ai` من اللوحة (مدير المفاتيح) وابدأ التوليد مباشرة.

## النشر على Vercel — خطوتان

### 1) المشروع الرئيسي (الجذر)

1. اربط المستودع بـ Vercel (New Project → اختر المستودع).
2. أضف متغيرات البيئة الثلاثة الإلزامية في **Settings → Environment Variables**: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE`.
3. Deploy — يعمل كل شيء لأن libSQL يتصل عبر HTTP، ومسار `/mcp` يدعم الـ streaming.
4. بعد النشر: افتح اللوحة، أضف مفاتيحك، وانسخ رابط `<origin>/mcp` إلى عميلك.

### 2) خدمة الدمج (مجلد `merger/`)

نشر منفصل بنفس المستودع (Root Directory = `merger`) أو مستودع خاص به:

```bash
cd merger
npx vercel           # أول مرة: اربط المشروع
# أضف TURSO_DATABASE_URL و TURSO_AUTH_TOKEN في إعدادات المشروع على Vercel
npx vercel --prod
```

ثم ضع رابط الخدمة المنشورة في `MERGER_API_BASE` للمشروع الرئيسي. التفاصيل الكاملة في [merger/README.md](merger/README.md).

> ملاحظة: `maxDuration: 300` في `vercel.json` لخدمة الدمج يتطلب خطة Pro على Vercel؛ على الخطة المجانية ستعمل الدمجات القصيرة حتى 60 ثانية.

## ربط العملاء بـ /mcp

**ChatGPT (Settings → Connectors → Create → Custom MCP server):**

```json
{ "mcpServers": { "media-generator": { "url": "https://<your-app>.vercel.app/mcp" } } }
```

**Claude Desktop (`claude_desktop_config.json`):**

```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<your-app>.vercel.app/mcp" } } }
```

**Cursor / Windsurf / Cline (`mcp.json`):** نفس صيغة ChatGPT.

اللوحة تعرض هذه الصيغ جاهزة للنسخ مع الرابط الحقيقي، وتضيف `headers.Authorization` تلقائيًا إن ضُبط `MCP_ACCESS_TOKEN`.

## قاعدة البيانات (Turso)

```bash
turso db create <name>
turso db show <name> --url        # → TURSO_DATABASE_URL
turso db tokens create <name>     # → TURSO_AUTH_TOKEN
```

الجداول (`tasks` و `api_keys`) تُنشأ تلقائيًا عند أول وصول — لا حاجة لأي migrations.

## الاختبارات المنفَّذة

- `tsc --noEmit` نظيف + `next build` ينجح مع التحقق من الأنواع مفعّلًا.
- اختبار e2e حقيقي: توليد صورة → رابط يعمل، وتوليد فيديو → رابط يعمل.
- اختبار التبديل التسلسلي: مفتاح خاطئ أولًا → المهمة اكتملت على المفتاح الثاني، الخاطئ صار `disabled`، ولم يصل العميل أي ذكر للمفاتيح.
- خدمة الدمج: **11 اختبار وحدات + 25 اختبار HTTP** — كلها ناجحة (الدمج، Range 206، الرفع بالأجزاء، الحدود، 404/400/405/409، الحذف الشامل، الـ cron).
