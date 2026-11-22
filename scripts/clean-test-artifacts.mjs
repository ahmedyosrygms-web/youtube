// تنظيف آثار الاختبار بعد اكتمال معايير القبول:
// 1) حذف كل المهام الاختبارية من جدول tasks (كلها كانت اختبارات e2e)
// 2) حذف المفاتيح الوهمية/المعطّلة من جدول api_keys مع الإبقاء على المفتاح الرئيسي
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("متغيرات Turso مطلوبة");
  process.exit(1);
}
const client = createClient({ url, authToken: token });

// حذف المهام الاختبارية
const t = await client.execute("DELETE FROM tasks");
console.log("المهام المحذوفة:", t.rowsAffected);

// حذف المفاتيح غير الناجحة (وهمية أو معطّلة): بلا أي استخدام ناجح
const k = await client.execute(
  "DELETE FROM api_keys WHERE success_count = 0 OR status = 'disabled'"
);
console.log("المفاتيح المحذوفة:", k.rowsAffected);

// عرض ما تبقى
const remain = await client.execute("SELECT label, status, success_count FROM api_keys ORDER BY created_at ASC");
for (const r of remain.rows) {
  console.log("متبقي:", r.label, "|", r.status, "| نجاح:", r.success_count);
}
