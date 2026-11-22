"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  KeyRound,
  Activity,
  Plug,
  Copy,
  Check,
  Trash2,
  Power,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  Image as ImageIcon,
  Video as VideoIcon,
  Layers,
  Database,
} from "lucide-react";

// أنواع البيانات من الـ API
interface KeyItem {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskItem {
  id: string;
  type: string;
  model: string;
  status: string;
  progress: number;
  prompt: string;
  result_urls: string[];
  error_message: string | null;
  attempts_count: number;
  created_at: string;
}

interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "بالانتظار",
};

// نصوص أدوات MCP للرقائق
const TOOLS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — تعيد رابطًا أو task_id للمتابعة" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن — task_id فوري وتتبع بـ get_task" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض روابط النتائج" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها من قاعدة البيانات" },
];

export default function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [origin, setOrigin] = useState("");

  // نموذج إضافة مفتاح
  const [newProvider, setNewProvider] = useState("kie");
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [addingKey, setAddingKey] = useState(false);

  // نسخ
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // جلب الصحة + المفاتيح + المهام
  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/keys");
      const data = await res.json();
      setKeys(data.keys ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20");
      const data = await res.json();
      setTasks(data.tasks ?? []);
      setStats(data.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 });
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    fetchHealth();
    fetchKeys();
    fetchTasks();
    // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    const t = setInterval(fetchTasks, 5000);
    return () => clearInterval(t);
  }, [fetchHealth, fetchKeys, fetchTasks]);

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(id);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2000);
  };

  // إضافة مفتاح — رفض التكرار من الخادم
  const addKey = async () => {
    setKeyMsg(null);
    if (!newKey.trim()) {
      setKeyMsg({ ok: false, text: "أدخل المفتاح أولًا" });
      return;
    }
    setAddingKey(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: newProvider,
          api_key: newKey.trim(),
          label: newLabel.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setKeyMsg({ ok: true, text: "أُضيف المفتاح بنجاح — سيُجرَّب أولًا حسب ترتيب الإضافة" });
        setNewKey("");
        setNewLabel("");
        fetchKeys();
      } else {
        setKeyMsg({ ok: false, text: data.error ?? "فشل إضافة المفتاح" });
      }
    } catch {
      setKeyMsg({ ok: false, text: "خطأ شبكة — حاول مجددًا" });
    } finally {
      setAddingKey(false);
    }
  };

  const toggleKey = async (k: KeyItem) => {
    const target = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: target }),
    });
    fetchKeys();
  };

  const deleteKey = async (k: KeyItem) => {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    fetchKeys();
  };

  const statusBadgeClass = (status: string) => {
    switch (status) {
      case "active":
      case "completed":
        return "bg-emerald-100 text-emerald-800 border-emerald-300";
      case "exhausted":
      case "processing":
        return "bg-amber-100 text-amber-800 border-amber-300";
      case "disabled":
      case "failed":
        return "bg-zinc-200 text-zinc-700 border-zinc-300";
      default:
        return "";
    }
  };

  const mcpUrl = origin ? `${origin}/mcp` : "/mcp";
  const authBlock = health?.authRequired
    ? `\n    "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
    : "";

  const chatgptJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authBlock}\n    }\n  }\n}`;
  const claudeJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authBlock}\n    }\n  }\n}`;
  const cursorJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authBlock}\n    }\n  }\n}`;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 to-slate-100">
      {/* الهيدر — حالة /api/health */}
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-violet-600 flex items-center justify-center text-white">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold">MCP Media Generator</h1>
              <p className="text-xs text-muted-foreground">
                خادم MCP لتوليد الصور والفيديو ودمج المقاطع — لوحة الإدارة العربية
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {health ? (
              <>
                <Badge
                  className={
                    health.ok
                      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                      : "bg-red-100 text-red-800 border-red-300"
                  }
                >
                  <Database className="w-3 h-3 me-1" />
                  {health.ok ? "Turso متصل" : "غير متصل"}
                </Badge>
                <Badge
                  className={
                    health.merger?.healthy
                      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                      : "bg-amber-100 text-amber-800 border-amber-300"
                  }
                >
                  خدمة الدمج: {health.merger?.healthy ? "جاهزة" : "غير مهيأة"}
                </Badge>
                {health.authRequired && (
                  <Badge className="bg-violet-100 text-violet-800 border-violet-300">
                    محمي بمصادقة Bearer
                  </Badge>
                )}
              </>
            ) : (
              <Badge className="bg-red-100 text-red-800 border-red-300">
                جارٍ فحص الحالة…
              </Badge>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6 space-y-6">
        {/* أ) مدير المفاتيح */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="w-5 h-5 text-cyan-600" />
              مدير المفاتيح
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm bg-cyan-50 border border-cyan-200 text-cyan-900 rounded-lg p-3">
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع
              تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
            </p>

            {/* نموذج الإضافة */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div className="space-y-1.5">
                <Label>المزود</Label>
                <Select value={newProvider} onValueChange={setNewProvider}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kie">kie.ai</SelectItem>
                    <SelectItem value="cometapi">CometAPI</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>تسمية (اختياري)</Label>
                <Input
                  placeholder="مثال: مفتاح رئيسي"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                />
              </div>
              <div className="space-y-1.5 md:col-span-1">
                <Label>المفتاح</Label>
                <Input
                  placeholder="API Key"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  type="password"
                />
              </div>
              <Button onClick={addKey} disabled={addingKey} className="md:mb-0">
                {addingKey ? "جارٍ الإضافة…" : "إضافة المفتاح"}
              </Button>
            </div>
            {keyMsg && (
              <p
                className={`text-sm rounded-lg p-2 border ${
                  keyMsg.ok
                    ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                    : "bg-red-50 border-red-200 text-red-800"
                }`}
              >
                {keyMsg.text}
              </p>
            )}

            {/* قائمة المفاتيح — مُقنَّعة دائمًا */}
            <div className="max-h-96 overflow-y-auto rounded-lg border">
              {keys.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4 text-center">
                  لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.
                </p>
              ) : (
                <div className="divide-y">
                  {keys.map((k) => (
                    <div
                      key={k.id}
                      className="flex flex-wrap items-center gap-3 p-3 text-sm"
                    >
                      <span className="font-mono text-xs bg-muted px-2 py-1 rounded">
                        {k.masked}
                      </span>
                      <Badge variant="outline" className="font-mono">
                        {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                      </Badge>
                      <Badge className={statusBadgeClass(k.status)}>
                        {k.status === "active"
                          ? "نشط"
                          : k.status === "exhausted"
                            ? "مستنزف"
                            : "معطّل"}
                      </Badge>
                      {k.label && (
                        <span className="text-xs text-muted-foreground">{k.label}</span>
                      )}
                      <span className="text-xs text-muted-foreground" dir="ltr">
                        استخدام {k.usage_count} · نجاح {k.success_count} · فشل {k.fail_count}
                      </span>
                      {k.last_error && (
                        <span
                          className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-0.5 max-w-[220px] truncate"
                          title={k.last_error}
                        >
                          {k.last_error}
                        </span>
                      )}
                      <div className="ms-auto flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => toggleKey(k)}
                          title={k.status === "disabled" ? "تنشيط" : "تعطيل"}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => deleteKey(k)}
                          title="حذف"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-red-600" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ب) لوحة المهام */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="w-5 h-5 text-violet-600" />
              لوحة المهام
              <span className="ms-auto flex items-center gap-1 text-xs text-muted-foreground font-normal">
                <RefreshCw className="w-3 h-3" /> تحديث تلقائي كل 5 ثوانٍ
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* شرائح الإحصائيات */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-white p-3 text-center">
                <p className="text-2xl font-bold">{stats.total}</p>
                <p className="text-xs text-muted-foreground">إجمالي</p>
              </div>
              <div className="rounded-lg border bg-white p-3 text-center">
                <p className="text-2xl font-bold text-emerald-700">{stats.completed}</p>
                <p className="text-xs text-muted-foreground">مكتملة</p>
              </div>
              <div className="rounded-lg border bg-white p-3 text-center">
                <p className="text-2xl font-bold text-red-700">{stats.failed}</p>
                <p className="text-xs text-muted-foreground">فاشلة</p>
              </div>
              <div className="rounded-lg border bg-white p-3 text-center">
                <p className="text-2xl font-bold text-amber-700">{stats.processing}</p>
                <p className="text-xs text-muted-foreground">جارية</p>
              </div>
            </div>

            {/* قائمة أحدث المهام */}
            <div className="max-h-[500px] overflow-y-auto rounded-lg border">
              {tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4 text-center">
                  لا توجد مهام بعد — ستظهر هنا مباشرة بعد أول توليد.
                </p>
              ) : (
                <div className="divide-y">
                  {tasks.map((t) => (
                    <div key={t.id} className="p-3 space-y-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="gap-1">
                          {t.type === "image" ? (
                            <ImageIcon className="w-3 h-3" />
                          ) : t.type === "video" ? (
                            <VideoIcon className="w-3 h-3" />
                          ) : (
                            <Layers className="w-3 h-3" />
                          )}
                          {TYPE_LABEL[t.type] ?? t.type}
                        </Badge>
                        <Badge className={statusBadgeClass(t.status)}>
                          {STATUS_LABEL[t.status] ?? t.status}
                        </Badge>
                        <span className="font-mono text-xs text-muted-foreground">
                          {t.model}
                        </span>
                        {t.attempts_count > 0 && (
                          <span className="text-xs text-muted-foreground">
                            المحاولات: {t.attempts_count}
                          </span>
                        )}
                        <span className="ms-auto text-xs text-muted-foreground" dir="ltr">
                          {t.created_at}
                        </span>
                      </div>
                      {t.prompt && (
                        <p className="text-xs text-muted-foreground truncate">
                          {t.prompt}
                        </p>
                      )}
                      {(t.status === "processing" || t.status === "pending") && (
                        <Progress value={t.progress ?? 0} className="h-1.5" />
                      )}
                      {t.error_message && (
                        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                          {t.error_message}
                        </p>
                      )}
                      {t.result_urls?.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {t.result_urls.map((u) => (
                            <a
                              key={u}
                              href={u}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-cyan-700 bg-cyan-50 border border-cyan-200 rounded px-2 py-1 hover:bg-cyan-100"
                              dir="ltr"
                            >
                              <ExternalLink className="w-3 h-3" />
                              فتح النتيجة
                            </a>
                          ))}
                        </div>
                      )}
                      <p className="font-mono text-[10px] text-muted-foreground" dir="ltr">
                        {t.id}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ج) ربط السيرفر */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Plug className="w-5 h-5 text-emerald-600" />
              ربط السيرفر بأي عميل MCP
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* رابط MCP مع نسخ */}
            <div className="flex items-center gap-2">
              <Input readOnly value={mcpUrl} dir="ltr" className="font-mono text-sm" />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copy(mcpUrl, "mcp-url")}
                title="نسخ الرابط"
              >
                {copied === "mcp-url" ? (
                  <Check className="w-4 h-4 text-emerald-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>

            {/* تبويبات JSON لكل عميل */}
            <Tabs defaultValue="chatgpt">
              <TabsList>
                <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في
                  «Server URL».
                </p>
                <pre className="bg-zinc-900 text-zinc-100 rounded-lg p-3 text-xs overflow-x-auto" dir="ltr">
                  {chatgptJson}
                </pre>
                <Button size="sm" variant="outline" onClick={() => copy(chatgptJson, "gpt")}>
                  {copied === "gpt" ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" /> تم النسخ
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> نسخ
                    </>
                  )}
                </Button>
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  ألصقها في ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.
                </p>
                <pre className="bg-zinc-900 text-zinc-100 rounded-lg p-3 text-xs overflow-x-auto" dir="ltr">
                  {claudeJson}
                </pre>
                <Button size="sm" variant="outline" onClick={() => copy(claudeJson, "claude")}>
                  {copied === "claude" ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" /> تم النسخ
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> نسخ
                    </>
                  )}
                </Button>
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  أضفها إلى mcp.json في Cursor أو Windsurf أو Cline.
                </p>
                <pre className="bg-zinc-900 text-zinc-100 rounded-lg p-3 text-xs overflow-x-auto" dir="ltr">
                  {cursorJson}
                </pre>
                <Button size="sm" variant="outline" onClick={() => copy(cursorJson, "cursor")}>
                  {copied === "cursor" ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" /> تم النسخ
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> نسخ
                    </>
                  )}
                </Button>
              </TabsContent>
            </Tabs>

            {/* رقائق الأدوات الخمس */}
            <div className="flex flex-wrap gap-2">
              {TOOLS.map((tool) => (
                <div
                  key={tool.name}
                  className="rounded-lg border bg-white px-3 py-2 text-xs max-w-full"
                >
                  <span className="font-mono font-semibold text-emerald-700" dir="ltr">
                    {tool.name}
                  </span>
                  <span className="text-muted-foreground"> — {tool.desc}</span>
                </div>
              ))}
            </div>

            {/* ملاحظة كهرمانية */}
            <p className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل
              10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار
              يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
            </p>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t bg-white/80 mt-auto">
        <div className="max-w-6xl mx-auto px-4 py-3 text-center text-xs text-muted-foreground">
          MCP Media Generator v1.2.0 — توليد الصور والفيديو ودمج المقاطع عبر MCP
        </div>
      </footer>
    </div>
  );
}
