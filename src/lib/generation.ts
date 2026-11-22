// منسّق التوليد — runGeneration + refreshTask
// القواعد الذهبية هنا:
// 1) ترتيب المفاتيح تسلسلي صارم بترتيب الإضافة — لا round-robin.
// 2) لا توقف عند نفاد رصيد: انتقال تلقائي للمفتاح التالي واستئناف نفس المهمة بنفس task_id.
// 3) نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا — التبديل صامت من وجهة نظره.
// 4) مهمة فشلت على كل المفاتيح تبقى processing وتُعاد محاولتها مع كل get_task (بتهدئة ~45 ثانية).
import { randomUUID } from "crypto";
import {
  insertTask,
  getTask,
  updateTask,
  getKeyPoolRaw,
  type ApiKeyRow,
  type TaskRow,
} from "./turso";
import {
  classifyProviderError,
  isKeyOrBalanceError,
  markKeyByClass,
  recordAttempt,
} from "./keys";
import { resolveModel, type ProviderId, type MediaType } from "./models";
import {
  providerError,
  type ProviderAdapter,
  type ImageInput,
  type VideoInput,
  type CheckTaskResult,
} from "./providers/types";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";
import { refreshMergeTask, processingMessage, failMessage } from "./merge";

const adapters: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toProviderError(e: unknown): { status?: number; message: string } {
  const err = e as { status?: number; message?: string };
  if (err?.message) return { status: err.status, message: String(err.message) };
  return { message: String(e) };
}

export interface GenNotify {
  (progress: number, message: string): Promise<void>;
}

export interface GenParams {
  prompt: string;
  model?: string;
  // صور
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  // فيديو
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  // مشترك
  wait_seconds?: number;
}

export interface GenResult {
  task: TaskRow | null;
  message: string;
  isError: boolean;
}

// تجربة إنشاء المهمة عبر المرشحين بالترتيب حتى أول نجاح
// startAfterKeyId: استئناف من المفتاح التالي بعد فشل في منتصف المهمة (بنفس task_id)
async function createAcrossPool(opts: {
  taskId: string;
  providers: ProviderId[];
  providerModelFor: (p: ProviderId) => string;
  input: ImageInput | VideoInput;
  mediaType: MediaType;
  startAfterKeyId?: string | null;
}): Promise<{ ok: boolean; provider?: ProviderId; providerTaskId?: string; key?: ApiKeyRow; syncUrls?: string[] }> {
  const pool = await getKeyPoolRaw(opts.providers);
  if (!pool.length) return { ok: false };

  // ترتيب تسلسلي: نبدأ بعد المفتاح الفاشل إن وُجد ثم نلتف للبداية
  let order = pool;
  if (opts.startAfterKeyId) {
    const idx = pool.findIndex((k) => k.id === opts.startAfterKeyId);
    if (idx >= 0) order = [...pool.slice(idx + 1), ...pool.slice(0, idx + 1)];
  }

  for (const key of order) {
    const provider = key.provider as ProviderId;
    const adapter = adapters[provider];
    if (!adapter) continue;
    const providerModel = opts.providerModelFor(provider);
    try {
      if (opts.mediaType === "image" && adapter.createImageSync) {
        // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
        const { urls } = await adapter.createImageSync(key, providerModel, opts.input as ImageInput);
        // نجاح → يُسجّل في عدّادات المفتاح وفي سجل محاولات المهمة أيضًا
        await updateTask(opts.taskId, {
          append_attempt: await recordAttempt({ key, ok: true }),
        });
        return { ok: true, provider, key, syncUrls: urls };
      }
      const { providerTaskId } = await adapter.createTask(key, providerModel, opts.input);
      // نجاح → يُسجّل في عدّادات المفتاح وفي سجل محاولات المهمة أيضًا
      await updateTask(opts.taskId, {
        append_attempt: await recordAttempt({ key, ok: true }),
      });
      return { ok: true, provider, providerTaskId, key };
    } catch (e) {
      const pe = toProviderError(e);
      const errorClass = classifyProviderError(pe);
      const attempt = await recordAttempt({
        key,
        ok: false,
        errorClass,
        error: pe.message,
      });
      await updateTask(opts.taskId, { append_attempt: attempt });
      await markKeyByClass(key, errorClass, pe.message);
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي
      // params → توقف فورًا: تبديل المفاتيح لن يحل خطأ معطيات
      if (errorClass === "params") {
        throw providerError(pe.message, pe.status);
      }
      continue;
    }
  }
  return { ok: false };
}

