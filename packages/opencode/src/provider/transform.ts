import type { ModelMessage, ToolResultPart } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type * as Provider from "./provider"
import type * as ModelsDev from "@opencode-ai/core/models-dev"
import { iife } from "@/util/iife"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export const OUTPUT_TOKEN_MAX = 32_000

// OpenAI Responses `include` value that returns the encrypted reasoning state
// needed for stateless multi-turn reasoning (store: false). Hoisted so every
// branch that requests it stays in lockstep.
const INCLUDE_ENCRYPTED_REASONING = ["reasoning.encrypted_content"] as const

export function sanitizeSurrogates(content: string) {
  return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

// Maps npm package to the key the AI SDK expects for providerOptions
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/openai":
      return "openai"
    case "@ai-sdk/anthropic":
      return "anthropic"
  }
  return undefined
}

// TODO: fix this stupid inefficient dogshit function
function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  _options: Record<string, unknown>,
): ModelMessage[] {
  const sanitizeToolResultOutput = (content: ToolResultPart) => {
    if (content.output.type === "text" || content.output.type === "error-text") {
      content.output.value = sanitizeSurrogates(content.output.value)
    }
    if (content.output.type === "content") {
      content.output.value = content.output.value.map((item) => {
        if (item.type === "text") {
          item.text = sanitizeSurrogates(item.text)
        }
        return item
      })
    }
    return content
  }

  msgs = msgs.map((msg) => {
    switch (msg.role) {
      case "tool":
        if (!Array.isArray(msg.content)) return msg
        msg.content = msg.content.map((content) => {
          if (content.type === "tool-result") {
            return sanitizeToolResultOutput(content)
          }
          return content
        })
        return msg

      case "system":
        msg.content = sanitizeSurrogates(msg.content)
        return msg

      case "user":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text") {
              content.text = sanitizeSurrogates(content.text)
            }
            return content
          })
        }
        return msg

      case "assistant":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text" || content.type === "reasoning") {
              content.text = sanitizeSurrogates(content.text)
            }
            if (content.type === "tool-result") {
              return sanitizeToolResultOutput(content)
            }
            return content
          })
        }
        return msg
    }
  })

  // Anthropic rejects messages with empty content - filter out empty string messages
  // and remove empty text/reasoning parts from array content
  if (model.api.npm === "@ai-sdk/anthropic") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text") {
            return part.text !== ""
          }
          if (part.type === "reasoning") {
            return (
              part.text.trim().length > 0 ||
              part.providerOptions?.anthropic?.signature != null ||
              part.providerOptions?.anthropic?.redactedData != null
            )
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  if (model.api.id.includes("claude")) {
    const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
    msgs = msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      return msg
    })
  }

  if (
    typeof model.capabilities.interleaved === "object" &&
    model.capabilities.interleaved.field
  ) {
    const field = model.capabilities.interleaved.field
    return msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
        const reasoningText = reasoningParts.map((part: any) => part.text).join("")

        // Filter out reasoning parts from content
        const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

        // Include reasoning_content | reasoning_details directly on the message for all assistant messages.
        // Always set the field even when empty — some providers (e.g. DeepSeek) may return empty
        // reasoning_content which still needs to be sent back in subsequent requests.
        return {
          ...msg,
          content: filteredContent,
          providerOptions: {
            ...msg.providerOptions,
            openaiCompatible: {
              ...msg.providerOptions?.openaiCompatible,
              [field]: reasoningText,
            },
          },
        }
      }

      return msg
    })
  }

  return msgs
}

