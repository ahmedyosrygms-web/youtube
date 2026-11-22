// محول CometAPI — المزود الثاني
// الصور: POST /v1/images/generations (متزامنة — بلا response_format، النقطة ترفضه) وترد b64_json
// الفيديو (Grok Imagine 1.5): POST /grok/v1/videos/generations ← request_id
//   ثم GET /grok/v1/videos/{request_id} ← pending/done/failed/expired والرابط في video.url
//   التوثيق الرسمي: apidoc.cometapi.com/api/video/xai/video-generation
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
        // CometAPI يرد b64_json افتراضيًا (دون url) — نحوّله لرابط data URI
        // كي يُخزَّن ك«رابط» في القاعدة ويعمل فورًا في المتصفح وعميل MCP
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
    // الفيديو عبر مسار xAI الرسمي لدى CometAPI: POST /grok/v1/videos/generations
    // JSON فقط: model + prompt + (image.url للصورة→فيديو) + duration/aspect_ratio/resolution
    const v = input as VideoInput;
    const body = await cometFetch(
      `${COMETAPI_BASE}/grok/v1/videos/generations`,
      key,
      {
        method: "POST",
        body: JSON.stringify({
          model,
          prompt: v.prompt,
          ...(v.image_url ? { image: { url: v.image_url } } : {}),
          ...(v.aspect_ratio && v.aspect_ratio !== "auto"
            ? { aspect_ratio: v.aspect_ratio }
            : {}),
          ...(v.resolution ? { resolution: v.resolution } : {}),
          ...(v.duration ? { duration: Math.round(v.duration) } : {}),
        }),
      }
    );
    const taskId =
      (body?.request_id as string) ??
      ((body?.data as Record<string, unknown>)?.request_id as string);
    if (!taskId) throw providerError("لم يُعد CometAPI معرّف مهمة (request_id)");
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult> {
    // GET /grok/v1/videos/{request_id} — الحالات: pending / done / failed / expired
    const body = await cometFetch(
      `${COMETAPI_BASE}/grok/v1/videos/${encodeURIComponent(providerTaskId)}`,
      key
    );
    const state = String(body?.status ?? "").toLowerCase();

    if (state === "done") {
      const video = (body?.video as Record<string, unknown>) ?? {};
      const url = typeof video.url === "string" ? video.url : "";
      if (!url) throw providerError("اكتملت المهمة لكن دون رابط فيديو (video.url)");
      return { status: "completed", urls: [url], progress: 100 };
    }

    if (state === "failed" || state === "expired") {
      const err = body?.error;
      const msg =
        state === "expired"
          ? "انتهت صلاحية المهمة لدى CometAPI"
          : typeof err === "string" && err
            ? err
            : err && typeof err === "object"
              ? String((err as Record<string, unknown>).message ?? JSON.stringify(err))
              : "فشل المزود دون تفاصيل";
      return { status: "failed", error: msg };
    }

    const progress =
      typeof body?.progress === "number" && body.progress > 0
        ? body.progress
        : state === "pending"
          ? 30
          : 10;
    return { status: "processing", progress };
  },
};
