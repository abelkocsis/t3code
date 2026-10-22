import { useOverlayMode } from "../../hooks/useOverlayMode";

/** Drives the desktop overlay window. Renders nothing. */
export function OverlayModeCoordinator() {
  useOverlayMode();
  return null;
}
