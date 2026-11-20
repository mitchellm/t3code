import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function TaskLedgerSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      serverScoped
      settingKeys={["taskLedger"]}
      {...searchableSetting("task-ledger")}
      description="Off by default; turn it on and agents in this project plan as a ledger of your asks and keep going while items are open. Measured on single fixes of up to 40 minutes it cost about a fifth more and did not change how often the work was right, and loadouts with roles or a judge always use it."
      resetAction={
        settings.taskLedger !== DEFAULT_UNIFIED_SETTINGS.taskLedger ? (
          <SettingResetButton
            label="task ledger"
            onClick={() => updateSettings({ taskLedger: DEFAULT_UNIFIED_SETTINGS.taskLedger })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["taskLedger"]}
          checked={settings.taskLedger}
          onCheckedChange={(checked) => updateSettings({ taskLedger: Boolean(checked) })}
          aria-label="Task ledger"
        />
      }
    />
  );
}
