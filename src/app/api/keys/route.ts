// إدارة المفاتيح — GET القائمة (مخفية دائمًا) + POST إضافة مع رفض التكرار
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listKeys, insertKey, getKeyPoolRaw } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = ["kie", "cometapi"];

export async function GET() {
  const keys = await listKeys();
  // إخفاء المفاتيح إلزامي في كل الاستجابات — لا يُعاد المفتاح الكامل أبدًا
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: maskKey(k.api_key),
      status: k.status,
      usage_count: k.usage_count,
      success_count: k.success_count,
      fail_count: k.fail_count,
      last_used_at: k.last_used_at,
      last_checked_at: k.last_checked_at,
      last_error: k.last_error,
      created_at: k.created_at,
    })),
  });
}

export async function POST(req: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }

  const provider = (body.provider ?? "").trim();
  const apiKey = (body.api_key ?? "").trim();
  const label = (body.label ?? "").trim();

  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: "المزود غير صالح — القيم المتاحة: kie، cometapi" },
      { status: 400 }
    );
  }
  if (!apiKey) {
    return NextResponse.json({ error: "المفتاح مطلوب" }, { status: 400 });
  }

  // رفض التكرار لنفس المزود
  const pool = await getKeyPoolRaw([provider]);
  const all = await listKeys();
  if (all.some((k) => k.provider === provider && k.api_key === apiKey)) {
    return NextResponse.json(
      { error: "هذا المفتاح مضاف مسبقًا لنفس المزود" },
      { status: 409 }
    );
  }
  if (pool.some((k) => k.api_key === apiKey)) {
    // مفتاح معطّل يدويًا بنفس القيمة — يبقى مرفوضًا كتكرار
    return NextResponse.json(
      { error: "هذا المفتاح مضاف مسبقًا لنفس المزود" },
      { status: 409 }
    );
  }

  const id = randomUUID();
  await insertKey({ id, provider, label, api_key: apiKey });
  return NextResponse.json(
    {
      ok: true,
      key: {
        id,
        provider,
        label,
        masked: maskKey(apiKey),
        status: "active",
      },
    },
    { status: 201 }
  );
}
