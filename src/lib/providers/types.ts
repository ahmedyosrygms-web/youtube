// واجهة المزودات الموحدة — أي خطأ يُرمى كـ ProviderError ليُصنَّف في keys.ts
export interface ProviderKey {
  id: string;
  api_key: string;
  label: string;
}

export interface ProviderError extends Error {
  status?: number;
}

export function providerError(message: string, status?: number): ProviderError {
  const e = new Error(message) as ProviderError;
  e.status = status;
  return e;
}

export interface CreateTaskResult {
  providerTaskId: string;
}

export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ImageInput {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
}

export interface VideoInput {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(
    key: ProviderKey,
    model: string,
    input: ImageInput | VideoInput
  ): Promise<CreateTaskResult>;

  // صور متزامنة إن كان المزود يدعمها — model: اسم الموديل كما يُرسل للمزود
  createImageSync?(
    key: ProviderKey,
    model: string,
    input: ImageInput
  ): Promise<{ urls: string[] }>;

  // استعلام حالة مهمة جارية
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult>;
}
