import {
  PROVIDER_SWITCH_DRIVER_KINDS,
  ThreadId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { useEnvironments } from "../state/environments";
import { useThreadShell } from "../state/entities";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { newThreadId } from "../lib/utils";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
} from "../providerInstances";
import { TaskModelPicker } from "./factory/TaskModelPicker";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";

interface Request {
  readonly threadRef: ScopedThreadRef;
  /** A factory task stays on the Factory page; a thread opens the new thread. */
  readonly surface: "thread" | "factory";
  /** The provider the user already chose, for example in the composer picker. */
  readonly initialInstanceId?: ProviderInstanceId;
}
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Opens the model, effort, and provider dialog for a thread or a factory task. */
export function openProviderSwitchDialog(request: Request): void {
  useRequest.setState({ request });
}

const close = () => useRequest.setState({ request: null });

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
};

/** True when the thread's provider takes part in provider switches. */
export function canSwitchProvider(driverKind: string | null | undefined): boolean {
  return driverKind != null && PROVIDER_SWITCH_DRIVER_KINDS.includes(driverKind);
}

export interface ProviderSwitchLink {
  readonly direction: "in" | "from";
  readonly threadId: ThreadId;
  readonly provider: string;
}

/** The thread's newest provider switch, read from the rows the server appends on both threads. */
export function latestProviderSwitchLink(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderSwitchLink | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    const direction =
      activity.kind === "thread.provider-switch.continued-in"
        ? "in"
        : activity.kind === "thread.provider-switch.continued-from"
          ? "from"
          : null;
    if (direction === null) continue;
    const payload = activity.payload as { threadId?: unknown; provider?: unknown } | null;
    if (typeof payload?.threadId !== "string" || payload.threadId.length === 0) continue;
    return {
      direction,
      threadId: ThreadId.make(payload.threadId),
      provider: typeof payload.provider === "string" ? payload.provider : "another provider",
    };
  }
  return null;
}

export function ProviderSwitchDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => close, []);
  return request ? <ProviderSwitchDialog request={request} /> : null;
}

function ProviderSwitchDialog({ request }: { request: Request }) {
  const id = useId();
  const navigate = useNavigate();
  const thread = useThreadShell(request.threadRef);
  const { environments } = useEnvironments();
  const providers =
    environments.find(
      (environment) => environment.environmentId === request.threadRef.environmentId,
    )?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const [selection, setSelection] = useState<ModelSelection | null>(() => {
    if (request.initialInstanceId === undefined) return null;
    const model = getDefaultProviderInstanceModel(providers, request.initialInstanceId);
    return model ? { instanceId: request.initialInstanceId, model } : null;
  });
  const [settleChoice, setSettleChoice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<ScopedThreadRef | null>(null);
  const switchProvider = useAtomCommand(threadEnvironment.switchProvider, {
    reportFailure: false,
  });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  // The new thread's row lands once the server has built it. A jump made
  // before that reads the thread as missing, so the jump waits for the row.
  const pendingShell = useThreadShell(pendingSwitch);
  useEffect(() => {
    if (pendingSwitch === null || pendingShell === null) return;
    close();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(pendingSwitch),
    });
  }, [navigate, pendingShell, pendingSwitch]);

  if (thread === null) return null;
  const current = thread.modelSelection;
  const picked = selection ?? current;
  const entries = deriveProviderInstanceEntries(providers);
  const driverOf = (instanceId: string) =>
    entries.find((entry) => entry.instanceId === instanceId)?.driverKind ?? null;
  const switching = picked.instanceId !== current.instanceId;
  const switchable = canSwitchProvider(driverOf(current.instanceId));
  const busy = thread.session?.status === "running" || thread.session?.status === "starting";
  // A hidden factory task has no sidebar row to come back to, so it always settles.
  const hiddenTask = thread.factory != null && thread.factory.showInSidebar !== true;
  const settleSource = hiddenTask || settleChoice;
  const targetLabel =
    entries.find((entry) => entry.instanceId === picked.instanceId)?.displayName ??
    "the new provider";

  const submit = async () => {
    setError(null);
    if (!switching) {
      const result = await updateMetadata({
        environmentId: request.threadRef.environmentId,
        input: { threadId: thread.id, modelSelection: picked },
      });
      if (result._tag === "Failure") {
        setError(failureMessage(result, "Could not change the model."));
        return;
      }
      close();
      return;
    }
    const nextThreadId = newThreadId();
    const result = await switchProvider({
      environmentId: request.threadRef.environmentId,
      input: {
        threadId: thread.id,
        newThreadId: nextThreadId,
        modelSelection: picked,
        title: thread.title,
        settleSource,
      },
    });
    if (result._tag === "Failure") {
      setError(failureMessage(result, "Could not switch providers."));
      return;
    }
    if (request.surface === "factory") {
      close();
      return;
    }
    setPendingSwitch(scopeThreadRef(request.threadRef.environmentId, nextThreadId));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change model and effort</DialogTitle>
          <DialogDescription>
            {switchable
              ? "Pick another model or effort. You can also pick another provider."
              : "Pick another model or effort."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <TaskModelPicker
              environmentId={request.threadRef.environmentId}
              project={null}
              value={picked}
              onChange={setSelection}
              {...(switchable
                ? { driverKinds: PROVIDER_SWITCH_DRIVER_KINDS }
                : { driverKinds: [driverOf(current.instanceId) ?? ""] })}
            />
            {switching ? (
              <>
                <Alert variant="warning">
                  <AlertDescription>
                    A new thread with {targetLabel} continues this task, in the same worktree and
                    branch. The new provider has no cache of this conversation. Its first turn reads
                    the full history, so it costs more tokens than a normal turn.
                  </AlertDescription>
                </Alert>
                {hiddenTask ? (
                  <p className="text-muted-foreground text-sm">
                    The old thread settles, because it is not in the sidebar.
                  </p>
                ) : (
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id={`${id}-settle`}
                      checked={settleChoice}
                      onCheckedChange={(checked) => setSettleChoice(checked === true)}
                    />
                    <div className="flex flex-col gap-0.5">
                      <Label htmlFor={`${id}-settle`}>Settle the old thread</Label>
                      {settleChoice ? null : (
                        <p className="text-muted-foreground text-xs">
                          The old thread gets a message that another session now does this task.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : null}
            {busy && switching ? (
              <p className="text-muted-foreground text-sm">
                Stop the running turn before you switch providers.
              </p>
            ) : null}
            {pendingSwitch !== null ? (
              <p className="text-muted-foreground text-sm">
                Creating the new thread. If it fails, the old thread shows why.
              </p>
            ) : null}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={(busy && switching) || pendingSwitch !== null}
            onClick={() => void submit()}
          >
            {switching ? "Switch provider" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