// استطلاع المزود حتى الاكتمال أو انتهاء نافذة الانتظار مع بث التقدم
async function pollUntilDone(opts: {
  task: TaskRow;
  provider: ProviderId;
  providerTaskId: string;
  key: ApiKeyRow;
  waitSeconds: number;
  input: ImageInput | VideoInput;
  modelDef: ReturnType<typeof resolveModel> extends infer R ? (R extends { model: infer M } ? M : never) : never;
  notify?: GenNotify;
}): Promise<GenResult> {
  const { task, provider, providerTaskId, waitSeconds } = opts;
  const deadline = Date.now() + waitSeconds * 1000;
  let currentKey = opts.key;
  let currentProviderTaskId = providerTaskId;

  while (Date.now() < deadline) {
    await sleep(3_000);
    let check: CheckTaskResult;
    try {
      check = await adapters[provider].checkTask(currentKey, currentProviderTaskId);
    } catch (e) {
      const pe = toProviderError(e);
      // استعلام الحالة فشل — إن كان خطأ مفتاح/رصيد نعيد الإنشاء على المفتاح التالي
      if (isKeyOrBalanceError(pe.message)) {
        const retried = await recreateOnNextKey(opts.task, opts.modelDef, opts.input, currentKey.id);
        if (retried.ok) {
          currentProviderTaskId = retried.providerTaskId!;
          currentKey = retried.key!;
          continue;
        }
        // لا مفتاح متاح الآن — تبقى المهمة processing وتُعاد مع get_task
        return {
          task: await getTask(task.id),
          message: processingMessage(task.id),
          isError: false,
        };
      }
      // مؤقت (شبكة/429/5xx) → استمر بالاستعلام
      continue;
    }

    if (check.status === "completed" && check.urls?.length) {
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(check.urls),
      });
      return {
        task: await getTask(task.id),
        message: completedMessage(task.type, check.urls),
        isError: false,
      };
    }

    if (check.status === "failed") {
      const reason = check.error ?? "فشل المزود دون تفاصيل";
      // فشل منتصف المهمة بسبب مفتاح/رصيد → أعد الإنشاء بنفس task_id على المفتاح التالي
      if (isKeyOrBalanceError(reason)) {
        const retried = await recreateOnNextKey(opts.task, opts.modelDef, opts.input, currentKey.id);
        if (retried.ok) {
          currentProviderTaskId = retried.providerTaskId!;
          currentKey = retried.key!;
          continue;
        }
        await updateTask(task.id, { status: "processing", progress: 5 });
        return {
          task: await getTask(task.id),
          message: processingMessage(task.id),
          isError: false,
        };
      }
      // فشل حقيقي (انتهاك سياسة/معطيات) → failed مع السبب الآمن
      await updateTask(task.id, { status: "failed", error_message: reason });
      return {
        task: await getTask(task.id),
        message: failMessage(reason),
        isError: true,
      };
    }

    // جارية — حدّث التقدم وابث إشعارًا كل ~3 ثوانٍ
    const progress = Math.min(95, Math.max(5, check.progress ?? 30));
    await updateTask(task.id, { progress });
    if (opts.notify) {
      await opts.notify(progress, `قيد التوليد… ${progress}%`);
    }
  }

  // انتهت النافذة والنتيجة لم تظهر → أعد المهمة بحالة processing مع task_id
  return { task: await getTask(task.id), message: processingMessage(task.id), isError: false };
}

// إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي (تبديل صامت)
async function recreateOnNextKey(
  task: TaskRow,
  modelDef: NonNullable<ReturnType<typeof resolveModel>>["model"],
  input: ImageInput | VideoInput,
  failedKeyId: string | null
): Promise<{ ok: boolean; providerTaskId?: string; key?: ApiKeyRow }> {
  const retried = await createAcrossPool({
    taskId: task.id,
    providers: modelDef.providers,
    providerModelFor: (p) => modelDef.providerModel[p],
    input,
    mediaType: modelDef.type,
    startAfterKeyId: failedKeyId,
  });
  if (!retried.ok) return { ok: false };

  await updateTask(task.id, {
    provider: retried.provider,
    provider_task_id: retried.providerTaskId ?? null,
    key_id: retried.key?.id ?? null,
    progress: 10,
    error_message: null,
  });
  return { ok: true, providerTaskId: retried.providerTaskId, key: retried.key };
}

// صياغة رسالة الاكتمال حسب النوع
function completedMessage(type: MediaType, urls: string[]): string {
  if (type === "image") {
    const u = urls[0];
    return `✅ تم توليد الصورة بنجاح\n\n![image](${u})\n\nالرابط المباشر: ${u}`;
  }
  const list = urls.map((u) => `- ${u}`).join("\n");
  return `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${list}`;
}

