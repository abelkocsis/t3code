import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  folderHeaderMarker,
  folderIdOfMarker,
  folderIdOfSection,
  folderPlaceholderMarker,
  resolveSidebarDropTarget,
  sidebarFolderSection,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const hidden = { ...stationary, scaleY: 0 };
type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
type Layout = Parameters<SortingStrategy>[0];
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "snoozed-header" ||
    item.marker === "settled-header");

/** Keep the lifted card below the Pins label, including when Pins is empty.
 * The container rect follows scrolling; the offset is measured once at pickup. */
export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

interface SlotRect {
  readonly top: number;
  readonly bottom: number;
}

/**
 * The slot a drop at `y` lands on inside a folder, or null outside them all.
 *
 * Each folder owns the band its heading and rows occupy, plus half of the
 * gap to each neighbour, so the bands tile the list. Without that, a few
 * pixels of movement drop into a seam and the target flaps between the
 * folder and the inbox while the preview shifts rows around.
 */
export interface FolderBandHit {
  readonly slotId: string;
  readonly top: number;
  readonly bottom: number;
}

export function folderSlotAtY(
  items: readonly SidebarListItem[],
  rects: { readonly get: (id: string) => SlotRect | undefined },
  y: number,
): FolderBandHit | null {
  const measured = items.flatMap((item) => {
    const id = sidebarListItemId(item);
    const rect = rects.get(id);
    return rect === undefined ? [] : [{ item, id, rect }];
  });
  for (const [index, entry] of measured.entries()) {
    if (entry.item.kind !== "marker") continue;
    const folderId = folderIdOfMarker(entry.item.marker);
    if (folderId === null || !entry.item.marker.startsWith("folder-header:")) continue;
    let last = index;
    const slotIds: string[] = [];
    for (let next = index + 1; next < measured.length; next += 1) {
      const candidate = measured[next]!;
      const belongs =
        candidate.item.kind === "thread"
          ? folderIdOfSection(candidate.item.section) === folderId
          : candidate.item.kind === "marker" &&
            folderIdOfMarker(candidate.item.marker) === folderId;
      if (!belongs) break;
      slotIds.push(candidate.id);
      last = next;
    }
    const top = measured[index - 1]?.rect.bottom;
    const bottom = measured[last + 1]?.rect.top;
    const bandTop = top === undefined ? entry.rect.top : (top + entry.rect.top) / 2;
    const bandBottom =
      bottom === undefined
        ? measured[last]!.rect.bottom
        : (measured[last]!.rect.bottom + bottom) / 2;
    if (y < bandTop || y > bandBottom) continue;
    const under = slotIds.find((id) => {
      const rect = rects.get(id);
      return rect !== undefined && y >= rect.top && y <= rect.bottom;
    });
    return { slotId: under ?? slotIds[0] ?? entry.id, top: bandTop, bottom: bandBottom };
  }
  return null;
}

/** Reject the nearest unsupported target without selecting another section.
 * Recreate this detector when drop eligibility changes. */
