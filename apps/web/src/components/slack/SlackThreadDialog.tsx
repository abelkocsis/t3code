import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { parseSlackThreadUrl, type ScopedThreadRef, type SlackThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs, useThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * Which threads have the Slack dialog open. Set by the sidebar menu or the pull-request panel and
 * rendered once by the app layout, so a menu that closes on click cannot take the dialog with it.
 */
const slackThreadDialogAtom = Atom.make<ReadonlyArray<ScopedThreadRef> | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("slack:thread-dialog"),
);

export function openSlackThreadDialog(threadRefs: ReadonlyArray<ScopedThreadRef>): void {
  if (threadRefs.length > 0) appAtomRegistry.set(slackThreadDialogAtom, threadRefs);
}

/** Whether a thread's server can store a Slack link at all. */
export function useSupportsSlackThreads(): (threadRef: ScopedThreadRef) => boolean {
  const configs = useServerConfigs();
  return (threadRef) =>
    configs.get(threadRef.environmentId)?.environment.capabilities.threadSlackThreads === true;
}

export function SlackThreadDialogHost() {
  const threadRefs = useAtomValue(slackThreadDialogAtom);
  if (threadRefs === null) return null;
  return (
    <SlackThreadDialog
      threadRefs={threadRefs}
      onClose={() => appAtomRegistry.set(slackThreadDialogAtom, null)}
    />
  );
}

function SlackThreadDialog({
  threadRefs,
  onClose,
}: {
  threadRefs: ReadonlyArray<ScopedThreadRef>;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const shells = useThreadShells();
  const current = useMemo(() => {
    const keys = new Set(threadRefs.map(scopedThreadKey));
    return shells
      .filter((shell) => keys.has(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))))
      .map((shell) => shell.slackThread ?? null);
  }, [shells, threadRefs]);
  // Prefilled only when every selected thread already points at the same message.
  const shared =
    current.length > 0 && current.every((link) => link?.url === current[0]?.url)
      ? (current[0] ?? null)
      : null;
  const anyLinked = current.some((link) => link !== null);
  const [value, setValue] = useState(shared?.url ?? "");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const setSlackThread = useAtomCommand(threadEnvironment.setSlackThread, { reportFailure: false });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const parsed = parseSlackThreadUrl(value);

  const apply = async (slackThread: SlackThreadRef | null) => {
    setPending(true);
    setSubmitError(null);
    const results = await Promise.all(
      threadRefs.map((threadRef) =>
        setSlackThread({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, slackThread },
        }),
      ),
    );
    setPending(false);
    if (results.some((result) => result._tag === "Failure")) {
      setSubmitError(
        slackThread ? "Could not link the Slack thread." : "Could not unlink the Slack thread.",
      );
      return;
    }
    onClose();
  };

  const submit = () => {
    setDirty(true);
    if (parsed !== null) void apply(parsed);
  };

  const validation =
    dirty && parsed === null ? "Paste a Slack message link (Slack → Copy link)." : null;
  const count = threadRefs.length;

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link Slack thread</DialogTitle>
          <DialogDescription>
            {count === 1 ? "This thread's" : `These ${count} threads'`} pull requests are grouped
            under this Slack thread on the Shipping page, and re-review requests are posted there as
            replies.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder="https://team.slack.com/archives/C0123ABC/p1700000000123456"
            value={value}
            onChange={(event) => {
              setDirty(true);
              setValue(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
          />
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {anyLinked ? (
            <Button
              type="button"
              variant="destructive-outline"
              size="sm"
              disabled={pending}
              onClick={() => void apply(null)}
            >
              Unlink
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={pending || parsed === null} onClick={submit}>
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
