# 🎬 دمج الفيديوهات على Vercel — Video Merger API

خدمة كاملة لدمج الفيديوهات بجودة عالية، مبنية بـ **Node.js خالص (CommonJS)** بدون أي إطار عمل —
واجهة عربية RTL بثيم داكن (تدرجات سماوي/بنفسجي) + واجهة برمجية عامة (API) + تخزين كامل في **Turso (libSQL)**.

- لا S3 ولا خدمات خارجية: المهام، أجزاء المصادر المرفوعة، والفيديو الناتج — كلها Blobs في Turso.
- الدمج عبر **ffmpeg** داخل الدالة نفسها (`ffmpeg-static` + `ffprobe-static`).
- الناتج: MP4 بـ **libx264 CRF 18 + AAC 192k/44100 + faststart** — يعمل فورًا على الويب.
- حذف تلقائي لكل شيء بعد **24 ساعة** (تنظيف كسول + Cron يومي).

---

## 1) البنية

```
merger/
├── api/                        # دوال Vercel Serverless (Node.js خالص)
│   ├── jobs.js                 # POST /api/jobs        — إنشاء مهمة
│   ├── upload.js               # POST /api/upload      — رفع أجزاء الملفات (≤4MB)
│   ├── config.js               # GET  /api/config      — الحدود + version
│   ├── cron.js                 # GET  /api/cron        — حذف المهام المنتهية
│   └── jobs/
│       ├── [id].js             # GET/DELETE /api/jobs/<id>
│       └── [id]/
│           ├── process.js      # POST /api/jobs/<id>/process — الدمج المتزامن
│           └── video.js        # GET  /api/jobs/<id>/video    — بث بدعم Range
├── lib/                        # المنطق
│   ├── env.js                  # تحميل .env يدويًا + الحدود
│   ├── util.js                 # استجابات JSON، CORS، قراءة الجسم، تحليل Range
│   ├── db.js                   # عميل Turso + المخطط + عمليات المهام
│   ├── storage.js              # تقسيم الـ Blobs (2MB) وتجميعها وقراءتها بصفحات (8)
│   ├── download.js             # تنزيل الروابط المباشرة مع مراقبة الحجم
│   ├── merge.js                # محرك الدمج (ffprobe + filter_complex + تقدم الترميز)
│   ├── cleanup.js              # الحذف التلقائي (24 ساعة)
│   └── jobs.js                 # التحقق من المدخلات + أشكال الاستجابات الموحدة
├── public/
│   └── index.html              # الواجهة الكاملة (HTML + CSS + JS في ملف واحد)
├── scripts/
│   ├── test-unit.js            # اختبار وحدات محرك الدمج والتخزين
│   └── test-http.js            # اختبار HTTP كامل ضد خادم التطوير
├── server.js                   # خادم تطوير محلي يحاكي Vercel (المنفذ 3001)
├── vercel.json                 # maxDuration 300 لكل الدوال + Cron يومي
├── .env.example                # نسخة نموذجية بدون قيم حقيقية
└── .gitignore                  # يتضمن .env منذ البداية
```

---

## 2) التشغيل محليًا

```bash
cd merger
npm install

# 1) انسخ النسخة النموذجية واملأ القيم الحقيقية من Turso (لا تُرفع إلى Git)
cp .env.example .env

# 2) شغّل خادم التطوير (يحاكي Vercel: يفك المسارات الديناميكية ويضعها في req.query)
node server.js
# ✅ يعمل على http://localhost:3001
```

ثم افتح `http://localhost:3001` — أو جرّب الـ API مباشرة:

```bash
curl http://localhost:3001/api/config
```

> خادم التطوير يخدم الواجهة من `public/` ويوجّه `/api/*` إلى نفس دوال Vercel حرفيًا.

---

## 3) إنشاء قاعدة Turso والحصول على الرابط والتوكن

