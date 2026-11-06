import { createFileRoute } from "@tanstack/react-router";
import { BitSafeSettings } from "../components/settings/BitSafeSettings";

export const Route = createFileRoute("/_chat/settings/bitsafe")({ component: BitSafeSettings });
