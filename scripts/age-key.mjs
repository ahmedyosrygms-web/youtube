// أداة اختبار: تقديم created_at لأحدث مفتاح بساعة واحدة
// حتى يصبح أول مفتاح في الترتيب التسلسلي (لمحاكاة اختبار التبديل 4.3)
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("متغيرات Turso مطلوبة");
  process.exit(1);
}
const client = createClient({ url, authToken: token });

// جلب المفتاح المطلوب بالتسمية
const label = process.argv[2];
if (!label) {
  console.error("الاستخدام: node scripts/age-key.mjs <label>");
  process.exit(1);
}
const res = await client.execute({
  sql: "SELECT id, label, created_at FROM api_keys WHERE label = ?",
  args: [label],
});
if (!res.rows.length) {
  console.error("المفتاح غير موجود:", label);
  process.exit(1);
}
const key = res.rows[0];
await client.execute({
  sql: "UPDATE api_keys SET created_at = datetime('now', '-2 hours') WHERE id = ?",
  args: [String(key.id)],
});
console.log(`تم تقديم المفتاح «${label}» بساعتين — صار أول مفتاح في الترتيب`);