1. **أنشئ حسابًا** على [turso.tech](https://turso.tech) ثم ثبّت الواجهة:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   ```
2. **أنشئ قاعدة**:
   ```bash
   turso db create video-merger
   ```
3. **احصل على الرابط** (يوضع في `TURSO_DATABASE_URL`):
   ```bash
   turso db show video-merger --url
   # libsql://video-merger-<your-org>.turso.io
   ```
4. **أنشئ توكن** (يوضع في `TURSO_AUTH_TOKEN`):
   ```bash
   turso db tokens create video-merger
   ```
5. ضع القيمتين في `.env` محليًا — وفي Vercel كما في القسم التالي.

> مخطط الجداول يُنشأ تلقائيًا عند أول طلب (`CREATE TABLE IF NOT EXISTS`):
> `jobs` و `sources` و `source_chunks` و `output_chunks` — بمفاتيح أساسية مركبة.

---

## 4) النشر على Vercel خطوة بخطوة

1. ارفع المشروع إلى مستودع Git (تأكد أن `.env` موجود في `.gitignore` — لا ترفع أسرارًا أبدًا).
2. ادخل [vercel.com/new](https://vercel.com/new) واختر المستودع → **Import**.
3. Vercel سيكتشف تلقائيًا:
   - دوال `api/` بدون أي Build Step (Node.js خالص).
   - `vercel.json` يضبط `maxDuration: 300` لكل الدوال + Cron يومي على `/api/cron`.
   - ملفات `public/` تُخدم ثابتة في الجذر.
4. قبل الضغط على **Deploy** افتح **Environment Variables** وأضف (للـ Production و Preview):

   | المفتاح | القيمة |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://video-merger-<org>.turso.io` |
   | `TURSO_AUTH_TOKEN` | التوكن من `turso db tokens create` |

   والحدود اختيارية (بدونها تُستخدم الافتراضيات): `MAX_SOURCES`, `SOURCE_MAX_MB`, `OUTPUT_MAX_MB`, `MAX_TOTAL_DURATION_SEC`, `FFMPEG_PRESET`.

5. اضغط **Deploy** — بعد الانتهاء جرّب:
   ```bash
   curl https://<your-app>.vercel.app/api/config
   ```

> ملاحظة: `ffmpeg-static` و `ffprobe-static` تُثبَّت مع `npm install` تلقائيًا على Vercel،
> ودالة `ensureExecutable` تنسخ الثنائي إلى `/tmp` بصلاحية 755 عند فقدان صلاحية التنفيذ.

---

## 5) توثيق API

واجهة عامة: بدون تسجيل دخول، CORS مفتوح، والأخطاء دائمًا بصيغة `{"error":"..."}` برسائل عربية.

| الطريقة | النقطة | الوظيفة | أكواد الاستجابة |
|---|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج | `201` / `400` `413` `405` |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) | `200` / `400` `404` `409` `413` `405` |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن) | `200` / `202` `404` `409` `413` `405` |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال | `200` / `404` `405` |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range + `?download=1` | `200` `206` / `404` `409` `416` `405` |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل (batch واحد) | `200` / `404` `405` |
| `GET` | `/api/config` | الحدود العامة + version | `200` / `405` |
| `GET` | `/api/cron` | حذف المهام المنتهية الصلاحية | `200` / `405` |

### 5.1) إنشاء مهمة من روابط

```bash
curl -X POST https://<your-app>.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'
```

الاستجابة `201`:

```json
{
  "jobId": "a1b2c3d4e5f6…",
  "status": "queued",
  "statusUrl": "https://<your-app>.vercel.app/api/jobs/a1b2c3d4e5f6",
  "processUrl": "https://<your-app>.vercel.app/api/jobs/a1b2c3d4e5f6/process",
  "expiresAt": "2025-01-01T12:00:00.000Z"
}
```

### 5.2) إنشاء مهمة بملفات محلية

```bash
curl -X POST https://<your-app>.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"clip.mp4","size":1048576,"mime":"video/mp4"}]}'
```

الاستجابة `201` تضيف `uploads[]` و `uploadChunkBytes` عند وجود ملفات، والحالة تكون `uploading`:

