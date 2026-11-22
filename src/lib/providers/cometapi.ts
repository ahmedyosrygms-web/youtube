// محول CometAPI — المزود الثاني
// الصور: نقطة متوافقة مع OpenAI تعيد الرابط/b64_json فورًا (متزامنة)
// الفيديو: نقطة مهام غير متزامنة بنفس نمط create/check — اتبع توثيق api.cometapi.com الحالي عند أي تغيير
import {
  providerError,
  type ProviderAdapter,
  type ProviderKey,
  type CheckTaskResult,
  type ImageInput,
  type VideoInput,
} from "./types";

const COMETAPI_BASE = process.env.COMETAPI_BASE || "https://api.cometapi.com";

async function cometFetch(
  url: string,
  key: ProviderKey,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw providerError(`network error: ${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON */
  }
  if (!res.ok) {
    const msg =
      (body?.error as Record<string, unknown>)?.message
      ? String((body?.error as Record<string, unknown>).message)
      : ((body?.message as string) || (body?.msg as string) || `HTTP ${res.status}`);
    throw providerError(String(msg), res.status);
  }
  return body;
}

export const cometapiAdapter: ProviderAdapter = {
  // الصور متزامنة لدى CometAPI — تعيد النتيجة فورًا
  async createImageSync(key: ProviderKey, model: string, input: ImageInput): Promise<{ urls: string[] }> {
    const body = await cometFetch(`${COMETAPI_BASE}/v1/images/generations`, key, {
      method: "POST",
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        size: input.resolution === "4K" ? "2048x2048" : input.resolution === "2K" ? "1024x1024" : "1024x1024",
        response_format: "url",
        ...(input.aspect_ratio && input.aspect_ratio !== "auto"
          ? { aspect_ratio: input.aspect_ratio }
          : {}),
        ...(input.background && input.background !== "auto"
          ? { background: input.background }
          : {}),
        ...(input.output_format ? { output_format: input.output_format } : {}),
      }),
    });
    const items = (body?.data as Array<Record<string, unknown>>) ?? [];
    const urls: string[] = [];
    for (const it of items) {
      if (typeof it?.url === "string" && it.url) urls.push(it.url);
      else if (typeof it?.b64_json === "string" && it.b64_json) {
        // b64_json: لا ننزّل شيئًا على سيرفرنا — لكن يجب إعطاء رابط؛
        // CometAPI الافتراضي يرد url، فإذا رد b64 فقط نعتبره نجاحًا برابط data URI
        urls.push(`data:image/png;base64,${it.b64_json}`);
      }
    }
    if (!urls.length) throw providerError("CometAPI لم يعد روابط صور");
    return { urls };
  },

  async createTask(
    key: ProviderKey,
    model: string,
    input: ImageInput | VideoInput
  ): Promise<{ providerTaskId: string }> {
    // الفيديو عبر نقطة المهام غير المتزامنة بنفس نمط create/check
    const body = await cometFetch(`${COMETAPI_BASE}/v1/jobs/createTask`, key, {
      method: "POST",
      body: JSON.stringify({ model, input }),
    });
    const data = (body?.data as Record<string, unknown>) ?? (body as Record<string, unknown>);
    const taskId =
      (data?.taskId as string) ?? (data?.task_id as string) ?? (data?.id as string);
    if (!taskId) throw providerError("لم يُعد CometAPI معرّف مهمة");
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult> {
    const body = await cometFetch(
      `${COMETAPI_BASE}/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      key
    );
    const data = (body?.data as Record<string, unknown>) ?? {};
    const state = String(
      data.state ?? data.status ?? "processing"
    ).toLowerCase();

    if (["success", "completed", "succeeded"].includes(state)) {
      let urls: string[] = [];
      // resultJson قد يرد نص JSON داخل JSON مثل kie، أو مصفوفة مباشرة
      const raw = data.resultJson ?? data.resultUrls;
      try {
        const inner =
          typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
        urls = Array.isArray(inner?.resultUrls)
          ? inner.resultUrls.map((u: unknown) => String(u))
          : Array.isArray(inner?.urls)
            ? inner.urls.map((u: unknown) => String(u))
            : [];
      } catch {
        urls = [];
      }
      if (!urls.length) throw providerError("نجحت المهمة لكن دون روابط نتائج");
      return { status: "completed", urls, progress: 100 };
    }

    if (["fail", "failed", "error"].includes(state)) {
      return {
        status: "failed",
        error: String(data.failMsg ?? data.error ?? "فشل المزود دون تفاصيل"),
      };
    }

    const progress = state === "generating" ? 55 : state === "queuing" ? 20 : 10;
    return { status: "processing", progress };
  },
};
