import { createFileRoute } from "@tanstack/react-router";
import { BitSafeSettings } from "../components/settings/BitSafeSettings";

export const Route = createFileRoute("/settings/bitsafe")({ component: BitSafeSettings });
