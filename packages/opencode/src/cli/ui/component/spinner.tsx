import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { registerOpencodeSpinner } from "./register-spinner"

registerOpencodeSpinner()

const _frames = ["·", "✢", "✳", "✶", "✻", "✽"] as const
export const SPINNER_FRAMES = [..._frames, ..._frames.slice().reverse()]

export function Spinner(props: { children?: JSX.Element; color?: RGBA; textColor?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  const textColor = () => props.textColor ?? color()
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={textColor()}>● {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={textColor()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
