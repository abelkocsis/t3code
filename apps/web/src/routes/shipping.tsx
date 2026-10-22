import { createFileRoute, redirect } from "@tanstack/react-router";

import { ShippingPage } from "../components/shipping/ShippingPage";

export const Route = createFileRoute("/shipping")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ShippingPage,
});
