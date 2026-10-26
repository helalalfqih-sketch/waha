import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const { search } = new URL(request.url);
  return redirect(`/app/devices${search}`);
};

export default function AppIndex() {
  return null;
}
