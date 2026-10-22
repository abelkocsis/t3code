import { THREAD_FOLDER_NAME_MAX_LENGTH } from "@t3tools/contracts";
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

export interface FolderNameRequest {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly initialValue?: string;
  /** Names already in use, so a duplicate is refused before the write. */
  readonly takenNames?: ReadonlyArray<string>;
}

type Request = FolderNameRequest & { readonly resolve: (name: string | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Resolves with a trimmed folder name, or null when the user cancels. */
export function requestFolderName(request: FolderNameRequest): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...request, resolve } }));
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function FolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <FolderNameDialog request={request} /> : null;
}

function FolderNameDialog({ request }: { readonly request: Request }) {
  const id = useId();
  const [value, setValue] = useState(request.initialValue ?? "");
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
            const name = value.trim();
            if (name.length === 0) {
              setError("Enter a folder name.");
              return;
            }
            if (name !== request.initialValue && request.takenNames?.includes(name)) {
              setError("A folder with that name already exists.");
              return;
            }
            finish(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
            <DialogDescription>{request.description}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-name`}>
              Folder name
              <Input
                nativeInput
                autoFocus
                id={`${id}-name`}
                value={value}
                maxLength={THREAD_FOLDER_NAME_MAX_LENGTH}
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
            <Button type="submit">{request.confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
