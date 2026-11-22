// منسّق دمج الفيديو — runMerge + refreshMergeTask
// قاعدة حتمية: أي خطأ HTTP معلن من خدمة الدمج (4xx/5xx بجسم error) = فشل نهائي فوري
// أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
import { randomUUID } from "crypto";
import { insertTask, getTask, updateTask, type TaskRow } from "./turso";
import {
  mergerCreateJob,
  mergerProcessJob,
  mergerGetJob,
  mergerVideoUrl,
  MergerHttpError,
  type MergerJobStatus,
} from "./merger";

// قفل في الذاكرة حتى لا يتزامن استدعاء process مع get_task على نفس المهمة
const processInFlight: Set<string> = new Set();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MergeParams {
  urls?: string[];
  task_ids?: string[];
  wait_seconds?: number;
}

export interface MergeNotify {
  (progress: number, message: string): Promise<void>;
}

export interface MergeResult {
  // قد تكون null إن تعذّت إعادة قراءة الصف — الرسالة تحمل المعلومة كاملة
  task: TaskRow | null;
  message: string;
  isError: boolean;
}

// تحقق صارم: ≥2 وكلها http/https مباشرة وعامة؛ >10 → رفض
function validateUrls(urls: string[]): { ok: boolean; error?: string } {
  if (urls.length > 10) {
    return {
      ok: false,
      error: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    };
  }
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          ok: false,
          error: `❌ الرابط يجب أن يكون رابط فيديو مباشر عام (http/https): ${u}`,
        };
      }
    } catch {
      return { ok: false, error: `❌ رابط غير صالح: ${u}` };
    }
  }
  return { ok: true };
}

// ترتيب المصادر: روابط task_ids أُولًا ثم urls المباشرة بنفس ترتيبها
async function resolveMergeSources(params: MergeParams): Promise<{
  urls: string[];
  error?: string;
  failedDetails?: string[];
}> {
  const urls: string[] = [];
  const failedDetails: string[] = [];

  if (params.task_ids?.length) {
    for (const tid of params.task_ids) {
      const t = await getTask(tid);
      if (!t) {
        failedDetails.push(`${tid}: مهمة غير موجودة`);
        continue;
      }
      if (t.type !== "video") {
        failedDetails.push(`${tid}: النوع ${t.type} وليس فيديو`);
        continue;
      }
      if (t.status !== "completed" || !t.result_urls_json) {
        failedDetails.push(`${tid}: الحالة ${t.status} — يجب أن تكون مكتملة بروابط`);
        continue;
      }
      try {
        const tUrls = JSON.parse(t.result_urls_json) as string[];
        if (tUrls.length) urls.push(tUrls[0]);
      } catch {
        failedDetails.push(`${tid}: روابط نتيجة غير صالحة`);
      }
    }
  }

  if (params.urls?.length) {
    for (const u of params.urls) urls.push(u);
  }

  const uniq = Array.from(new Set(urls));
  if (uniq.length < 2) {
    const detail = failedDetails.length
      ? "\n\nتفاصيل المعرّفات الفاشلة:\n" + failedDetails.map((d) => `- ${d}`).join("\n")
      : "";
    return {
      urls: uniq,
      error:
        "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." +
        detail,
      failedDetails,
    };
  }
  const check = validateUrls(uniq);
  if (!check.ok) return { urls: uniq, error: check.error, failedDetails };
  return { urls: uniq };
}

// تدفق runMerge: تسجيل المهمة أولًا → POST jobs → process خلفيًا مرة واحدة → استعلام بالتقدم
export async function runMerge(
  params: MergeParams,
  notify?: MergeNotify
): Promise<MergeResult> {
  const resolved = await resolveMergeSources(params);
  if (resolved.error) {
    return {
      task: null as unknown as TaskRow,
      message: resolved.error,
      isError: true,
    };
  }
  const urls = resolved.urls;
  const waitSeconds = Math.min(240, Math.max(0, params.wait_seconds ?? 60));

  const taskId = randomUUID();
  // سجّل مهمة type="merge" provider="merger" model="video-merger" في Turso أولًا
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: "",
    params_json: JSON.stringify({ urls, wait_seconds: waitSeconds }),
    status: "processing",
    progress: 0,
  });

  let jobId: string;
  try {
    const created = await mergerCreateJob(urls);
    jobId = created.jobId;
    await updateTask(taskId, {
      provider_task_id: jobId,
      progress: 5,
    });
  } catch (e) {
    const err = e as MergerHttpError;
    if (err instanceof MergerHttpError && err.httpStatus) {
      // خطأ معلن من الخدمة عند الإنشاء → فشل نهائي
      await updateTask(taskId, { status: "failed", error_message: err.message });
      return {
        task: await getTask(taskId),
        message: `❌ فشلت المهمة: تعذر إنشاء مهمة الدمج — ${err.message}`,
        isError: true,
      };
    }
    // خطأ شبكة عند الإنشاء → نترك المهمة قيد المعالجة ونحاول مع get_task
    return {
      task: await getTask(taskId),
      message: processingMessage(taskId),
      isError: false,
    };
  }

  // أطلق خلفيًا وبمرة واحدة فقط POST .../process (محمي بقفل في الذاكرة)
  fireProcessOnce(jobId);

  // حتى نهاية نافذة الانتظار: استعلام GET /api/jobs/{id} كل 3 ثوانٍ مع بث تقدم
  const deadline = Date.now() + waitSeconds * 1000;
  let finalStatus: MergerJobStatus | null = null;

  while (Date.now() < deadline) {
    await sleep(3_000);
    let st: MergerJobStatus;
    try {
      st = await mergerGetJob(jobId);
    } catch (e) {
      const err = e as MergerHttpError;
      if (err instanceof MergerHttpError && err.httpStatus === 404) {
        await updateTask(taskId, { status: "failed", error_message: err.message });
        return { task: await getTask(taskId), message: failMessage(err.message), isError: true };
      }
      if (err instanceof MergerHttpError && err.httpStatus) {
        // خطأ معلن = فشل نهائي
        await updateTask(taskId, { status: "failed", error_message: err.message });
        return { task: await getTask(taskId), message: failMessage(err.message), isError: true };
      }
      // خطأ شبكة = مؤقت → استمر بالاستعلام حتى انتهاء النافذة
      continue;
    }

    // تحديث الحالة يُكتب في Turso فورًا كل مرة
    await updateTask(taskId, {
      progress: st.progress || (finalStatus ? 100 : 10),
      result_urls_json:
        st.status === "done"
          ? JSON.stringify([st.videoUrl ?? st.downloadUrl ?? mergerVideoUrl(jobId)])
          : undefined,
    });
    if (notify) await notify(st.progress, `جارٍ دمج المقاطع… ${st.progress}%`);

    if (st.status === "done") {
      finalStatus = st;
      break;
    }
    if (st.status === "failed") {
      // فشل معلن من الخدمة → فشل نهائي
      await updateTask(taskId, { status: "failed", error_message: st.error ?? "فشل الدمج" });
      return { task: await getTask(taskId), message: failMessage(st.error ?? "فشل الدمج"), isError: true };
    }
  }

  if (finalStatus) {
    const urlsOut = [finalStatus.videoUrl ?? finalStatus.downloadUrl ?? mergerVideoUrl(jobId)];
    await updateTask(taskId, {
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify(urlsOut),
    });
    return { task: await getTask(taskId), message: completedMergeMessage(urlsOut), isError: false };
  }

  // انتهت النافذة والنتيجة لم تظهر → أعد المهمة بحالة processing مع task_id
  return { task: await getTask(taskId), message: processingMessage(taskId), isError: false };
}