```json
{
  "jobId": "…",
  "status": "uploading",
  "statusUrl": "…", "processUrl": "…", "expiresAt": "…",
  "uploads": [
    { "seq": 1, "uploadUrl": "https://…/api/upload?job=…&seq=1", "chunks": 1, "name": "clip.mp4", "size": 1048576 }
  ],
  "uploadChunkBytes": 4194304
}
```

### 5.3) رفع الملف على أجزاء (4MB لكل جزء)

```bash
# قسّم الملف إلى أجزاء 4MB ثم ارفعها بالترتيب (إعادة المحاولة ×3 مسؤولية العميل عند الفشل)
curl -X POST "https://<your-app>.vercel.app/api/upload?job=JOB_ID&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @part_aa
```

الاستجابة `200`:

```json
{ "ok": true, "jobId": "…", "seq": 1, "chunk": 0, "received": 4194304, "uploaded": 4194304,
  "chunks": { "stored": 1, "total": 1 }, "sourceComplete": true, "status": "queued" }
```

### 5.4) تنفيذ الدمج (متزامن)

```bash
curl -X POST https://<your-app>.vercel.app/api/jobs/JOB_ID/process
```

الاستجابة `200` مباشرة بعد انتهاء الدمج:

```json
{
  "status": "done",
  "videoUrl": "https://<your-app>.vercel.app/api/jobs/JOB_ID/video",
  "downloadUrl": "https://<your-app>.vercel.app/api/jobs/JOB_ID/video?download=1",
  "size": 5242880,
  "duration": 15.42,
  "resolution": "1280x720",
  "expiresAt": "…"
}
```

- `202` لو المهمة قيد المعالجة فعله (`{"status":"processing","progress":55,"statusUrl":"…"}`).
- `409` لو المهمة `done` مسبقًا أو أجزاء الملفات لم تكتمل.
- `413` لو تجاوزت المصادر أو الناتج حدود الحجم/المدة.
- عند الفشل تأخذ المهمة حالة `failed` وتظهر رسالة الخطأ في `GET /api/jobs/<id>` (يمكن إعادة `/process` للمحاولة مجددًا).

### 5.5) متابعة الحالة والتقدم

```bash
curl https://<your-app>.vercel.app/api/jobs/JOB_ID
```

```json
{ "jobId":"…","status":"done","progress":100,"createdAt":"…","expiresAt":"…","sources":2,
  "videoUrl":"…","downloadUrl":"…","size":5242880,"duration":15.42,"resolution":"1280x720" }
```

- حالات المهمة: `queued → (uploading) → processing → done | failed` مع عمود `progress`.
- تقدم الدمج: **0–40** سحب المصادر، **40–90** ترميز ffmpeg، **100** اكتمال.

### 5.6) بث الفيديو بدعم Range

```bash
# مدى محدد → 206 مع Content-Range (للتقديم/الترجيع في المشغل)
curl -H "Range: bytes=0-1023" -i https://<your-app>.vercel.app/api/jobs/JOB_ID/video

# تحميل مباشر
curl -o merged.mp4 "https://<your-app>.vercel.app/api/jobs/JOB_ID/video?download=1"
```

- `206` + `Content-Range: bytes 0-1023/<total>` — و `200` بلا ترويسة Range.
- `416` مع `Content-Range: bytes */<total>` لمدى خارج الحدود.
- القراءة من Turso تدفقًا بصفحات من 8 صفوف، مع تقليم أول/آخر جزء حسب المدى المطلوب.

### 5.7) حذف فوري شامل

```bash
curl -X DELETE https://<your-app>.vercel.app/api/jobs/JOB_ID
```

```json
{ "ok": true, "jobId": "JOB_ID", "message": "تم حذف المهمة وجميع بياناتها نهائيًا" }
```

يحذف `jobs + sources + source_chunks + output_chunks` في batch واحد. وبعد نجاح الدمج تُحذف `source_chunks` تلقائيًا — الناتج فقط هو المطلوب.

### 5.8) الحدود والـ Cron

