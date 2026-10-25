import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { getWahaQr, getWahaSession } from "../services/waha.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const wahaSession = await getWahaSession(session.shop);
    if (wahaSession?.status !== "SCAN_QR_CODE") {
      return new Response("QR is not available", {
        status: 404,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }

    const qr = await getWahaQr(session.shop);
    const body = new ArrayBuffer(qr.data.byteLength);
    new Uint8Array(body).set(qr.data);

    return new Response(body, {
      headers: {
        "Content-Type": qr.contentType,
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("QR is not available", {
      status: 404,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  }
};
