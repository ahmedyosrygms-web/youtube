// سجل الموديلات والمزودون — الأسماء القانونية + الصيغ البديلة + إمكانية التجاوز بمتغيرات البيئة
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

// دالة توحيد الاسم: تحويل النقاط إلى شرطات للأجزاء الرقمية فقط
export function normalizeModelName(name: string): string {
  return name
    .trim()
    // gpt-image-2.6 -> gpt-image-2-6 ; grok-imagine-video-1.5 -> grok-imagine-video-1-5
    .replace(/(\d)\.(\d)/g, "$1-$2");
}

// تجاوز أسماء الموديلات بمتغيرات البيئة إن لزم
const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL =
  process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare";
const COMETAPI_VIDEO_MODEL =
  process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1.5";

const IMAGE_CANONICAL = normalizeModelName(KIE_IMAGE_MODEL);
const VIDEO_CANONICAL = normalizeModelName(KIE_VIDEO_MODEL);

// الموديلان المدمجان — مثبّتان كما هما في المواصفة
export const MODELS: ModelDef[] = [
  {
    canonical: IMAGE_CANONICAL,
    aliases: [
      IMAGE_CANONICAL,
      "gpt-image-2-6/flare-text-to-image",
      "gpt-image-2.6/flare-text-to-image",
    ].map(normalizeModelName),
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: KIE_IMAGE_MODEL,
      cometapi: COMETAPI_IMAGE_MODEL,
    },
  },
  {
    canonical: VIDEO_CANONICAL,
    aliases: [
      VIDEO_CANONICAL,
      "grok-imagine-video-1-5-preview",
      "grok-imagine-video-1.5-preview",
    ].map(normalizeModelName),
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: KIE_VIDEO_MODEL,
      cometapi: COMETAPI_VIDEO_MODEL,
    },
  },
];

// توحيد اسم الموديل عبر aliases — يرمي خطأ معطيات إذا كان غير معروف
export function resolveModel(
  name: string
): { model: ModelDef; canonical: string } | null {
  const normalized = normalizeModelName(name);
  const model = MODELS.find((m) => m.aliases.includes(normalized));
  if (!model) return null;
  return { model, canonical: model.canonical };
}

// صياغة إعدادات الموديلات للـ health
export function modelsForHealth() {
  return MODELS.map((m) => ({
    canonical: m.canonical,
    type: m.type,
    providers: m.providers,
  }));
}
