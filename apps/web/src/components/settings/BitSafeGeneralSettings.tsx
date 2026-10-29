import { useState } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { OverlaySettings } from "./OverlaySettings";
import { UpstreamReleaseSection } from "./UpstreamReleaseSection";
import { QuickRepliesSettings } from "./QuickRepliesSettings";

/**
 * The prompt template is long, so it edits in a draft and commits on blur: a server round
 * trip per keystroke would make the field lag.
 */
function PromptTemplateField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      className="w-full sm:w-96"
      rows={8}
      value={draft ?? value}
      spellCheck={false}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
    />
  );
}

export function BitSafeGeneralSettings({
  section,
}: {
  section: "organization" | "behavior" | "text-generation" | "factory" | "desktop" | "about";
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  switch (section) {
    case "organization":
      return (
        <>
          <SettingsRow
            {...searchableSetting("usage-pace-weekends")}
            description="The even-spending mark on a weekly limit follows the whole week. Off, it only advances Monday to Friday."
            control={
              <Switch
                checked={settings.usagePaceIncludesWeekends}
                onCheckedChange={(checked) =>
                  updateSettings({ usagePaceIncludesWeekends: Boolean(checked) })
                }
                aria-label="Count weekends in usage pace"
              />
            }
          />
          <SettingsRow
            {...searchableSetting("usage-bars-fill-used")}
            description="Usage limit bars fill with the quota you used. Off, they fill with what is left, as upstream does."
            control={
              <Switch
                checked={settings.usageBarsFillUsed}
                onCheckedChange={(checked) =>
                  updateSettings({ usageBarsFillUsed: Boolean(checked) })
                }
                aria-label="Usage bars show what is used"
              />
            }
          />
          <SettingsRow
            {...searchableSetting("compact-thread-rows")}
            description="Show every thread as a one-line row. Off, live threads keep the full card with branch and change counts."
            resetAction={
              settings.sidebarCompactThreadRows !==
              DEFAULT_UNIFIED_SETTINGS.sidebarCompactThreadRows ? (
                <SettingResetButton
                  label="compact thread rows"
                  onClick={() =>
                    updateSettings({
                      sidebarCompactThreadRows: DEFAULT_UNIFIED_SETTINGS.sidebarCompactThreadRows,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.sidebarCompactThreadRows}
                onCheckedChange={(checked) =>
                  updateSettings({ sidebarCompactThreadRows: Boolean(checked) })
                }
                aria-label="Compact thread rows"
              />
            }
          />
          <SettingsRow
            {...searchableSetting("thread-details-card")}
            description="Show the thread details card with the machine, editor, project scripts and git actions, and its toggle in the title bar."
            control={
              <Switch
                checked={settings.threadDetailsCardEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ threadDetailsCardEnabled: Boolean(checked) })
                }
                aria-label="Thread details card"
              />
            }
          />
        </>
      );
    case "behavior":
      return (
        <>
          <SettingsRow
            {...searchableSetting("pull-request-auto-merge")}
            description="Offer auto-merge on pull requests whose merge is still blocked. An auto-merge that is already on always shows."
            resetAction={
              settings.pullRequestAutoMergeEnabled !==
              DEFAULT_UNIFIED_SETTINGS.pullRequestAutoMergeEnabled ? (
                <SettingResetButton
                  label="pull request auto-merge"
                  onClick={() =>
                    updateSettings({
                      pullRequestAutoMergeEnabled:
                        DEFAULT_UNIFIED_SETTINGS.pullRequestAutoMergeEnabled,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.pullRequestAutoMergeEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ pullRequestAutoMergeEnabled: Boolean(checked) })
                }
                aria-label="Pull request auto-merge"
              />
            }
          />
        </>
      );
    case "text-generation":
      return (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["dailySummaryInstructions"]}
            {...searchableSetting("daily-summary-instructions")}
            description="The rules the model follows when it writes a daily summary. The output format and the day's evidence are added automatically."
            resetAction={
              settings.dailySummaryInstructions !==
              DEFAULT_UNIFIED_SETTINGS.dailySummaryInstructions ? (
                <SettingResetButton
                  label="daily summary prompt"
                  onClick={() =>
                    updateSettings({
                      dailySummaryInstructions: DEFAULT_UNIFIED_SETTINGS.dailySummaryInstructions,
                    })
                  }
                />
              ) : null
            }
            control={
              <PromptTemplateField
                label="Daily summary prompt"
                value={settings.dailySummaryInstructions}
                onCommit={(next) => updateSettings({ dailySummaryInstructions: next })}
              />
            }
          />
        </>
      );
    case "factory":
      return (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["factoryPromptTemplate"]}
            {...searchableSetting("factory-prompt-template")}
            description="The first message of a factory task. {{input}} stands for the task input."
            resetAction={
              settings.factoryPromptTemplate !== DEFAULT_UNIFIED_SETTINGS.factoryPromptTemplate ? (
                <SettingResetButton
                  label="factory prompt template"
                  onClick={() =>
                    updateSettings({
                      factoryPromptTemplate: DEFAULT_UNIFIED_SETTINGS.factoryPromptTemplate,
                    })
                  }
                />
              ) : null
            }
            control={
              <PromptTemplateField
                label="Factory prompt template"
                value={settings.factoryPromptTemplate}
                onCommit={(next) => updateSettings({ factoryPromptTemplate: next })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["factoryTokenSaving"]}
            {...searchableSetting("factory-token-saving")}
            description="Keep watching pull requests and CI, but hold CI fixes, review replies, and rebases until you start them from the Factory page."
            resetAction={
              settings.factoryTokenSaving !== DEFAULT_UNIFIED_SETTINGS.factoryTokenSaving ? (
                <SettingResetButton
                  label="factory token saving"
                  onClick={() =>
                    updateSettings({
                      factoryTokenSaving: DEFAULT_UNIFIED_SETTINGS.factoryTokenSaving,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["factoryTokenSaving"]}
                checked={settings.factoryTokenSaving}
                onCheckedChange={(checked) =>
                  updateSettings({ factoryTokenSaving: Boolean(checked) })
                }
                aria-label="Factory token saving"
              />
            }
          />
          <SettingsRow
            {...searchableSetting("factory-pull-request-opens-in-browser")}
            description="Open a factory task's pull request in the browser instead of the thread's panel."
            resetAction={
              settings.factoryPullRequestOpensInBrowser !==
              DEFAULT_UNIFIED_SETTINGS.factoryPullRequestOpensInBrowser ? (
                <SettingResetButton
                  label="factory pull request target"
                  onClick={() =>
                    updateSettings({
                      factoryPullRequestOpensInBrowser:
                        DEFAULT_UNIFIED_SETTINGS.factoryPullRequestOpensInBrowser,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.factoryPullRequestOpensInBrowser}
                onCheckedChange={(checked) =>
                  updateSettings({ factoryPullRequestOpensInBrowser: Boolean(checked) })
                }
                aria-label="Open factory pull requests in the browser"
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["factoryIgnoreCiEnabled"]}
            {...searchableSetting("factory-ignore-ci-enabled")}
            description="Show Ignore CI on the Factory page. While active, CI results do not trigger fixes or block review stages. Disabling this setting restores CI handling."
            control={
              <ScopedSwitch
                settingKeys={["factoryIgnoreCiEnabled"]}
                checked={settings.factoryIgnoreCiEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({
                    factoryIgnoreCiEnabled: Boolean(checked),
                    ...(!checked ? { factoryIgnoreCi: false } : {}),
                  })
                }
                aria-label="Enable Ignore CI in Code Factory"
              />
            }
            resetAction={
              settings.factoryIgnoreCiEnabled ? (
                <SettingResetButton
                  label="Enable Ignore CI"
                  onClick={() =>
                    updateSettings({ factoryIgnoreCiEnabled: false, factoryIgnoreCi: false })
                  }
                />
              ) : null
            }
          />
        </>
      );
    case "desktop":
      return (
        <>
          <OverlaySettings />
          <QuickRepliesSettings />
        </>
      );
    case "about":
      return <UpstreamReleaseSection />;
  }
}