function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
  const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
  }

  for (const msg of unique([...system, ...final])) {
    const useMessageLevelOptions = model.providerID === "anthropic"
    const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        lastContent.type !== "tool-approval-request" &&
        lastContent.type !== "tool-approval-response"
      ) {
        lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image" ? String(part.image).split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

function mapProviderOptions(
  msgs: ModelMessage[],
  transform: (options: Record<string, any> | undefined) => Record<string, any> | undefined,
) {
  return msgs.map((msg) => {
    if (!Array.isArray(msg.content)) return { ...msg, providerOptions: transform(msg.providerOptions) }
    return {
      ...msg,
      providerOptions: transform(msg.providerOptions),
      content: msg.content.map((part) =>
        part.type === "tool-approval-request" || part.type === "tool-approval-response"
          ? part
          : { ...part, providerOptions: transform(part.providerOptions) },
      ),
    } as typeof msg
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  msgs = unsupportedParts(msgs, model)
  msgs = normalizeMessages(msgs, model, options)
  if (
    model.providerID === "anthropic" ||
    model.api.id.includes("anthropic") ||
    model.api.id.includes("claude") ||
    model.id.includes("anthropic") ||
    model.id.includes("claude") ||
    model.api.npm === "@ai-sdk/anthropic"
  ) {
    msgs = applyCaching(msgs, model)
  }

  // Remap providerOptions keys from stored providerID to expected SDK key
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    msgs = mapProviderOptions(msgs, remap)
  }

  // Strip Responses item IDs before serialization, following Codex and keeping signed request bodies immutable.
  if (options.store !== true && key && model.api.npm === "@ai-sdk/openai") {
    msgs = mapProviderOptions(msgs, (options) => {
      if (!options?.[key] || !("itemId" in options[key])) return options
      const metadata = { ...options[key] }
      delete metadata.itemId
      return { ...options, [key]: metadata }
    })
  }

  return msgs
}

export function temperature(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("claude")) return undefined
  if (id.includes("kimi-k2")) {
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

export function topP(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("kimi-k2.5") || id.includes("kimi-k2p5") || id.includes("kimi-k2-5")) {
    return 0.95
  }
  return undefined
}

export function topK(_model: Provider.Model) {
  return undefined
}

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS]
const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"]
const OPENAI_GPT5_PRO_EFFORTS = ["high"]
const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"]
const OPENAI_GPT5_CHAT_EFFORTS = ["medium"]
const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ["none", ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]

// OpenAI rolled out the `none` reasoning_effort tier on this date (Responses API).
// Models released before it 400 on `reasoning_effort: "none"`, so we only expose
// it as a variant for models new enough to accept it.
const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13"

// OpenAI rolled out the `xhigh` reasoning_effort tier on this date. Same reasoning.
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04"

// Matches members of the gpt-5 family across the id formats we encounter:
//   "gpt-5", "gpt-5-nano", "gpt-5.4", "openai/gpt-5.4-codex".
// Anchored to start-of-string or "/" so it doesn't false-match "gpt-50" or "gpt-5o".
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

function gpt5Version(apiId: string) {
  return Number(GPT5_VERSION_RE.exec(apiId)?.[1]) || undefined
}

function versionedGpt5ReasoningEfforts(apiId: string) {
  if (GPT5_VERSIONED_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
  const version = gpt5Version(apiId)
  if (version === undefined) return undefined
  if (version === 1) return OPENAI_GPT5_1_EFFORTS
  return OPENAI_GPT5_2_PLUS_EFFORTS
}

function gpt5CodexReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("codex")) return undefined
  const version = gpt5Version(apiId)
  if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
  if (apiId.includes("codex-max") || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
  return WIDELY_SUPPORTED_EFFORTS
}

function gpt5ChatReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("-chat")) return undefined
  return gpt5Version(apiId) === undefined ? [] : OPENAI_GPT5_CHAT_EFFORTS
}

  // Computes the reasoning_effort tiers an OpenAI model exposes. Effort order: weakest
  // to strongest.
  function openaiReasoningEfforts(apiId: string, releaseDate: string) {
  const id = apiId.toLowerCase()
  if (id.includes("deep-research")) return ["medium"]
  const chatEfforts = gpt5ChatReasoningEfforts(id)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  const codexEfforts = gpt5CodexReasoningEfforts(id)
  if (codexEfforts) return codexEfforts
  const versionedEfforts = versionedGpt5ReasoningEfforts(id)
  // GPT-5.1 replaced GPT-5's `minimal` effort with `none`; GPT-5.2+
  // additionally accepts `xhigh`. Model pages list the supported subset.
  if (versionedEfforts) return versionedEfforts
  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (GPT5_FAMILY_RE.test(id)) efforts.unshift("minimal")
  if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift("none")
  if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push("xhigh")
  return efforts
}


function anthropicOpus47OrLater(apiId: string) {
  // Greedy \d+ correctly extends to multi-digit majors (e.g. "claude-10.0-opus") for forward compatibility.
  const version = /opus-(\d+)[.-](\d+)(?:[.@-]|$)|claude-(\d+)[.-](\d+)-opus(?:[.@-]|$)/i.exec(apiId)
  if (!version) return false
  const major = Number(version[1] ?? version[3])
  const minor = Number(version[2] ?? version[4])
  return major > 4 || (major === 4 && minor >= 7)
}

