import { type AskCheckPolicy, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const POLICY_NAMES: Record<AskCheckPolicy, string> = {
  v1: "Keep trying",
  v2: "Up to three checks",
};

const policyLabel = (policy: AskCheckPolicy) =>
  policy === DEFAULT_UNIFIED_SETTINGS.askCheckPolicy
    ? `${POLICY_NAMES[policy]} (default)`
    : POLICY_NAMES[policy];

export function AskCheckPolicySettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["askCheckPolicy"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["askCheckPolicy"]}
      {...searchableSetting("ask-check-policy")}
      description={
        mixed
          ? "The selected targets use different policies."
          : "What happens when the check of finished work fails. Up to three checks: after the second the thread moves to the checker's model, after the third the agent stops and reports. A task keeps the policy it started with."
      }
      resetAction={
        settings.askCheckPolicy !== DEFAULT_UNIFIED_SETTINGS.askCheckPolicy ? (
          <SettingResetButton
            label="when a check fails"
            onClick={() =>
              updateSettings({ askCheckPolicy: DEFAULT_UNIFIED_SETTINGS.askCheckPolicy })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.askCheckPolicy}
          onValueChange={(value) => {
            if (value === "v1" || value === "v2") updateSettings({ askCheckPolicy: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-72" aria-label="When a check fails">
            <SelectValue>
              {(value: AskCheckPolicy | null) => (value === null ? "Mixed" : policyLabel(value))}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="v2">
              {policyLabel("v2")}
            </SelectItem>
            <SelectItem hideIndicator value="v1">
              {policyLabel("v1")}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
