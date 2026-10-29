import { BitSafeGeneralSettings } from "./BitSafeGeneralSettings";
import { BitSafeSettingsViewContext } from "./bitsafeSettingCatalog";
import { StorageSettingsPanel } from "./StorageSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function BitSafeSettings() {
  return (
    <BitSafeSettingsViewContext value={true}>
      <SettingsPageContainer>
        <SettingsSection title="Code factory">
          <BitSafeGeneralSettings section="factory" />
        </SettingsSection>
        <SettingsSection title="General">
          <BitSafeGeneralSettings section="organization" />
          <BitSafeGeneralSettings section="behavior" />
          <BitSafeGeneralSettings section="desktop" />
          <BitSafeGeneralSettings section="text-generation" />
          <BitSafeGeneralSettings section="about" />
        </SettingsSection>
        <StorageSettingsPanel bitsafeOnly />
      </SettingsPageContainer>
    </BitSafeSettingsViewContext>
  );
}