function anthropicSonnet5OrLater(apiId: string) {
  const version = /sonnet-(\d+)(?:[.@-]|$)|claude-(\d+)-sonnet(?:[.@-]|$)/i.exec(apiId)
  if (!version) return false
  return Number(version[1] ?? version[2]) >= 5
}

function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  if (anthropicOpus47OrLater(apiId) || anthropicSonnet5OrLater(apiId) || apiId.includes("fable-5")) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (
    ["opus-4-6", "opus-4.6", "4-6-opus", "4.6-opus", "sonnet-4-6", "sonnet-4.6", "4-6-sonnet", "4.6-sonnet"].some((v) =>
      apiId.includes(v),
    )
  ) {
    return ["low", "medium", "high", "max"]
  }
  return null
}

function anthropicOmitsThinking(apiId: string) {
  return anthropicOpus47OrLater(apiId) || anthropicSonnet5OrLater(apiId) || apiId.includes("fable-5")
}


export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  const adaptiveThinkingOmitted = anthropicOmitsThinking(model.api.id)
  const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)

  switch (model.api.npm) {
    case "@ai-sdk/openai": {
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
      const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
      return Object.fromEntries(
        efforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: INCLUDE_ENCRYPTED_REASONING,
          },
        ]),
      )
    }

    case "@ai-sdk/openai-compatible": {
      // OpenAI-compatible chat endpoints expose reasoning_effort via providerOptions.
      // Keep the set of efforts conservative; exact tiers depend on the upstream model.
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]),
      )
    }

    case "@ai-sdk/anthropic": {
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              thinking: {
                type: "adaptive",
                ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}),
              },
              effort,
            },
          ]),
        )
      }

      if (["opus-4-5", "opus-4.5"].some((v) => model.api.id.includes(v))) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { effort }]))
      }

      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, model.limit.output - 1),
          },
        },
      }
    }
  }
  return {}
}

export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}): Record<string, any> {
  const result: Record<string, any> = {}

  // openai and providers using openai package should set store to false by default.
  if (input.model.providerID === "openai" || input.model.api.npm === "@ai-sdk/openai") {
    result["store"] = false
  }

  if (input.model.providerID === "openai" || input.providerOptions?.setCacheKey) {
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.api.npm === "@ai-sdk/anthropic" && !input.model.api.id.includes("claude")) {
    result["toolStreaming"] = false
  }

  const modelId = input.model.api.id.toLowerCase()

  if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
    if (!input.model.api.id.includes("gpt-5-pro")) {
      result["reasoningEffort"] = "medium"
      if (input.model.api.npm === "@ai-sdk/openai") {
        result["reasoningSummary"] = "auto"
        result["include"] = INCLUDE_ENCRYPTED_REASONING
      }
    }

    // Only set textVerbosity for non-chat gpt-5.x models
    // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
    if (
      input.model.api.id.includes("gpt-5.") &&
      !input.model.api.id.includes("codex") &&
      !input.model.api.id.includes("-chat")
    ) {
      result["textVerbosity"] = "low"
    }

    if (input.model.providerID.startsWith("opencode")) {
      result["promptCacheKey"] = input.sessionID
      result["include"] = INCLUDE_ENCRYPTED_REASONING
      result["reasoningSummary"] = "auto"
    }
  }

  return result
}

export function smallOptions(model: Provider.Model) {
  const small = Object.values(model.variants ?? {})[0] ?? {}
  if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") {
    const base = { store: false }
    return mergeDeep(base, small)
  }

  return small
}

export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  const usesOpenAIReasoningGate = model.api.npm === "@ai-sdk/openai"
  const normalized =
    usesOpenAIReasoningGate &&
    (model.capabilities.reasoning || options.reasoningEffort !== undefined || options.reasoningSummary !== undefined)
      ? { ...options, forceReasoning: true }
      : options

  // AI SDK packages that resolve providerOptionsName by splitting the
  // provider name on "." (e.g. "wafer.ai" -> "wafer") need the same
  // logic here so the key we write matches the key they read.
  const usesDotSplitOptions =
    model.api.npm === "@ai-sdk/openai-compatible" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/anthropic"
  const key = sdkKey(model.api.npm) ?? (usesDotSplitOptions ? model.providerID.split(".")[0] : model.providerID)
  return { [key]: normalized }
}

export function maxOutputTokens(model: Provider.Model, outputTokenMax = OUTPUT_TOKEN_MAX): number {
  return Math.min(model.limit.output, outputTokenMax) || outputTokenMax
}

