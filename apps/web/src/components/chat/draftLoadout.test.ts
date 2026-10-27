import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  type Loadout,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { withSolo } from "@t3tools/shared/loadouts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  draftLaunchLoadout,
  pickLoadout,
  readDraftLoadoutChoice,
  setDraftLoadoutChoice,
  shownLoadoutChoice,
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

  it("drops a pick once its draft is gone, whether sent or discarded", () => {
    const projectRef = scopeProjectRef(EnvironmentId.make("env-cleanup"), ProjectId.make("p"));
    const sent = DraftId.make("draft-sent");
    const kept = DraftId.make("draft-kept");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, sent, { threadId: ThreadId.make("thread-sent") });
    setDraftLoadoutChoice(sent, pickLoadout(null, "judged"));
    // A second project, so the first draft is not replaced as the project's draft.
    store.setProjectDraftThreadId(
      scopeProjectRef(EnvironmentId.make("env-cleanup"), ProjectId.make("q")),
      kept,
      { threadId: ThreadId.make("thread-kept") },
    );
    setDraftLoadoutChoice(kept, pickLoadout(null, "judged"));

    store.clearDraftThread(sent);

    expect(readDraftLoadoutChoice(sent)).toBeNull();
    expect(readDraftLoadoutChoice(kept)).toEqual({ id: "judged", reason: null, setBy: "user" });
  });

  it("shows a draft's pick until its new thread carries a loadout, then the thread's own", () => {
    const pick = { id: "judged", reason: null, setBy: "user" } as const;
    const set = { id: "other", reason: null, setBy: "user" } as const;
    expect(shownLoadoutChoice({ shell: null, draftChoice: pick, sending: false })).toBe(pick);
    // Created, its loadout not yet set: the send is still in flight.
    expect(shownLoadoutChoice({ shell: { loadout: null }, draftChoice: pick, sending: true })).toBe(
      pick,
    );
    expect(shownLoadoutChoice({ shell: { loadout: set }, draftChoice: pick, sending: true })).toBe(
      set,
    );
    // A send that failed between the two steps left a thread with no loadout: it runs Solo.
    expect(
      shownLoadoutChoice({ shell: { loadout: null }, draftChoice: pick, sending: false }),
    ).toBeNull();
  });

  it("launches solo when the picked loadout was deleted since, as the picker then shows", () => {
    expect(draftLaunchLoadout({ id: "deleted", reason: null, setBy: "user" }, loadouts)).toEqual({
      threadLoadout: null,
      active: loadouts[0],
    });
  });
});
