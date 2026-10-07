import { createFileRoute } from "@tanstack/react-router";

import { ShippingPage } from "../components/shipping/ShippingPage";

export const Route = createFileRoute("/shipping")({
  component: ShippingPage,
});
