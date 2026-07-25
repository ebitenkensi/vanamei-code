// Shared responsive width policy

const FOOTER_WIDTH_BREAKPOINTS = {
  compact: 80,
  commandHint: 66,
  // Info-pill tiers (P3). As width shrinks, pills drop in priority order
  // modified -> todos -> monitor -> cost, keeping ctx% around the longest --
  // it only disappears once the whole pill row hides below `compact`, same
  // as the old raw-usage string did.
  pillsCost: 90,
  pillsMonitor: 95,
  pillsTodos: 105,
  pillsModified: 120,
  model: 120,
  spacious: 150,
} as const

export function footerWidthPolicy(width: number) {
  const compact = width >= FOOTER_WIDTH_BREAKPOINTS.compact
  const model = width >= FOOTER_WIDTH_BREAKPOINTS.model
  const spacious = width >= FOOTER_WIDTH_BREAKPOINTS.spacious

  return {
    dialog: {
      narrow: !compact,
    },
    statusline: {
      showPills: compact,
      showCommandHint: width >= FOOTER_WIDTH_BREAKPOINTS.commandHint,
      showContextHints: compact,
      contextHintLimit: !compact ? 0 : spacious ? undefined : model ? 2 : 1,
      showModel: model,
      pills: {
        cost: width >= FOOTER_WIDTH_BREAKPOINTS.pillsCost,
        monitor: width >= FOOTER_WIDTH_BREAKPOINTS.pillsMonitor,
        todos: width >= FOOTER_WIDTH_BREAKPOINTS.pillsTodos,
        modified: width >= FOOTER_WIDTH_BREAKPOINTS.pillsModified,
      },
    },
  }
}