```bash
curl https://<your-app>.vercel.app/api/config
curl https://<your-app>.vercel.app/api/cron   # تُستدعى يوميًا من vercel.json أيضًا
```

---

## 6) متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | — | رابط قاعدة Turso (`libsql://…`) |
| `TURSO_AUTH_TOKEN` | ✅ (للقواعد السحابية) | — | توكن قاعدة Turso |
| `MAX_SOURCES` | ❌ | `10` | أقصى عدد مصادر للمهمة |
| `SOURCE_MAX_MB` | ❌ | `200` | أقصى حجم لكل مصدر (يُفحص أثناء التنزيل بالبايتات) |
| `OUTPUT_MAX_MB` | ❌ | `150` | أقصى حجم للناتج بعد الترميز |
| `MAX_TOTAL_DURATION_SEC` | ❌ | `600` | أقصى مدة إجمالية لكل المصادر |
| `FFMPEG_PRESET` | ❌ | `medium` | preset ترميز libx264 (fast/medium/slow…) |

---

## 7) الحدود ومعالم الخطة المجانية

**حدود المشروع القابلة للضبط** (الأعلى): 10 مصادر، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مدة إجمالية، جزء رفع 4MB، صفوف تخزين 2MB.

**خطة Vercel Hobby (المجانية):**
- حجم الطلب الأقصى على دوال Serverless ≈ **4.5MB** — لذلك الرفع أجزاء 4MB.
- مدة الدالة: افتراضيًا 60 ثانية، ويمكن رفعها إلى **300 ثانية** (`maxDuration` مضبوط في `vercel.json`؛ القيمة القصوى تعتمد على الخطة وFluid Compute).
- لا نظام ملفات دائم — المشروع يستخدم `/tmp` فقط أثناء المعالجة وينظفه في `finally`.
- الذاكرة الافتراضية 1GB (ترميز الفيديوهات الكبيرة يحتاج وقتًا أطول).

**خطة Turso المجانية (تقريبية — راجع اللوحة):**
- حتى 500 قاعدة، تخزين إجمالي ≈ 5GB، قراءات ≈ مليار صف/شهر، كتابات ≈ 25 مليون صف/شهر.
- حد HTTP للقيمة الواحدة هو سبب تقسيم الـ Blobs إلى صفوف **2MB**.

> احسب: الناتج 150MB يعيش 24 ساعة فقط ثم يُحذف — الاستهلاك التراكمي محدود بطبيعة التصميم.

---

## 8) الاختبارات

```bash
# اختبار وحدات: توليد فيديوهين مختلفي الدقة → دمج → التحقق من الدقة/المدة/الصوت
# + تخزين Turso واسترجاع بتطابق sha256 + مسار الأجزاء + الحدود + الحذف الشامل
npm run test:unit

# اختبار HTTP كامل ضد الخادم المحلي 3001 (شغّل الخادم أولًا)
node server.js &
npm run test:http
```

سكربت HTTP يغطي: إنشاء من روابط → دمج → بث Range (206/416) → مهمة مختلطة (رابط + ملف مرفوع) → حذف → 404 → JSON تالف → قائمة فارغة → 405 → 409/202 → cron → CORS. وهو يفحص الروابط المرشحة أولًا ويستخدم أي روابط عامة تعمل فعليًا من بيئتك.

---

## 9) ملاحظات فنية

- **توحيد الدقة**: `scale` + `pad` إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080 وأبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p`، ثم `concat=n=:v=1:a=1`.
- **مصدر بلا صوت**: يُضاف مسار `anullsrc` صامت بنفس مدته بدل أن يفشل الدمج.
- **تقدم الترميز**: قراءة `out_time_us` من `-progress pipe:1` وحساب النسبة من المدة الإجمالية وتخزينها في القاعدة.
- **الأمان**: `.env` في `.gitignore` منذ البداية؛ لا توجد أسرار في أي ملف كود أو توثيق.
- **الاستئناف**: الواجهة تكتب `#job=<id>` في العنوان — بعد تحديث الصفحة تُستأنف النتيجة أو الاستطلاع تلقائيًا.
