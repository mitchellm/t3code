import { type Loadout, ProviderInstanceId } from "@t3tools/contracts";
import { withSolo } from "@t3tools/shared/loadouts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import {
  draftLaunchLoadout,
  pickLoadout,
  readDraftLoadoutChoice,
  setDraftLoadoutChoice,
} from "./draftLoadout";

const judged: Loadout = {
  id: "judged",
  name: "Judged",
  description: "A worker and a judge.",
  roles: {
    worker: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5-5" },
    judge: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  },
};
const loadouts = withSolo([judged]);

describe("draft loadout", () => {
  it("carries the pick made on a draft into that draft's launch and no other", () => {
    const picked = DraftId.make("draft-picked");
    const untouched = DraftId.make("draft-untouched");
    setDraftLoadoutChoice(picked, pickLoadout(readDraftLoadoutChoice(picked), "judged"));

    expect(draftLaunchLoadout(readDraftLoadoutChoice(picked), loadouts)).toEqual({
      threadLoadout: { id: "judged", reason: null, setBy: "user" },
      active: judged,
    });
    expect(draftLaunchLoadout(readDraftLoadoutChoice(untouched), loadouts)).toEqual({
      threadLoadout: null,
      active: loadouts[0],
    });

    setDraftLoadoutChoice(picked, null);
    expect(readDraftLoadoutChoice(picked)).toBeNull();
  });

  it("re-picking what runs changes nothing unless the agent chose it; Solo after a pick is kept", () => {
    expect(pickLoadout(null, "solo")).toBeNull();
    const chosen = pickLoadout(null, "judged");
    expect(pickLoadout(chosen, "judged")).toBe(chosen);
    expect(pickLoadout(chosen, "solo")).toEqual({ id: "solo", reason: null, setBy: "user" });
    expect(pickLoadout({ id: "judged", reason: "big task", setBy: "agent" }, "judged")).toEqual(
      chosen,
    );
  });

  it("launches solo when the picked loadout was deleted since, as the picker then shows", () => {
    expect(draftLaunchLoadout({ id: "deleted", reason: null, setBy: "user" }, loadouts)).toEqual({
      threadLoadout: null,
      active: loadouts[0],
    });
  });
});
