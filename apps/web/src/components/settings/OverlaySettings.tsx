import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Overlay mode's two switches. Desktop only: the overlay is an Electron
 * window, so a browser tab has nothing these settings could drive.
 */
export function OverlaySettings() {
  const overlayModeEnabled = useClientSettings((settings) => settings.overlayModeEnabled);
  const overlayHiddenUntil = useClientSettings((settings) => settings.overlayHiddenUntil);
  const overlayShowIdlePill = useClientSettings((settings) => settings.overlayShowIdlePill);
  if (!isElectron) return null;

  return (
    <>
      <SettingsRow
        {...searchableSetting("overlay-mode")}
        description="A small window that floats over your other apps and lists the threads you have not looked at. It hides while you are in T3 Code."
        status={
          overlayHiddenUntil === null ? null : (
            <span>Hidden until {formatHiddenUntil(overlayHiddenUntil)}.</span>
          )
        }
        resetAction={
          overlayModeEnabled !== DEFAULT_CLIENT_SETTINGS.overlayModeEnabled ||
          overlayHiddenUntil !== null ? (
            <SettingResetButton
              label="overlay mode"
              onClick={() =>
                void updateClientSettings({
                  overlayModeEnabled: DEFAULT_CLIENT_SETTINGS.overlayModeEnabled,
                  overlayHiddenUntil: null,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={overlayModeEnabled}
            onCheckedChange={(checked) =>
              // Switching it back on clears a temporary hide too, otherwise
              // the overlay would stay invisible and read as broken.
              void updateClientSettings({
                overlayModeEnabled: Boolean(checked),
                ...(checked ? { overlayHiddenUntil: null } : {}),
              })
            }
            aria-label="Overlay mode"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("overlay-idle-pill")}
        description="With this off the overlay stays off screen until something needs you, instead of resting as a small bar."
        resetAction={
          overlayShowIdlePill !== DEFAULT_CLIENT_SETTINGS.overlayShowIdlePill ? (
            <SettingResetButton
              label="idle pill"
              onClick={() =>
                void updateClientSettings({
                  overlayShowIdlePill: DEFAULT_CLIENT_SETTINGS.overlayShowIdlePill,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={overlayShowIdlePill}
            disabled={!overlayModeEnabled}
            onCheckedChange={(checked) =>
              void updateClientSettings({ overlayShowIdlePill: Boolean(checked) })
            }
            aria-label="Show the overlay pill when nothing needs you"
          />
        }
      />
    </>
  );
}

function formatHiddenUntil(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "later";
  return parsed.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
