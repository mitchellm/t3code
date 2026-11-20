import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function AskCheckSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      serverScoped
      settingKeys={["askCheck"]}
      {...searchableSetting("ask-check")}
      description="Before a thread without a judge closes its last ask, a fresh session on the same model checks the result against what you wrote and sends back anything still missing."
      resetAction={
        settings.askCheck !== DEFAULT_UNIFIED_SETTINGS.askCheck ? (
          <SettingResetButton
            label="check finished work against your message"
            onClick={() => updateSettings({ askCheck: DEFAULT_UNIFIED_SETTINGS.askCheck })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["askCheck"]}
          checked={settings.askCheck}
          onCheckedChange={(checked) => updateSettings({ askCheck: Boolean(checked) })}
          aria-label="Check finished work against your message"
        />
      }
    />
  );
}
