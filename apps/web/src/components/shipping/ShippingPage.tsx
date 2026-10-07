import {
  DEFAULT_SERVER_SETTINGS,
  type PullRequestMergeMethod,
  type PullRequestRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  readableFailure,
} from "../pullRequest/pullRequestDetail.logic";
import {
  claimPullRequestHostRefresh,
  pullRequestHostRefreshKey,
} from "../pullRequest/pullRequestHostRefresh";
import { PullRequestActorLabel } from "../pullRequest/pullRequestPresentation";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  buildReviewRequestMessage,
  collectShippingItems,
  groupShippingReviews,
  SHIPPING_PROBLEM_LABELS,
  type ShippingItem,
} from "./shipping.logic";

function referenceOf(item: ShippingItem): PullRequestRef {
  return {
    projectId: item.thread.projectId,
    host: item.link.host,
    repository: item.link.repository,
    number: item.link.number,
  };
}

/** Every open, ready pull request linked to a thread, sorted by what it waits on. */
export function ShippingPage() {
  useEscapeToGoBack();
  const navigate = useNavigate();
  const threads = useThreadShells();
  const { settleThread } = useThreadActions();
  const items = useMemo(() => collectShippingItems(threads), [threads]);
  const readyToMerge = items.filter((item) => item.category === "ready-to-merge");
  const reviewGroups = useMemo(() => groupShippingReviews(items), [items]);
  const waiting = items.filter((item) => item.category === "waiting");
  const actionNeeded = items.filter((item) => item.category === "action-needed");

  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  // The snapshots here come from the server's background sync; reading each pull request from
  // the host again also asks that sync to rewrite them.
  const refreshAll = async (force: boolean) => {
    const due = items.filter(
      (item) =>
        force ||
        claimPullRequestHostRefresh(
          pullRequestHostRefreshKey({ environmentId: item.thread.environmentId, ...item.link }),
        ),
    );
    if (due.length === 0) return;
    setRefreshing(true);
    try {
      await Promise.all(
        due.map((item) =>
          invalidate({
            environmentId: item.thread.environmentId,
            input: { reference: referenceOf(item) },
          }),
        ),
      );
    } finally {
      setRefreshing(false);
    }
  };
  const refreshOnArrival = useEffectEvent(() => void refreshAll(false));
  const itemsLoaded = items.length > 0;
  useEffect(() => {
    refreshOnArrival();
  }, [itemsLoaded]);

  const openThread = (item: ShippingItem) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(item.thread.environmentId, item.thread.id)),
    });
  };

  const copyRequest = async (group: ReadonlyArray<ShippingItem>) => {
    try {
      await writeTextToClipboard(buildReviewRequestMessage(group), "review request");
      toastManager.add({ type: "success", title: "Review request copied" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to copy review request",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Shipping breadcrumb" className="min-w-0 flex-1">
              <WorkspaceBreadcrumbItem current>
                <h1>Shipping</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <Button
              onClick={() => void refreshAll(true)}
              aria-label="Refresh pull requests"
              aria-busy={refreshing}
              disabled={refreshing || items.length === 0}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open pull requests are linked to your threads.
              </p>
            ) : (
              <div className="flex flex-col gap-8">
                <ShippingSection title="Ready to merge" count={readyToMerge.length}>
                  {readyToMerge.map((item) => (
                    <ShippingRow key={item.link.url} item={item} onOpen={openThread}>
                      <MergeButtons item={item} settleThread={settleThread} />
                    </ShippingRow>
                  ))}
                </ShippingSection>

                <ShippingSection
                  title="Ready for review"
                  count={reviewGroups.reduce((total, group) => total + group.items.length, 0)}
                >
                  {reviewGroups.map((group) => (
                    <div
                      key={group.reviewer?.login ?? ""}
                      className="flex flex-col rounded-lg border border-border/60"
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-sm">
                        {group.reviewer ? (
                          <PullRequestActorLabel actor={group.reviewer} />
                        ) : (
                          <span className="font-medium text-muted-foreground">No reviewer</span>
                        )}
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => copyRequest(group.items)}
                        >
                          <CopyIcon aria-hidden className="size-3.5" />
                          Copy request
                        </Button>
                      </div>
                      {group.items.map((item) => (
                        <ShippingRow key={item.link.url} item={item} onOpen={openThread}>
                          {item.category === "ready-for-re-review" ? (
                            <Badge variant="info">Re-review</Badge>
                          ) : null}
                        </ShippingRow>
                      ))}
                    </div>
                  ))}
                </ShippingSection>

                <ShippingSection title="Waiting on checks" count={waiting.length}>
                  {waiting.map((item) => (
                    <ShippingRow key={item.link.url} item={item} onOpen={openThread} />
                  ))}
                </ShippingSection>

                <ShippingSection title="Action needed" count={actionNeeded.length}>
                  {actionNeeded.map((item) => (
                    <ShippingRow key={item.link.url} item={item} onOpen={openThread}>
                      {item.problems.map((problem) => (
                        <Badge
                          key={problem}
                          variant={
                            problem === "conflicts" || problem === "checks-failing"
                              ? "error"
                              : "warning"
                          }
                        >
                          {SHIPPING_PROBLEM_LABELS[problem]}
                        </Badge>
                      ))}
                    </ShippingRow>
                  ))}
                </ShippingSection>
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function ShippingSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">
        {title} <span className="text-muted-foreground tabular-nums">{count}</span>
      </h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

/** One pull request; the row opens its thread, and the controls on the right act on it. */
function ShippingRow({
  item,
  onOpen,
  children,
}: {
  item: ShippingItem;
  onOpen: (item: ShippingItem) => void;
  children?: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(item);
        }
      }}
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-3 py-2 outline-none",
        "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <PullRequestGlyph.pullRequest aria-hidden className="size-4 shrink-0 text-success" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">
          <span className="text-muted-foreground tabular-nums">#{item.link.number}</span>{" "}
          {item.snapshot.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {item.link.repository} · {item.thread.title}
        </span>
      </div>
      {children ? (
        // Controls act on the pull request, so a press on them must not also open the thread.
        <div
          className="flex shrink-0 items-center gap-1.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function MergeButtons({
  item,
  settleThread,
}: {
  item: ShippingItem;
  settleThread: ReturnType<typeof useThreadActions>["settleThread"];
}) {
  const environmentConfigs = useServerConfigs();
  const lastSelectedMergeMethod = useUiStateStore((state) => state.pullRequestMergeMethod);
  const method: PullRequestMergeMethod =
    resolveProjectSettings(
      environmentConfigs.get(item.thread.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
      item.thread.projectId,
    ).settings.pullRequestMergeMethod ?? lastSelectedMergeMethod;
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [confirming, setConfirming] = useState<"merge" | "merge-settle" | null>(null);
  const [pending, setPending] = useState(false);

  const merge = async (settle: boolean) => {
    setPending(true);
    const result = await runAction({
      environmentId: item.thread.environmentId,
      input: { ...referenceOf(item), action: "merge", mergeMethod: method },
    });
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not merge #${item.link.number}`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "Check the pull request on the host for what still blocks it.",
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: `Merged #${item.link.number}` });
    if (settle) await settleThread(scopeThreadRef(item.thread.environmentId, item.thread.id));
  };

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={() => setConfirming("merge-settle")}
      >
        Merge & settle thread
      </Button>
      <Button size="xs" disabled={pending} onClick={() => setConfirming("merge")}>
        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        {pending ? "Merging..." : "Merge"}
      </Button>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "merge-settle"
                ? "Merge pull request and settle thread?"
                : "Merge pull request?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {`This merges #${item.link.number} using ${PULL_REQUEST_MERGE_METHOD_LABELS[method].toLowerCase()}.`}
              {confirming === "merge-settle" ? ` Then it settles "${item.thread.title}".` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              onClick={() => {
                const settle = confirming === "merge-settle";
                setConfirming(null);
                void merge(settle);
              }}
            >
              {confirming === "merge-settle" ? "Merge & settle" : "Merge"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
