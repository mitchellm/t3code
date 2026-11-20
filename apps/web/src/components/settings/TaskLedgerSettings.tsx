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
      description="Agents write their plan as a ledger of your asks before they change files, and are kept going while items are open. Measured on single fixes of up to 40 minutes it cost about a fifth more without changing how often the work was right, so a project of small changes can turn it off; loadouts with roles or a judge always use it."
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
