import { DEFAULT_CLIENT_SETTINGS, type DesktopNotificationTrigger } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const TRIGGER_LABELS: Readonly<Record<DesktopNotificationTrigger, string>> = {
  unfocused: "When unfocused",
  always: "Always",
  never: "Never",
};

function isNotificationTrigger(value: string): value is DesktopNotificationTrigger {
  return value === "unfocused" || value === "always" || value === "never";
}

export function NotificationsSettings() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const phaseSwitchesDisabled = !settings.desktopNotificationsEnabled;
  const overlayHiddenUntil = settings.overlayHiddenUntil;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Notifications">
        <p className="px-3 pb-1 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
          {isElectron
            ? "T3 Code tells you when a thread changes phase: an agent finishes, asks for approval, asks a question, or fails."
            : "Notification banners come from the desktop app. In a browser tab the sidebar marks the same changes instead."}
        </p>

        <SettingsRow
          {...searchableSetting("desktop-notifications")}
          description="Show a macOS notification banner."
          resetAction={
            settings.desktopNotificationsEnabled !==
            DEFAULT_CLIENT_SETTINGS.desktopNotificationsEnabled ? (
              <SettingResetButton
                label="desktop notifications"
                onClick={() =>
                  updateSettings({
                    desktopNotificationsEnabled:
                      DEFAULT_CLIENT_SETTINGS.desktopNotificationsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.desktopNotificationsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ desktopNotificationsEnabled: Boolean(checked) })
              }
              aria-label="Show desktop notifications"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("notification-trigger")}
          description="Unfocused skips the banner while you look at T3 Code. The sidebar still marks the thread."
          resetAction={
            settings.desktopNotificationTrigger !==
            DEFAULT_CLIENT_SETTINGS.desktopNotificationTrigger ? (
              <SettingResetButton
                label="notification trigger"
                onClick={() =>
                  updateSettings({
                    desktopNotificationTrigger: DEFAULT_CLIENT_SETTINGS.desktopNotificationTrigger,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.desktopNotificationTrigger}
              onValueChange={(value) => {
                if (value !== null && isNotificationTrigger(value)) {
                  updateSettings({ desktopNotificationTrigger: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="When to notify">
                <SelectValue>{TRIGGER_LABELS[settings.desktopNotificationTrigger]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="unfocused">
                  {TRIGGER_LABELS.unfocused}
                </SelectItem>
                <SelectItem hideIndicator value="always">
                  {TRIGGER_LABELS.always}
                </SelectItem>
                <SelectItem hideIndicator value="never">
                  {TRIGGER_LABELS.never}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Notify me about">
        <SettingsRow
          {...searchableSetting("notify-on-approval")}
          description="The agent cannot continue until you allow or deny an action."
          resetAction={
            settings.notifyOnApproval !== DEFAULT_CLIENT_SETTINGS.notifyOnApproval ? (
              <SettingResetButton
                label="approval notifications"
                onClick={() =>
                  updateSettings({ notifyOnApproval: DEFAULT_CLIENT_SETTINGS.notifyOnApproval })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.notifyOnApproval}
              disabled={phaseSwitchesDisabled}
              onCheckedChange={(checked) => updateSettings({ notifyOnApproval: Boolean(checked) })}
              aria-label="Notify when an agent needs approval"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("notify-on-input")}
          description="The agent asked you a question."
          resetAction={
            settings.notifyOnInput !== DEFAULT_CLIENT_SETTINGS.notifyOnInput ? (
              <SettingResetButton
                label="input notifications"
                onClick={() =>
                  updateSettings({ notifyOnInput: DEFAULT_CLIENT_SETTINGS.notifyOnInput })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.notifyOnInput}
              disabled={phaseSwitchesDisabled}
              onCheckedChange={(checked) => updateSettings({ notifyOnInput: Boolean(checked) })}
              aria-label="Notify when an agent asks a question"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("notify-on-completion")}
          description="A turn finished and the work is ready to read."
          resetAction={
            settings.notifyOnCompletion !== DEFAULT_CLIENT_SETTINGS.notifyOnCompletion ? (
              <SettingResetButton
                label="completion notifications"
                onClick={() =>
                  updateSettings({ notifyOnCompletion: DEFAULT_CLIENT_SETTINGS.notifyOnCompletion })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.notifyOnCompletion}
              disabled={phaseSwitchesDisabled}
              onCheckedChange={(checked) =>
                updateSettings({ notifyOnCompletion: Boolean(checked) })
              }
              aria-label="Notify when an agent finishes"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("notify-on-failure")}
          description="The session stopped with an error."
          resetAction={
            settings.notifyOnFailure !== DEFAULT_CLIENT_SETTINGS.notifyOnFailure ? (
              <SettingResetButton
                label="failure notifications"
                onClick={() =>
                  updateSettings({ notifyOnFailure: DEFAULT_CLIENT_SETTINGS.notifyOnFailure })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.notifyOnFailure}
              disabled={phaseSwitchesDisabled}
              onCheckedChange={(checked) => updateSettings({ notifyOnFailure: Boolean(checked) })}
              aria-label="Notify when an agent fails"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Overlay mode">
        <p className="px-3 pb-1 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
          A small window that floats over your other apps and lists the threads you have not looked
          at. It hides itself while you are in T3 Code, and shrinks to a pill when nothing needs
          you.
        </p>

        <SettingsRow
          {...searchableSetting("overlay-mode")}
          description="Show the floating overlay window."
          status={
            overlayHiddenUntil === null ? null : (
              <span>Hidden until {formatHiddenUntil(overlayHiddenUntil)}.</span>
            )
          }
          resetAction={
            settings.overlayModeEnabled !== DEFAULT_CLIENT_SETTINGS.overlayModeEnabled ||
            overlayHiddenUntil !== null ? (
              <SettingResetButton
                label="overlay mode"
                onClick={() =>
                  updateSettings({
                    overlayModeEnabled: DEFAULT_CLIENT_SETTINGS.overlayModeEnabled,
                    overlayHiddenUntil: null,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.overlayModeEnabled}
              onCheckedChange={(checked) =>
                // Switching it back on clears a temporary hide too, otherwise
                // the overlay would stay invisible and read as broken.
                updateSettings({
                  overlayModeEnabled: Boolean(checked),
                  ...(checked ? { overlayHiddenUntil: null } : {}),
                })
              }
              aria-label="Show overlay mode"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("overlay-keep-awake")}
          description="Hold off display sleep while the overlay is on screen. Closing the lid still sleeps the Mac."
          resetAction={
            settings.overlayKeepAwake !== DEFAULT_CLIENT_SETTINGS.overlayKeepAwake ? (
              <SettingResetButton
                label="keep awake"
                onClick={() =>
                  updateSettings({ overlayKeepAwake: DEFAULT_CLIENT_SETTINGS.overlayKeepAwake })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.overlayKeepAwake}
              disabled={!settings.overlayModeEnabled}
              onCheckedChange={(checked) => updateSettings({ overlayKeepAwake: Boolean(checked) })}
              aria-label="Keep this Mac awake while the overlay shows"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
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
