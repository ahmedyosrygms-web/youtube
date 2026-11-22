// نظام المفاتيح المتسلسلة — قلب المشروع: التصنيف، الإخفاء، تجميع العدّادات
import { updateKey, getKeyPoolRaw, type ApiKeyRow, type AttemptRecord } from "./turso";

// إخفاء المفتاح دائمًا: أول 7 + نقاط + آخر 4 (للقصير: أول 3 + نقاط)
// إخفاء المفاتيح إلزامي في كل الاستجابات والسجلات
export function maskKey(key: string): string {
  if (key.length >= 12) {
    return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  }
  return `${key.slice(0, 3)}••••`;
}

export interface ProviderErrorInfo {
  status?: number;
  message: string;
}

// تصنيف موحد لأخطاء المزود — يحدد ما إذا كان يجب التبديل أم التوقف
// ملاحظة: نفحص «exhausted» قبل 400 لأن بعض المزودين يرسلون نفاد الرصيد بحالة 400
export function classifyProviderError(
  err: ProviderErrorInfo
): "disabled" | "exhausted" | "provider" | "params" | "temporary" {
  const msg = (err.message || "").toLowerCase();
  const status = err.status;

  // مفتاح مرفوض → تعطيل المفتاح والانتقال للتالي
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|unauthorized|forbidden|authentication/.test(msg)
  ) {
    return "disabled";
  }

  // نفاد الرصيد → تعليم المفتاح مستنزفًا (يبقى في القاعدة) والانتقال للتالي
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(msg)
  ) {
    return "exhausted";
  }

  // الموديل غير مدعوم لدى هذا المزود → الانتقال للمزود/المفتاح التالي
  if (
    (status === 400 || status === 404 || status === 422) &&
    /model not found|unsupported model/.test(msg)
  ) {
    return "provider";
  }

  // خطأ معطيات الطلب — توقف فورًا: تبديل المفاتيح لن يحل خطأ معطيات
  if (status === 400 || status === 422) {
    return "params";
  }

  // 429، 5xx، انقطاع شبكة، timeout — انتقل للتالي الآن والمفتاح يبقى سليمًا
  return "temporary";
}

export function isKeyOrBalanceError(message: string): boolean {
  // يُستخدم لتمييز فشل منتصف المهمة الذي يستحق إعادة الإنشاء على مفتاح آخر
  const msg = (message || "").toLowerCase();
  return /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|authentication|exhausted|充值/.test(
    msg
  );
}

// جلب المفتاح بترتيب الإضافة الصارم (created_at ASC, id ASC)
// المفتاح المستنزف يبقى في القائمة — الاستثناء الوحيد للتعطيل اليدوي (disabled)
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  return getKeyPoolRaw(providers);
}

// تسجيل محاولة ورفع عدّادات المفتاح دائمًا (نجاح أو فشل)
export async function recordAttempt(opts: {
  key: ApiKeyRow;
  ok: boolean;
  errorClass?: string;
  error?: string;
}): Promise<AttemptRecord> {
  const { key, ok, errorClass, error } = opts;
  const now = new Date().toISOString();

  const patch: Parameters<typeof updateKey>[1] = {
    usage_count: (key.usage_count ?? 0) + 1,
    success_count: ok ? (key.success_count ?? 0) + 1 : key.success_count ?? 0,
    fail_count: ok ? key.fail_count ?? 0 : (key.fail_count ?? 0) + 1,
    last_used_at: now,
    last_checked_at: now,
    last_error: ok ? null : (error ?? "خطأ غير معروف"),
  };
  await updateKey(key.id, patch);

  const record: AttemptRecord = {
    provider: key.provider,
    keyId: key.id,
    keyLabel: key.label || maskKey(key.api_key),
    ok,
    ...(errorClass ? { errorClass } : {}),
    ...(error ? { error } : {}),
    at: now,
  };
  return record;
}

// تعليم المفتاح تلقائيًا حسب فئة الخطأ (disabled / exhausted)
export async function markKeyByClass(
  key: ApiKeyRow,
  errorClass: string,
  error: string
): Promise<void> {
  if (errorClass === "disabled") {
    // مفتاح مرفوض → تعطيل تلقائي (يبقى في القاعدة لكنه لا يُجرَّب)
    await updateKey(key.id, { status: "disabled", last_error: error });
  } else if (errorClass === "exhausted") {
    // مستنزف → يبقى في القاعدة دون عرقلة المفاتيح التالية
    await updateKey(key.id, { status: "exhausted", last_error: error });
  }
  // temporary / params / provider: المفتاح يبقى سليمًا
}
