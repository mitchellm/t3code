import { normalizeThreadFolder } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { parseFolderMenuAction, type ThreadActionMenuId } from "./threadActionMenu.logic";

type Request = { readonly resolve: (folder: string | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a folder path. Resolves the normalized path, or null when the user cancels. */
function requestThreadFolder(): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
}

/**
 * Turns a "Move to folder" menu click into the folder to set, or null when there is nothing to
 * do (the user cancelled the new-folder dialog, or the click was not a folder choice).
 */
export async function resolveThreadFolderChoice(
  action: ThreadActionMenuId,
): Promise<{ readonly folder: string | null } | null> {
  const parsed = parseFolderMenuAction(action);
  if (parsed === null) return null;
  if (parsed.kind === "path") return { folder: parsed.path };
  if (parsed.kind === "none") return { folder: null };
  const created = await requestThreadFolder();
  return created === null ? null : { folder: created };
}

function finish(folder: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(folder);
}

export function ThreadFolderDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending folder request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <ThreadFolderDialog /> : null;
}

function ThreadFolderDialog() {
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const folder = normalizeThreadFolder(value);
            if (folder === null) {
              setError("Enter a folder name.");
              return;
            }
            finish(folder);
          }}
        >
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Use / to nest it, like Update 82/Prototypes. The thread moves into it, and the folder
              stays while a thread is in it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex flex-col items-stretch" htmlFor={`${id}-folder`}>
              Folder
              <Input
                nativeInput
                autoFocus
                id={`${id}-folder`}
                className="h-9 sm:h-8"
                value={value}
                placeholder="Update 82/Prototypes"
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
              />
            </Label>
            {error && (
              <p role="alert" className="mt-2 text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Move</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