type JsonRecord = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Mirrors Codex's Rust JSON schema compatibility lowering for OpenAI tool schemas.
function sanitizeOpenAISchema(value: unknown): unknown {
  const types = ["string", "number", "boolean", "integer", "object", "array", "null"]
  const compositionKeys = ["anyOf", "oneOf", "allOf"]

  // JSON Schema's boolean form (`true`/`false`) is unsupported by OpenAI tool schemas.
  if (typeof value === "boolean") return { type: "string" }
  if (Array.isArray(value)) return value.map(sanitizeOpenAISchema)
  if (!isPlainObject(value)) return value

  const result: JsonRecord = {}

  if (typeof value.$ref === "string") result.$ref = value.$ref
  if (typeof value.description === "string") result.description = value.description
  if ("const" in value) result.enum = [value.const]
  else if (Array.isArray(value.enum)) result.enum = value.enum

  if (isPlainObject(value.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, item]) => [key, sanitizeOpenAISchema(item)]),
    )
  }

  if (Array.isArray(value.required)) {
    result.required = value.required.filter((item) => typeof item === "string")
  }

  if ("items" in value) result.items = sanitizeOpenAISchema(value.items)

  if ("additionalProperties" in value) {
    result.additionalProperties =
      typeof value.additionalProperties === "boolean"
        ? value.additionalProperties
        : sanitizeOpenAISchema(value.additionalProperties)
  }

  for (const key of compositionKeys) {
    if (Array.isArray(value[key])) result[key] = value[key].map(sanitizeOpenAISchema)
  }

  for (const key of ["$defs", "definitions"]) {
    if (isPlainObject(value[key])) {
      result[key] = Object.fromEntries(
        Object.entries(value[key]).map(([name, item]) => [name, sanitizeOpenAISchema(item)]),
      )
    }
  }

  const schemaTypes =
    typeof value.type === "string"
      ? types.includes(value.type)
        ? [value.type]
        : []
      : Array.isArray(value.type)
        ? value.type.filter((item) => typeof item === "string" && types.includes(item))
        : []

  if (schemaTypes.length === 0 && (typeof result.$ref === "string" || compositionKeys.some((key) => key in result))) {
    return result
  }

  // MCP schemas may omit `type` while still using keywords that imply one.
  // Keep the schema usable after unsupported keywords are dropped.
  const inferredTypes =
    schemaTypes.length > 0
      ? schemaTypes
      : ["properties", "required", "additionalProperties"].some((key) => key in value)
        ? ["object"]
        : ["items", "prefixItems"].some((key) => key in value)
          ? ["array"]
          : "enum" in result || "format" in value
            ? ["string"]
            : ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in value)
              ? ["number"]
              : []

  if (inferredTypes.length === 0) return {}

  result.type = inferredTypes.length === 1 ? inferredTypes[0] : inferredTypes
  if (inferredTypes.includes("object") && !("properties" in result)) result.properties = {}
  if (inferredTypes.includes("array") && !("items" in result)) result.items = { type: "string" }
  return result
}

export function schema(model: Provider.Model, schema: JSONSchema7): JSONSchema7 {
  /*
  if (["openai", "azure"].includes(providerID)) {
    if (schema.type === "object" && schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (schema.required?.includes(key)) continue
        schema.properties[key] = {
          anyOf: [
            value as JSONSchema.JSONSchema,
            {
              type: "null",
            },
          ],
        }
      }
    }
  }
  */

  if (model.api.npm === "@ai-sdk/openai") {
    schema = sanitizeOpenAISchema(schema) as JSONSchema7
    // Codex also applies lossy compaction above 4 KB; defer that until OpenCode needs the same schema budget.
  }

  if (model.providerID === "moonshotai" || model.api.id.toLowerCase().includes("kimi")) {
    const sanitizeMoonshot = (obj: unknown): unknown => {
      if (obj === null || typeof obj !== "object") return obj
      if (Array.isArray(obj)) return obj.map(sanitizeMoonshot)
      // Moonshot expands $ref before validation and rejects sibling keywords like description on the same node.
      if ("$ref" in obj && typeof obj.$ref === "string") return { $ref: obj.$ref }
      const result = Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, sanitizeMoonshot(value)]))
      // MFJS does not support tuple-style `items` arrays; it requires one schema object for all array items.
      if (Array.isArray(result.items)) result.items = result.items[0] ?? {}
      return result
    }

    const sanitized = sanitizeMoonshot(schema)
    if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
      schema = sanitized
    }
  }

  return schema
}

export * as ProviderTransform from "./transform"
