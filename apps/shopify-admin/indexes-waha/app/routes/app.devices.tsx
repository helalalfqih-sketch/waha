import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  createWahaSession,
  getWahaSession,
  restartWahaSession,
  startWahaSession,
  stopWahaSession,
} from "../services/waha.server";

type DeviceView = {
  name: string;
  status: string;
  presence: string | null;
  accountName: string | null;
  accountHint: string | null;
};

type ActionResult = {
  ok: boolean;
  message: string;
};

function WahaQrImage() {
  const shopify = useAppBridge();
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const idToken = await shopify.idToken();
        const response = await fetch("/app/waha-qr", {
          headers: { Authorization: `Bearer ${idToken}` },
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("QR is unavailable");

        const image = await response.blob();
        if (image.type !== "image/png" || image.size > 512 * 1024) {
          throw new Error("Invalid QR image");
        }

        objectUrl = URL.createObjectURL(image);
        setSource(objectUrl);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [shopify]);

  if (failed) {
    return (
      <s-banner tone="critical" heading="تعذر تحميل رمز QR">
        <s-paragraph>أعد تشغيل الجلسة ثم حاول مجددًا.</s-paragraph>
      </s-banner>
    );
  }

  if (!source) return <s-text>جارٍ تحميل رمز الربط الآمن…</s-text>;

  return (
    <img
      src={source}
      alt="رمز QR لربط رقم الاختبار يدويًا"
      width="320"
      height="320"
      style={{ display: "block", maxWidth: "100%", height: "auto" }}
    />
  );
}

const STATUS_LABELS: Record<string, string> = {
  STOPPED: "متوقفة",
  STARTING: "قيد التشغيل",
  SCAN_QR_CODE: "بانتظار مسح QR",
  PASSKEY_REQUIRED: "تحتاج رمز مرور",
  PASSKEY_CONFIRMATION_REQUIRED: "بانتظار تأكيد رمز المرور",
  WORKING: "متصلة",
  FAILED: "فشل الاتصال",
};

function maskAccountId(value?: string) {
  if (!value) return null;
  const localPart = value.split("@")[0] ?? "";
  return localPart.length > 4 ? `••••${localPart.slice(-4)}` : "مرتبط";
}

function toDeviceView(device: Awaited<ReturnType<typeof getWahaSession>>) {
  if (!device) return null;

  return {
    name: device.name,
    status: device.status,
    presence: device.presence ?? null,
    accountName: device.me?.pushName ?? null,
    accountHint: maskAccountId(device.me?.id),
  } satisfies DeviceView;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const device = await getWahaSession(session.shop);
    return { device: toDeviceView(device), error: null };
  } catch {
    return {
      device: null,
      error:
        "تعذر الوصول إلى WAHA. تحقق من إعدادات الاتصال في خادم التطبيق.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    switch (intent) {
      case "create":
        await createWahaSession(session.shop);
        return { ok: true, message: "تم إنشاء جلسة الاختبار وبدؤها." };
      case "start":
        await startWahaSession(session.shop);
        return { ok: true, message: "بدأ تشغيل جلسة الاختبار." };
      case "stop":
        await stopWahaSession(session.shop);
        return {
          ok: true,
          message: "تم إيقاف الجلسة مع الاحتفاظ بالربط.",
        };
      case "restart":
        await restartWahaSession(session.shop);
        return { ok: true, message: "تمت إعادة تشغيل جلسة الاختبار." };
      default:
        return { ok: false, message: "الإجراء المطلوب غير معروف." };
    }
  } catch {
    return {
      ok: false,
      message: "لم يكتمل الإجراء. تحقق من حالة WAHA ثم حاول مرة أخرى.",
    };
  }
};

export default function DevicesPage() {
  const { device, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle" &&
        fetcher.state === "idle"
      ) {
        revalidator.revalidate();
      }
    }, 5000);

    return () => window.clearInterval(timer);
  }, [fetcher.state, revalidator]);

  useEffect(() => {
    if (!fetcher.data) return;
    shopify.toast.show(fetcher.data.message, {
      isError: !fetcher.data.ok,
    });
    if (fetcher.data.ok) revalidator.revalidate();
  }, [fetcher.data, revalidator, shopify]);

  const run = (intent: "create" | "start" | "stop" | "restart") => {
    fetcher.submit({ intent }, { method: "POST" });
  };

  const statusLabel = device
    ? (STATUS_LABELS[device.status] ?? device.status)
    : "لا توجد جلسة";
  const isWorking = device?.status === "WORKING";
  const needsQr = device?.status === "SCAN_QR_CODE";

  return (
    <s-page heading="أجهزة واتساب">
      <s-section heading="جلسة الاختبار">
        <s-stack direction="block" gap="base">
          {error && (
            <s-banner tone="critical" heading="تعذر الاتصال">
              <s-paragraph>{error}</s-paragraph>
            </s-banner>
          )}

          <s-stack direction="inline" gap="base">
            <s-text type="strong">الحالة:</s-text>
            <s-badge
              tone={isWorking ? "success" : needsQr ? "warning" : "info"}
            >
              {statusLabel}
            </s-badge>
          </s-stack>

          {device && (
            <s-stack direction="block" gap="small-200">
              <s-paragraph>
                <s-text type="strong">اسم الجلسة: </s-text>
                {device.name}
              </s-paragraph>
              <s-paragraph>
                <s-text type="strong">الحساب: </s-text>
                {device.accountName ?? "غير مرتبط"}
                {device.accountHint ? ` (${device.accountHint})` : ""}
              </s-paragraph>
              <s-paragraph>
                <s-text type="strong">الحضور: </s-text>
                {device.presence === "online" ? "متصل" : "غير متصل"}
              </s-paragraph>
            </s-stack>
          )}

          <s-stack direction="inline" gap="base">
            {!device && !error && (
              <s-button
                variant="primary"
                onClick={() => run("create")}
                {...(busy ? { loading: true } : {})}
              >
                إنشاء وبدء جلسة الاختبار
              </s-button>
            )}
            {device?.status === "STOPPED" && (
              <s-button
                variant="primary"
                onClick={() => run("start")}
                {...(busy ? { loading: true } : {})}
              >
                تشغيل
              </s-button>
            )}
            {device && (
              <s-button
                onClick={() => run("restart")}
                {...(busy ? { loading: true } : {})}
              >
                إعادة تشغيل
              </s-button>
            )}
            {device && device.status !== "STOPPED" && (
              <s-button
                tone="critical"
                onClick={() => run("stop")}
                {...(busy ? { loading: true } : {})}
              >
                إيقاف مع الاحتفاظ بالربط
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {needsQr && (
        <s-section heading="ربط الجهاز يدويًا">
          <s-stack direction="block" gap="base">
            <s-banner tone="warning" heading="المسح بيدك فقط">
              <s-paragraph>
                افتح واتساب في هاتف الاختبار ثم امسح الرمز بنفسك. لا يحفظ
                التطبيق صورة QR، وستختفي تلقائيًا بعد نجاح الربط.
              </s-paragraph>
            </s-banner>
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <WahaQrImage />
            </s-box>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="حدود النسخة الحالية">
        <s-unordered-list>
          <s-list-item>
            هذه المرحلة تقيد التطبيق بجلسة اختبار واحدة؛ تعدد الأجهزة سيضاف
            بعد اعتماد الصلاحيات والسعة.
          </s-list-item>
          <s-list-item>لا توجد أوامر حذف أو إلغاء ربط في هذه الشاشة.</s-list-item>
          <s-list-item>كل مفاتيح WAHA محفوظة في الخادم فقط.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