export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  let heldFolder: FolderBandHit | null = null;
  return (args) => {
    let collisions = closestCenter(args);
    const pointer = args.pointerCoordinates;
    const items = options.items;
    // Folder slots are claimed by the pointer, not by the nearest centre: a
    // folder sits between rows, so a card's centre is usually over a
    // neighbour while the pointer is plainly on the folder.
    if (items && pointer) {
      // Live rects, not the ones measured at pickup: the preview opens the
      // drag labels above the folders, which slides them down the screen.
      // The divider gesture below reads the DOM for the same reason.
      const liveRects = {
        get: (id: string) => {
          const node = args.droppableContainers.find((container) => container.id === id)?.node
            .current;
          const rect =
            typeof node?.getBoundingClientRect === "function"
              ? node.getBoundingClientRect()
              : undefined;
          return rect ?? args.droppableRects.get(id);
        },
      };
      // The lifted card decides, not the cursor: the card is what the user
      // sees over the folder, and the cursor sits wherever the drag happened
      // to start inside it, which on a tall card is most of a row away.
      const cardCenter = args.collisionRect.top + args.collisionRect.height / 2;
      // Claiming a folder makes the preview open space inside it, which moves
      // the band the claim was based on, which drops the claim, which closes
      // the space again. The band is therefore held relative to the pinned
      // divider: that row sits above every folder, so it follows real layout
      // shifts while the folder's own growth cannot move it.
      const dividerRect = liveRects.get(sidebarMarkerId("pinned-divider"));
      const dividerTop = dividerRect?.top ?? 0;
      // The pinned block is reached with the cursor, not the card: the card
      // is clamped below the Pinned label, so its centre can never rise into
      // the pins. Above the divider the cursor decides and folders stand
      // aside; below it the card decides, which is what the user sees.
      const abovePins = pointer.y <= (dividerRect?.bottom ?? dividerTop);
      const held =
        heldFolder === null
          ? null
          : {
              slotId: heldFolder.slotId,
              top: dividerTop + heldFolder.top,
              bottom: dividerTop + heldFolder.bottom,
            };
      const hit = abovePins
        ? null
        : held !== null && cardCenter >= held.top && cardCenter <= held.bottom
          ? held
          : folderSlotAtY(items, liveRects, cardCenter);
      heldFolder =
        hit === null
          ? null
          : { slotId: hit.slotId, top: hit.top - dividerTop, bottom: hit.bottom - dividerTop };
      const folderId = hit?.slotId ?? null;
      if (folderId !== null && folderId !== String(args.active.id)) {
        const valid = validity.get(folderId) ?? isValidTarget(folderId);
        validity.set(folderId, valid);
        if (valid) {
          const existing = collisions.find((collision) => String(collision.id) === folderId);
          return [
            existing ?? { id: folderId, data: {} },
            ...collisions.filter((collision) => String(collision.id) !== folderId),
          ];
        }
      }
    }
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find((container) => container.id === sidebarMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // Use the visible divider row, including its sortable translation.
      // Only pointer movement can change sections: opening the destination
      // moves this row, but must not toggle a stationary gesture back.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        const nextHeader = (["working-header", "snoozed-header", "settled-header"] as const)
          .map((marker) =>
            args.droppableContainers.find((container) => container.id === sidebarMarkerId(marker)),
          )
          .find((container) => container !== undefined);
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveSidebarDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

/** Preview the committed section layout without moving or mounting DOM nodes.
 * A zero scaleY marks rows/markers to hide while retaining their measured nodes. */
export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  settledOrder: readonly string[];
  /** Time-ordered inbox (Working beta): where the lifted row would land. */
  activeOrder?: readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  cardHeight?: number;
  slimHeight?: number;
  /** Space each pinned boundary opens for its label while dragging. The
   * markers stay zero height at rest, so nothing is reserved until pickup. */
  boundaryLabelHeight?: number;
}): SortingStrategy {
  const { items } = input;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];

  function project({ rects, activeIndex, overIndex }: Layout) {
    const active = items[activeIndex];
    const over = items[overIndex] ?? active;
    if (active?.kind !== "thread" || !over || !rects[0]) return [];
    const target = resolveSidebarDropTarget(items, active.key, sidebarListItemId(over));
    if (!target) return [];
    // One bucket per section, folders included: a folder is a section here
    // too, so the preview needs no rule of its own.
    const groups: Record<string, ThreadItem[]> = {
      pinned: [],
      active: [],
      working: [],
      snoozed: [],
      settled: [],
    };
    const folderSections: SidebarSection[] = [];
    for (const item of items) {
      if (item.kind !== "marker") continue;
      const folderId = folderIdOfMarker(item.marker);
      if (folderId === null || !item.marker.startsWith("folder-header:")) continue;
      const section = sidebarFolderSection(folderId);
      groups[section] = [];
      folderSections.push(section);
    }
    let cardHeight = input.cardHeight;
    let slimHeight = input.slimHeight;
    let headerScale: number | undefined;
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (isShelfHeader(item) || item.marker.startsWith("folder-header:")) {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        continue;
      }
      if (
        item.section === "pinned" ||
        item.section === "active" ||
        item.section === "working" ||
        folderIdOfSection(item.section) !== null
      ) {
        cardHeight ??= rects[index]?.height;
      } else slimHeight ??= rects[index]?.height;
      if (item.key !== active.key) (groups[item.section] ??= []).push(item);
    }
    // Cards are 4.875rem + 0.25rem padding; slim rows/placeholders are h-9.
    const scale =
      slimHeight !== undefined ? slimHeight / 36 : (headerScale ?? (cardHeight ?? 82) / 82);
    cardHeight ??= 82 * scale;
    slimHeight ??= 36 * scale;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const group = (groups[target.section] ??= []);
    const order =
      target.section === "pinned"
        ? target.pinnedOrder
        : target.section === "settled"
          ? input.settledOrder
          : folderIdOfSection(target.section) !== null
            ? // A folder keeps no arranged order: the row joins the end.
              group.map((item) => item.key)
            : (input.activeOrder ?? target.activeOrder);
    const ranks = new Map(order.map((key, index) => [key, index]));
    const rank = ranks.get(active.key) ?? Number.POSITIVE_INFINITY;
    const index = group.findIndex(
      (item) => (ranks.get(item.key) ?? Number.POSITIVE_INFINITY) > rank,
    );
    group.splice(index < 0 ? group.length : index, 0, { ...active, section: target.section });
    const settledOrder = (
      input.settledOrder.length > 0
        ? input.settledOrder
        : (groups.settled ?? []).map((item) => item.key)
    ).filter((key) => key !== active.key || target.section === "settled");
    const visible = input.settledExpanded
      ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
      : [];
    const routeKey = input.routeThreadKey;
    if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
      visible.push(routeKey);
    }
    groups.settled = visible.map((key) => ({ kind: "thread", key, section: "settled" }));
    const folderRows = (section: string) => groups[section] ?? [];
    const projected: SidebarListItem[] = [];
    const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
    const section = (name: "active" | "settled") => {
      const rows = groups[name] ?? [];
      if (rows.length > 0) projected.push(...rows);
      else marker(name === "active" ? "active-placeholder" : "settled-placeholder");
    };
    marker("pinned-header");
    projected.push(...(groups.pinned ?? []));
    marker("pinned-divider");
    for (const folderSection of folderSections) {
      const folderId = folderIdOfSection(folderSection);
      if (folderId === null) continue;
      marker(folderHeaderMarker(folderId));
      const rows = folderRows(folderSection);
      if (rows.length > 0) projected.push(...rows);
      else marker(folderPlaceholderMarker(folderId));
    }
    section("active");
    if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
      marker("working-header");
      projected.push(...groups.working);
    }
    if (
      (groups.snoozed ?? []).length > 0 ||
      ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
        items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
    ) {
      marker("snoozed-header");
      projected.push(...(groups.snoozed ?? []));
    }
    marker("settled-header");
    section("settled");
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback =
        item.kind === "thread" &&
        (item.section === "pinned" || item.section === "active" || item.section === "working")
          ? cardHeight
          : slimHeight;
      const moved = item.kind === "thread" && item.key === active.key;
      return item.kind === "marker" &&
        (item.marker === "pinned-header" || item.marker === "pinned-divider")
        ? labelHeight
        : item.kind === "marker" && item.marker.includes("placeholder")
          ? slimHeight
          : moved
            ? fallback
            : (rect?.height ?? fallback);
    });
    const firstShelf = items.findIndex(isShelfHeader);
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[firstShelf - 1];
    const lastRect = rects.at(-1);
    // Consume the shelf's auto margin as drag labels and resized rows need
    // room, keeping the combined shelves at their measured bottom.
    let shelfSpace =
      shelfRect && beforeShelf && lastRect && shelfRect.top > beforeShelf.bottom + 1
        ? Math.max(
            0,
            lastRect.bottom - rects[0].top - heights.reduce((sum, height) => sum + height + 1, -1),
          )
        : 0;
    const result = items.map(() => hidden);
    let top = rects[0].top;
    for (const [projectedIndex, item] of projected.entries()) {
      if (isShelfHeader(item)) {
        top += shelfSpace;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += heights[projectedIndex]! + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}