// تدفق التوليد لأداة generate_image / generate_video
export async function runGeneration(
  mediaType: MediaType,
  params: GenParams,
  notify?: GenNotify
): Promise<GenResult> {
  // 1) وحّد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري
  const resolved = params.model ? resolveModel(params.model) : null;
  if (params.model && !resolved) {
    const available = resolveModel(mediaType === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview");
    return {
      task: null,
      message: `❌ موديل غير معروف: ${params.model}. الموديلات المتاحة: ${available?.model.canonical}`,
      isError: true,
    };
  }
  const modelDef = resolved?.model ?? resolveModel(mediaType === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview")!.model;
  if (modelDef.type !== mediaType) {
    return {
      task: null,
      message: `❌ الموديل ${modelDef.canonical} مخصص لتوليد ${modelDef.type === "image" ? "الصور" : "الفيديو"} وليس ${mediaType === "image" ? "الصور" : "الفيديو"}.`,
      isError: true,
    };
  }

  // 2) جلب المفتاح بالترتيب الصارم — فارغ → رد no_keys
  const pool = await getKeyPoolRaw(modelDef.providers);
  if (!pool.length) {
    return {
      task: null,
      message: `❌ لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
      isError: true,
    };
  }

  const waitSeconds = Math.min(240, Math.max(0, params.wait_seconds ?? (mediaType === "image" ? 90 : 25)));

  // بناء معطيات الإدخال لكل مزود
  const input: ImageInput | VideoInput =
    mediaType === "image"
      ? {
          prompt: params.prompt,
          ...(params.aspect_ratio && params.aspect_ratio !== "auto" ? { aspect_ratio: params.aspect_ratio } : {}),
          ...(params.resolution ? { resolution: params.resolution } : {}),
          ...(params.background && params.background !== "auto" ? { background: params.background } : {}),
          ...(params.output_format ? { output_format: params.output_format } : {}),
        }
      : {
          prompt: params.prompt,
          ...(params.image_url ? { image_url: params.image_url } : {}),
          ...(params.aspect_ratio && params.aspect_ratio !== "auto" ? { aspect_ratio: params.aspect_ratio } : {}),
          ...(params.resolution ? { resolution: params.resolution } : {}),
          ...(params.enable_audio !== undefined ? { enable_audio: params.enable_audio } : {}),
          ...(params.duration ? { duration: params.duration } : {}),
        };

  const paramsJson = JSON.stringify({ ...params, prompt: params.prompt });
  const taskId = randomUUID();

  // 3) سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  await insertTask({
    id: taskId,
    model: modelDef.canonical,
    type: mediaType,
    prompt: params.prompt,
    params_json: paramsJson,
    status: "processing",
    progress: 0,
  });

  // 4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  let created: Awaited<ReturnType<typeof createAcrossPool>>;
  try {
    created = await createAcrossPool({
      taskId,
      providers: modelDef.providers,
      providerModelFor: (p) => modelDef.providerModel[p],
      input,
      mediaType,
    });
  } catch (e) {
    // خطأ معطيات (params) — توقف فورًا مع سبب آمن
    const pe = toProviderError(e);
    await updateTask(taskId, { status: "failed", error_message: pe.message });
    return { task: await getTask(taskId), message: failMessage(pe.message), isError: true };
  }

  if (!created.ok) {
    // فشل الإنشاء على كل المفاتيح → تبقى processing برسالة داخلية، وتُعاد مع كل get_task
    await updateTask(taskId, {
      status: "processing",
      progress: 0,
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    return { task: await getTask(taskId), message: processingMessage(taskId), isError: false };
  }

  // صور متزامنة (CometAPI) → اكتملت فورًا
  if (created.syncUrls?.length) {
    await updateTask(taskId, {
      provider: created.provider,
      key_id: created.key?.id ?? null,
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify(created.syncUrls),
    });
    return {
      task: await getTask(taskId),
      message: completedMessage(mediaType, created.syncUrls),
      isError: false,
    };
  }

  // مهمة غير متزامنة → اربط المزود والمفتاح واستطلع حتى الاكتمال أو انتهاء النافذة
  await updateTask(taskId, {
    provider: created.provider,
    provider_task_id: created.providerTaskId ?? null,
    key_id: created.key?.id ?? null,
    progress: 10,
  });
  const task = (await getTask(taskId))!;
  return pollUntilDone({
    task,
    provider: created.provider as ProviderId,
    providerTaskId: created.providerTaskId!,
    key: created.key!,
    waitSeconds,
    input,
    modelDef,
    notify,
  });
}

// refreshTask — يُستدعى من get_task: المهمة الجارية تُحدَّث حية من المزود/خدمة الدمج
export async function refreshTask(taskId: string): Promise<GenResult> {
  const task = await getTask(taskId);
  if (!task) {
    return { task: null, message: `❌ لم تُوجد مهمة بالمعرّف: ${taskId}`, isError: true };
  }

  if (task.status === "completed" && task.result_urls_json) {
    const urls = JSON.parse(task.result_urls_json) as string[];
    return { task, message: completedMessage(task.type, urls), isError: false };
  }
  if (task.status === "failed") {
    return { task, message: failMessage(task.error_message ?? "سبب غير معروف"), isError: true };
  }
  if (task.type === "merge") {
    return refreshMergeTask(task);
  }

  // مهمة توليد جارية
  const modelResolved = resolveModel(task.model);
  const modelDef = modelResolved?.model ?? resolveModel(task.type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview")!.model;
  const params = JSON.parse(task.params_json || "{}") as GenParams;
  const input: ImageInput | VideoInput =
    task.type === "image"
      ? {
          prompt: params.prompt,
          ...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}),
          ...(params.resolution ? { resolution: params.resolution } : {}),
          ...(params.background ? { background: params.background } : {}),
          ...(params.output_format ? { output_format: params.output_format } : {}),
        }
      : {
          prompt: params.prompt,
          ...(params.image_url ? { image_url: params.image_url } : {}),
          ...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}),
          ...(params.resolution ? { resolution: params.resolution } : {}),
          ...(params.enable_audio !== undefined ? { enable_audio: params.enable_audio } : {}),
          ...(params.duration ? { duration: params.duration } : {}),
        };

  // بلا معرّف مزود → فشل إنشاء سابق على كل المفاتيح → أعد المحاولة بتهدئة ~45 ثانية
  if (!task.provider_task_id) {
    const attempts = JSON.parse(task.attempts_json || "[]") as { at: string }[];
    const lastAt = attempts.length ? new Date(attempts[attempts.length - 1].at).getTime() : 0;
    if (Date.now() - lastAt < 45_000) {
      // فترة تهدئة حتى لا نضغط المزودين
      return { task, message: processingMessage(task.id), isError: false };
    }
    const retried = await createAcrossPool({
      taskId: task.id,
      providers: modelDef.providers,
      providerModelFor: (p) => modelDef.providerModel[p],
      input,
      mediaType: modelDef.type,
    });
    if (!retried.ok) {
      await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
      return { task: await getTask(task.id), message: processingMessage(task.id), isError: false };
    }
    if (retried.syncUrls?.length) {
      await updateTask(task.id, {
        provider: retried.provider,
        key_id: retried.key?.id ?? null,
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(retried.syncUrls),
      });
      return {
        task: await getTask(task.id),
        message: completedMessage(task.type, retried.syncUrls),
        isError: false,
      };
    }
    await updateTask(task.id, {
      provider: retried.provider,
      provider_task_id: retried.providerTaskId ?? null,
      key_id: retried.key?.id ?? null,
      progress: 10,
      error_message: null,
    });
    return { task: await getTask(task.id), message: processingMessage(task.id), isError: false };
  }

  // معرّف مزود موجود → استعلم الحالة حية
  const provider = (task.provider as ProviderId) ?? "kie";
  // المفتاح المستخدم للفحص: آخر مفتاح للمهمة إن كان لا يزال نشطًا وإلا أي مفتاح نشط لنفس المزود
  let checkKey: ApiKeyRow | null = null;
  const pool = await getKeyPoolRaw([provider]);
  checkKey = pool.find((k) => k.id === task.key_id) ?? pool[0] ?? null;
  if (!checkKey) {
    // لا مفاتيح نشطة لهذا المزود — جرّب إعادة الإنشاء عبر كل المزودات
    const retried = await recreateOnNextKey(task, modelDef, input, task.key_id);
    if (!retried.ok) {
      return { task, message: processingMessage(task.id), isError: false };
    }
    return { task: await getTask(task.id), message: processingMessage(task.id), isError: false };
  }

  let check: CheckTaskResult;
  try {
    check = await adapters[provider].checkTask(checkKey, task.provider_task_id);
  } catch (e) {
    const pe = toProviderError(e);
    if (isKeyOrBalanceError(pe.message)) {
      // تبديل صامت: أعد الإنشاء على المفتاح التالي بنفس task_id
      const retried = await recreateOnNextKey(task, modelDef, input, task.key_id);
      if (!retried.ok) {
        await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
      }
      return { task: await getTask(task.id), message: processingMessage(task.id), isError: false };
    }
    // مؤقت — تبقى قيد المعالجة
    return { task, message: processingMessage(task.id), isError: false };
  }

  if (check.status === "completed" && check.urls?.length) {
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify(check.urls),
    });
    return {
      task: await getTask(task.id),
      message: completedMessage(task.type, check.urls),
      isError: false,
    };
  }

  if (check.status === "failed") {
    const reason = check.error ?? "فشل المزود دون تفاصيل";
    if (isKeyOrBalanceError(reason)) {
      const retried = await recreateOnNextKey(task, modelDef, input, task.key_id);
      if (!retried.ok) {
        await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
      }
      return { task: await getTask(task.id), message: processingMessage(task.id), isError: false };
    }
    await updateTask(task.id, { status: "failed", error_message: reason });
    return { task: await getTask(task.id), message: failMessage(reason), isError: true };
  }

  // جارية — حدّث التقدم
  const progress = Math.min(95, Math.max(5, check.progress ?? task.progress));
  await updateTask(task.id, { progress });
  return { task: await getTask(task.id), message: processingMessage(task.id), isError: false };
}
