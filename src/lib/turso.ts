// طبقة قاعدة البيانات Turso (libSQL عبر HTTP) — إلزامية للتوافق مع Vercel serverless
import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;
// تخزين مؤقت لوعد إنشاء المخطط حتى لا يُنفَّذ أكثر من مرة في نفس الحاوية
let schemaPromise: Promise<void> | null = null;

function getClient(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

// إنشاء الجداول عند أول وصول — بلا أدوات migrations
export async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const c = getClient();
      await c.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await c.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      // فهارس بسيطة لتسريع الاستعلامات الشائعة
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`
      );
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys(provider, created_at)`
      );
    })().catch((err) => {
      // فشل المخطط يسمح بإعادة المحاولة لاحقًا
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

// فحص صحة الاتصال بقاعدة البيانات
export async function dbHealthy(): Promise<boolean> {
  try {
    await getClient().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// أنواع صفوف الجداول
export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as TaskRow["type"],
    prompt: (r.prompt as string) ?? "",
    params_json: (r.params_json as string) ?? "{}",
    status: r.status as TaskRow["status"],
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: (r.attempts_json as string) ?? "[]",
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: (r.completed_at as string) ?? null,
  };
}

function mapKey(r: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider),
    label: (r.label as string) ?? "",
    api_key: String(r.api_key),
    status: (r.status as string) ?? "active",
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

// ============ عمليات المهام ============

export async function insertTask(task: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status: string;
  progress?: number;
}): Promise<void> {
  await ensureSchema();
  await getClient().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      task.id,
      task.provider ?? null,
      task.provider_task_id ?? null,
      task.key_id ?? null,
      task.model,
      task.type,
      task.prompt ?? "",
      task.params_json ?? "{}",
      task.status,
      task.progress ?? 0,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const res = await getClient().execute({
    sql: "SELECT * FROM tasks WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapTask(res.rows[0] as unknown as Record<string, unknown>);
}

// تحديث جزئي للمهمة — يضيف المحاولات ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(
  id: string,
  patch: {
    provider?: string | null;
    provider_task_id?: string | null;
    key_id?: string | null;
    status?: string;
    progress?: number;
    result_urls_json?: string | null;
    error_message?: string | null;
    append_attempt?: AttemptRecord;
    completed_at?: string | null;
  }
): Promise<void> {
  await ensureSchema();
  const current = await getTask(id);
  if (!current) return;

  const attempts: AttemptRecord[] = JSON.parse(current.attempts_json || "[]");
  if (patch.append_attempt) attempts.push(patch.append_attempt);

  const completedAt =
    patch.status === "completed"
      ? new Date().toISOString()
      : patch.completed_at !== undefined
        ? patch.completed_at
        : current.completed_at;

  await getClient().execute({
    sql: `UPDATE tasks SET
      provider = COALESCE(?, provider),
      provider_task_id = COALESCE(?, provider_task_id),
      key_id = COALESCE(?, key_id),
      status = COALESCE(?, status),
      progress = COALESCE(?, progress),
      result_urls_json = COALESCE(?, result_urls_json),
      error_message = ?,
      attempts_json = ?,
      completed_at = ?,
      updated_at = datetime('now')
      WHERE id = ?`,
    args: [
      patch.provider ?? null,
      patch.provider_task_id ?? null,
      patch.key_id ?? null,
      patch.status ?? null,
      patch.progress ?? null,
      patch.result_urls_json ?? null,
      // error_message يُكتب دائمًا (قد يكون null لمسح الخطأ)
      patch.error_message !== undefined ? patch.error_message : current.error_message,
      JSON.stringify(attempts),
      completedAt,
      id,
    ],
  });
}

export async function listRecentTasks(
  limit = 10,
  filter?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter?.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter?.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const sql = `SELECT * FROM tasks ${
    where.length ? "WHERE " + where.join(" AND ") : ""
  } ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(limit);
  const res = await getClient().execute({ sql, args });
  return res.rows.map((r) => mapTask(r as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  await ensureSchema();
  const res = await getClient().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const r = res.rows[0] as unknown as Record<string, unknown> | undefined;
  return {
    total: Number(r?.total ?? 0),
    completed: Number(r?.completed ?? 0),
    failed: Number(r?.failed ?? 0),
    processing: Number(r?.processing ?? 0),
  };
}

export async function deleteTasksByIds(ids: string[]): Promise<void> {
  await ensureSchema();
  for (const id of ids) {
    await getClient().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
  }
}

// ============ عمليات المفاتيح ============

export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const res = await getClient().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC"
  );
  return res.rows.map((r) => mapKey(r as unknown as Record<string, unknown>));
}

export async function getKeyById(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const res = await getClient().execute({
    sql: "SELECT * FROM api_keys WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return mapKey(res.rows[0] as unknown as Record<string, unknown>);
}

export async function insertKey(key: {
  id: string;
  provider: string;
  label: string;
  api_key: string;
}): Promise<void> {
  await ensureSchema();
  await getClient().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [key.id, key.provider, key.label, key.api_key],
  });
}

export async function updateKey(
  id: string,
  patch: Partial<{
    status: string;
    usage_count: number;
    success_count: number;
    fail_count: number;
    last_used_at: string;
    last_checked_at: string;
    last_error: string | null;
    label: string;
  }>
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    args.push(v as string | number | null);
  }
  if (!sets.length) return;
  args.push(id);
  await getClient().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getClient().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// تجلب كل المفاتيح غير المعطّلة لهذه المزودات بترتيب الإضافة الصارم
// (أول مفتاح أُضيف يُجرَّب أولًا — ليس round-robin ولا الأقل استخدامًا أولًا)
export async function getKeyPoolRaw(providers: string[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  if (!providers.length) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const res = await getClient().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return res.rows.map((r) => mapKey(r as unknown as Record<string, unknown>));
}

export default getClient;
