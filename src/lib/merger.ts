// عميل خدمة دمج الفيديو — Video Merger API v2
// العنوان من MERGER_API_BASE — بلا مفاتيح أو توثيق
// المخرجات: MP4 (H.264 + AAC) حتى 1080p — لا توجد معاملات resolution/fps
// القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600s مجموع المدد، حذف تلقائي بعد 24 ساعة

export const MERGER_BASE = process.env.MERGER_API_BASE || "https://xxxxxxxx";

export interface MergerJobCreated {
  jobId: string;
  status: string;
  statusUrl?: string;
  processUrl?: string;
  expiresAt?: string;
}

export interface MergerJobStatus {
  status: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
  error?: string;
}

// كشف الأخطاء المعلنة من الخدمة vs أخطاء شبكتنا
export class MergerHttpError extends Error {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

// فحص الجهوزية: GET /api/config بمهلة 4 ثوانٍ
export async function mergerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${MERGER_BASE}/api/config`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    // نعتبرها جاهزة إذا ردت الحدود الأساسية
    return typeof body?.version === "string" || typeof body?.maxSources === "number";
  } catch {
    return false;
  }
}

// POST /api/jobs — إنشاء مهمة دمج
export async function mergerCreateJob(
  videos: string[]
): Promise<MergerJobCreated> {
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new MergerHttpError(`network error: ${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON */
  }
  if (!res.ok) {
    const msg = String(body?.error ?? `HTTP ${res.status}`);
    throw new MergerHttpError(msg, res.status);
  }
  const jobId = String(body?.jobId ?? "");
  if (!jobId) throw new MergerHttpError("لم تُعد خدمة الدمج معرّف مهمة");
  return {
    jobId,
    status: String(body?.status ?? "queued"),
    statusUrl: body?.statusUrl ? String(body.statusUrl) : undefined,
    processUrl: body?.processUrl ? String(body.processUrl) : undefined,
    expiresAt: body?.expiresAt ? String(body.expiresAt) : undefined,
  };
}

// POST /api/jobs/{jobId}/process — يستغرق ~10-15 ثانية (blocking)
// نجاح 200 → done payload؛ فشل → HTTP 500 + {"error": "..."} = فشل حتمي نهائي
export async function mergerProcessJob(jobId: string): Promise<{
  done: boolean;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
  error?: string;
  retryable?: boolean; // أخطاء شبكتنا نحن = مؤقتة
}> {
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(320_000),
    });
  } catch (e) {
    // timeout/fetch من عندنا → مؤقت (نستمر بالاستعلام)
    return { done: false, error: `network error: ${(e as Error).message}`, retryable: true };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* غير JSON */
  }
  if (res.status === 202) {
    // المهمة قيد المعالجة فعله — نعاملها كقائمة للاستعلام
    return { done: false };
  }
  if (!res.ok) {
    const msg = String(body?.error ?? `HTTP ${res.status}`);
    // أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل حتمي فوري — لا إعادة محاولة
    return { done: false, error: msg, retryable: false };
  }
  return {
    done: true,
    videoUrl: body?.videoUrl ? String(body.videoUrl) : undefined,
    downloadUrl: body?.downloadUrl ? String(body.downloadUrl) : undefined,
    size: typeof body?.size === "number" ? body.size : undefined,
    duration: typeof body?.duration === "number" ? body.duration : undefined,
    resolution: body?.resolution ? String(body.resolution) : undefined,
    expiresAt: body?.expiresAt ? String(body.expiresAt) : undefined,
  };
}

// تحليل الحالة دفاعيًا: أكمل/فشل/تقدم كسري 0..1 → ×100
function normalizeStatus(raw: string | undefined, hasError: boolean): MergerJobStatus["status"] {
  const s = (raw ?? "").toLowerCase();
  if (["done", "completed", "complete", "success", "succeeded", "finished"].includes(s))
    return "done";
  if (["error", "failed", "failure", "cancelled"].includes(s)) return "failed";
  if (hasError && !s) return "failed"; // قد يرد الجسم فيه error بدون حقل status → فشل فوري
  if (["queued", "uploading", "processing"].includes(s)) return "processing";
  return s ? "processing" : (hasError ? "failed" : "processing");
}

// GET /api/jobs/{jobId} — الحالة + التقدم + الرابط عند الاكتمال
export async function mergerGetJob(jobId: string): Promise<MergerJobStatus> {
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new MergerHttpError(`network error: ${(e as Error).message}`);
  }
  if (res.status === 404) {
    // مهمة غير موجودة (حُذفت أو انتهت صلاحيتها) — يعالجها المستدعي كفشل نهائي
    throw new MergerHttpError("مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)", 404);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* غير JSON */
  }
  if (!res.ok) {
    const msg = String(body?.error ?? `HTTP ${res.status}`);
    throw new MergerHttpError(msg, res.status);
  }

  const rawStatus = body?.status ? String(body.status) : undefined;
  const status = normalizeStatus(rawStatus, Boolean(body?.error));

  let progress = Number(body?.progress ?? 0);
  if (progress > 0 && progress <= 1) progress = Math.round(progress * 100); // كسر 0..1
  progress = Math.min(100, Math.max(0, Math.round(progress)));

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا والدمج تم فاضبط الرابط اليدوي
  let videoUrl = body?.videoUrl ? String(body.videoUrl) : undefined;
  const downloadUrl = body?.downloadUrl ? String(body.downloadUrl) : undefined;
  if (!videoUrl && !downloadUrl && status === "done") {
    videoUrl = `${MERGER_BASE}/api/jobs/${jobId}/video`;
  }

  return {
    status,
    progress: status === "done" ? 100 : progress,
    videoUrl,
    downloadUrl,
    size: typeof body?.size === "number" ? body.size : undefined,
    duration: typeof body?.duration === "number" ? body.duration : undefined,
    resolution: body?.resolution ? String(body.resolution) : undefined,
    expiresAt: body?.expiresAt ? String(body.expiresAt) : undefined,
    error: body?.error ? String(body.error) : undefined,
  };
}

// DELETE /api/jobs/{jobId} — حذف فوري (تنظيف اختياري)
export async function mergerDeleteJob(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// GET /api/jobs/{jobId}/video — يُرجع ملف MP4 مباشرةً (يدعم Range)
export function mergerVideoUrl(jobId: string): string {
  return `${MERGER_BASE}/api/jobs/${jobId}/video?download=1`;
}
