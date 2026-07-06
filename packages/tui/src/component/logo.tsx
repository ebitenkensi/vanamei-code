import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"

export function Logo() {
  const { theme } = useTheme()

  return (
    <box
      width={58}
      flexDirection="column"
      alignItems="center"
      gap={1}
      paddingTop={1}
      paddingBottom={1}
      border
      borderStyle="rounded"
      borderColor={theme.primary}
    >
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        Welcome to VanameiCode
      </text>
      <text fg={theme.textMuted}>Type a message to begin</text>
    </box>
  )
}
