// تعطيل/تنشيط يدوي وحذف مفتاح — PATCH/DELETE /api/keys/{id}
import { NextResponse } from "next/server";
import { updateKey, deleteKey, getKeyById } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  let body: { status?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }
  const status = body.status;
  if (status !== "active" && status !== "disabled") {
    return NextResponse.json(
      { error: "الحالة المسموحة: active أو disabled (التعطيل يدوي فقط)" },
      { status: 400 }
    );
  }
  const key = await getKeyById(id);
  if (!key) {
    return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  }
  await updateKey(id, { status });
  return NextResponse.json({ ok: true, status });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const key = await getKeyById(id);
  if (!key) {
    return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  }
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
