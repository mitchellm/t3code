import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function PlanBeforeEditingSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      serverScoped
      settingKeys={["planBeforeEditing"]}
      {...searchableSetting("plan-before-editing")}
      description="Claude threads refuse a file edit until the agent has written its plan as a ledger. Turning this off removes that check; every agent is still asked to plan before editing."
      resetAction={
        settings.planBeforeEditing !== DEFAULT_UNIFIED_SETTINGS.planBeforeEditing ? (
          <SettingResetButton
            label="plan before editing"
            onClick={() =>
              updateSettings({ planBeforeEditing: DEFAULT_UNIFIED_SETTINGS.planBeforeEditing })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["planBeforeEditing"]}
          checked={settings.planBeforeEditing}
          onCheckedChange={(checked) => updateSettings({ planBeforeEditing: Boolean(checked) })}
          aria-label="Plan before editing"
        />
      }
    />
  );
}
