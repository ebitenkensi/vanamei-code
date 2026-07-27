// Shared responsive width policy
//
// Dialogs still switch on a single breakpoint. The statusline instead packs a
// measured right-hand zone: segments are dropped whole, lowest priority first,
// until the composed text fits the columns left over by the identity and
// status zones. Character-level truncation is deliberately avoided -- the
// flexbox `truncate` it replaces used to leave meaningless fragments like
// "◆ 78% ·... · $1.52" or "again to inte...%t·".

const NARROW_DIALOG_WIDTH = 80

// Two columns between groups, one inside a group: the eye reads the metrics,
// the model, and each key hint as separate clusters without any separator
// glyph doing the work.
const GROUP_GAP = 2
const ITEM_GAP = 1

export type StatuslineGroup = "metrics" | "model" | "background" | "command"

export type StatuslineSegment = {
  key: string
  text: string
  group: StatuslineGroup
  // Drop order: the lowest surviving priority goes first when the zone
  // overflows. Statusline callers own the actual ranking.
  priority: number
}

export function footerWidthPolicy(width: number) {
  return {
    dialog: {
      narrow: width < NARROW_DIALOG_WIDTH,
    },
  }
}

export function statuslineGap(previous: StatuslineSegment | undefined, segment: StatuslineSegment): string {
  if (!previous) {
    return ""
  }

  return " ".repeat(previous.group === segment.group ? ITEM_GAP : GROUP_GAP)
}

export function statuslineWidth(segments: StatuslineSegment[]): number {
  return segments.reduce(
    (total, segment, index) => total + statuslineGap(segments[index - 1], segment).length + segment.text.length,
    0,
  )
}

export function fitStatusline<T extends StatuslineSegment>(segments: T[], available: number): T[] {
  const kept = [...segments]
  while (kept.length > 0 && statuslineWidth(kept) > available) {
    kept.splice(kept.indexOf(kept.reduce((weakest, item) => (item.priority < weakest.priority ? item : weakest))), 1)
  }

  return kept
}
