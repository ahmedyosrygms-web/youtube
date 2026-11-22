// محول kie.ai — Jobs API الموحد (المزود الأساسي)
// التوثيق: docs.kie.ai — POST createTask ثم GET recordInfo
// انتبه: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا
import {
  providerError,
  type ProviderAdapter,
  type ProviderKey,
  type CheckTaskResult,
  type ImageInput,
  type VideoInput,
} from "./types";

const KIE_BASE = "https://api.kie.ai/api/v1/jobs";

// نداء fetch موحد يحول أي فشل إلى ProviderError مع الحالة
async function kieFetch(
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
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // انقطاع شبكة/timeout → مؤقت
    throw providerError(`network error: ${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* جسم غير JSON — نعتمد على الحالة */
  }
  if (!res.ok) {
    const msg =
      (body?.msg as string) || (body?.message as string) || `HTTP ${res.status}`;
    throw providerError(String(msg), res.status);
  }
  // بعض أخطاء kie.ai ترد بحالة 200 لكن code != 200
  const code = Number(body?.code ?? 200);
  if (code !== 200) {
    throw providerError(String((body?.msg as string) || `kie code ${code}`), code === 200 ? res.status : code);
  }
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(
    key: ProviderKey,
    model: string,
    input: ImageInput | VideoInput
  ): Promise<{ providerTaskId: string }> {
    const body = await kieFetch(`${KIE_BASE}/createTask`, key, {
      method: "POST",
      body: JSON.stringify({ model, input }),
    });
    const data = body?.data as Record<string, unknown> | undefined;
    const taskId = data?.taskId as string | undefined;
    if (!taskId) throw providerError("لم يُعد kie.ai معرّف مهمة");
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult> {
    const body = await kieFetch(
      `${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      key
    );
    const data = body?.data as Record<string, unknown> | undefined;
    if (!data) throw providerError("استجابة recordInfo بلا بيانات");

    const state = String(data.state ?? "waiting");
    const failMsg = data.failMsg ? String(data.failMsg) : undefined;

    // حالات النجاح: success — حالات الانتظار: waiting/queuing/generating
    if (state === "success") {
      // resultJson نص JSON داخل JSON → parse ثانٍ
      let urls: string[] = [];
      try {
        const inner = JSON.parse(String(data.resultJson ?? "{}"));
        urls = Array.isArray(inner?.resultUrls)
          ? inner.resultUrls.map((u: unknown) => String(u))
          : [];
      } catch {
        urls = [];
      }
      if (!urls.length) throw providerError("نجحت المهمة لكن دون روابط نتائج");
      return { status: "completed", urls, progress: 100 };
    }

    if (state === "fail" || state === "failed") {
      return { status: "failed", error: failMsg ?? "فشل المزود دون تفاصيل" };
    }

    // تقدير تقدم تقريبي حسب الحالة
    const progress =
      state === "generating" ? 55 : state === "queuing" ? 20 : 10;
    return { status: "processing", progress };
  },
};
