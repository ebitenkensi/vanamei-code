/** @jsxImportSource @opentui/solid */
import { createSignal, createEffect, onCleanup, Show, type Accessor } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { RGBA } from "@opentui/core"

// 6-glyph set forward then backward (skip endpoints) = 10 frames
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽"] as const
const FRAMES = [...GLYPHS, ...GLYPHS.slice(1, -1).reverse()]
/** @deprecated Use the Spinner component directly. Exported for legacy <spinner> element usage. */
export const SPINNER_FRAMES = [...GLYPHS, ...GLYPHS.slice().reverse()]
const GLYPH_MS = 120
const SHIMMER_MS = 50
const STALL_MS = 2000
const STALL_STEP = 50 / STALL_MS
const ERROR_RGB = [171, 43, 63] as const
const FALLBACK_TEXT_MUTED = RGBA.fromInts(120, 120, 120)

// --- inline color helpers (self-contained) ---

function toInts(color: RGBA | string): [number, number, number] {
  if (color instanceof RGBA) {
    const [r, g, b] = color.toInts()
    return [r, g, b]
  }
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  return [128, 128, 128]
}

function interpolateColor(a: RGBA, b: RGBA, t: number): RGBA {
  if (t <= 0) return a
  if (t >= 1) return b
  const [r1, g1, b1] = a.toInts()
  const [r2, g2, b2] = b.toInts()
  return RGBA.fromInts(
    Math.round(r1 + (r2 - r1) * t),
    Math.round(g1 + (g2 - g1) * t),
    Math.round(b1 + (b2 - b1) * t),
  )
}

function lighten(color: RGBA, amount: number): RGBA {
  const [r, g, b] = color.toInts()
  return RGBA.fromInts(
    Math.min(255, r + amount),
    Math.min(255, g + amount),
    Math.min(255, b + amount),
  )
}

// --- spinner component ---

export function Spinner(props: {
  message?: Accessor<string>
  mode?: Accessor<"requesting" | "responding" | "tool-use" | "thinking">
  stalled?: Accessor<boolean>
  color?: Accessor<RGBA>
  shimmerColor?: Accessor<RGBA>
  animationsEnabled?: Accessor<boolean>
}) {
  const themeCtx = (() => {
    try {
      return useTheme()
    } catch {
      return undefined
    }
  })()

  const animationsEnabled = (): boolean => {
    if (props.animationsEnabled !== undefined) return props.animationsEnabled()
    try {
      return useKV().get("animations_enabled", true)
    } catch {
      return true
    }
  }

  const baseColor = () => props.color?.() ?? themeCtx?.theme.textMuted ?? FALLBACK_TEXT_MUTED
  const shimBase = () => props.shimmerColor?.() ?? lighten(baseColor(), 30)

  const [frame, setFrame] = createSignal(0)
  const [shimPos, setShimPos] = createSignal(0)
  const [stallT, setStallT] = createSignal(0)
  const [pulse, setPulse] = createSignal(0)

  // glyph interval
  createEffect(() => {
    if (!animationsEnabled()) return
    const id = setInterval(() => setFrame((i) => (i + 1) % FRAMES.length), GLYPH_MS)
    onCleanup(() => clearInterval(id))
  })

  // shimmer interval
  createEffect(() => {
    if (!animationsEnabled()) return
    const id = setInterval(() => {
      const len = (props.message?.() ?? "").length
      if (len < 4) { setShimPos(0); return }
      const dir = props.mode?.() === "requesting" ? 1 : -1
      setShimPos((p) => {
        const n = p + dir
        if (n < 0) return len - 3
        if (n > len - 3) return 0
        return n
      })
    }, SHIMMER_MS)
    onCleanup(() => clearInterval(id))
  })

  // stall ramp interval
  createEffect(() => {
    if (!animationsEnabled()) return
    const id = setInterval(() => setStallT((t) => {
      const st = props.stalled?.() ?? false
      return st ? Math.min(1, t + STALL_STEP) : Math.max(0, t - STALL_STEP)
    }), 50)
    onCleanup(() => clearInterval(id))
  })

  // pulse clock (used for reduced-motion fallback; always runs)
  createEffect(() => {
    const id = setInterval(() => setPulse((t) => t + 1), 1000)
    onCleanup(() => clearInterval(id))
  })

  const errorRed = () => RGBA.fromInts(...ERROR_RGB)

  const glyphColor = () => {
    const t = stallT()
    return t <= 0 ? baseColor() : interpolateColor(baseColor(), errorRed(), t)
  }

  const shimColor = () => {
    const t = stallT()
    return t <= 0 ? shimBase() : interpolateColor(shimBase(), errorRed(), t)
  }

  const txt = () => props.message?.() ?? ""
  const animated = () => animationsEnabled()

  const parts = () => {
    const s = txt()
    if (s.length < 4) return { b: s, h: "", a: "" }
    const p = shimPos()
    return { b: s.slice(0, p), h: s.slice(p, p + 3), a: s.slice(p + 3) }
  }

  return (
    <box flexDirection="row" gap={1}>
      <text fg={glyphColor()}>
        {animated() ? FRAMES[frame()] : pulse() % 2 === 0 ? "○" : "●"}
      </text>
      <Show when={txt().length > 0}>
        <text>
          <span style={{ fg: glyphColor() }}>{parts().b}</span>
          <Show when={animated() && parts().h.length > 0}>
            <span style={{ fg: shimColor() }}>{parts().h}</span>
          </Show>
          <Show when={parts().a.length > 0}>
            <span style={{ fg: glyphColor() }}>{parts().a}</span>
          </Show>
        </text>
      </Show>
    </box>
  )
}