// تنفيذ process مرة واحدة فقط لكل jobId (قفل في الذاكرة)
function fireProcessOnce(jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  mergerProcessJob(jobId)
    .then(async () => {
      processInFlight.delete(jobId);
    })
    .catch(() => {
      processInFlight.delete(jobId);
    });
}

// refreshMergeTask — get_task لمهمة دمج: حدّث من GET /api/jobs/{id}
export async function refreshMergeTask(task: TaskRow): Promise<MergeResult> {
  const jobId = task.provider_task_id;

  // مهمة بلا معرّف خدمة (فشل الإنشاء سابقًا أو خطأ شبكة) → أعد المحاولة كاملة
  if (!jobId) {
    try {
      const params = JSON.parse(task.params_json || "{}") as MergeParams;
      const resolved = await resolveMergeSources(params);
      if (resolved.error || resolved.urls.length < 2) {
        await updateTask(task.id, { status: "failed", error_message: "مصادر الدمج غير صالحة" });
        return { task, message: failMessage("مصادر الدمج غير صالحة"), isError: true };
      }
      const created = await mergerCreateJob(resolved.urls);
      await updateTask(task.id, { provider_task_id: created.jobId, progress: 5 });
      fireProcessOnce(created.jobId);
      return { task: await getTask(task.id), message: processingMessage(task.id), isError: false };
    } catch (e) {
      const err = e as MergerHttpError;
      if (err instanceof MergerHttpError && err.httpStatus) {
        await updateTask(task.id, { status: "failed", error_message: err.message });
        return { task, message: failMessage(err.message), isError: true };
      }
      return { task, message: processingMessage(task.id), isError: false };
    }
  }

  // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (مع القفل)
  fireProcessOnce(jobId);

  let st: MergerJobStatus;
  try {
    st = await mergerGetJob(jobId);
  } catch (e) {
    const err = e as MergerHttpError;
    if (err instanceof MergerHttpError && err.httpStatus === 404) {
      await updateTask(task.id, { status: "failed", error_message: err.message });
      return { task, message: failMessage(err.message), isError: true };
    }
    if (err instanceof MergerHttpError && err.httpStatus) {
      await updateTask(task.id, { status: "failed", error_message: err.message });
      return { task, message: failMessage(err.message), isError: true };
    }
    // خطأ شبكة → تظل قيد المعالجة
    return { task, message: processingMessage(task.id), isError: false };
  }

  if (st.status === "done") {
    const urlsOut = [st.videoUrl ?? st.downloadUrl ?? mergerVideoUrl(jobId)];
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify(urlsOut),
    });
    // نجلب الصف المحدَّث مع احتياط الصف الحالي إن فشلت القراءة (تفادي null)
    return {
      task: (await getTask(task.id)) ?? task,
      message: completedMergeMessage(urlsOut),
      isError: false,
    };
  }
  if (st.status === "failed") {
    await updateTask(task.id, { status: "failed", error_message: st.error ?? "فشل الدمج" });
    return { task, message: failMessage(st.error ?? "فشل الدمج"), isError: true };
  }

  await updateTask(task.id, { progress: st.progress });
  return { task: (await getTask(task.id)) ?? task, message: processingMessage(task.id), isError: false };
}

// ============ صياغة الردود العربية ============

export function processingMessage(taskId: string): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function failMessage(reason: string): string {
  // ملاحظة: لا يُذكر أبدًا خطأ مفتاح أو رصيد هنا — استدعيها فقط لرسائل آمنة للعميل
  return `❌ فشلت المهمة: ${reason}`;
}

export function completedMergeMessage(urls: string[]): string {
  const list = urls.map((u) => `- ${u}`).join("\n");
  return (
    `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر:\n${list}\n\n` +
    `⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`
  );
}
