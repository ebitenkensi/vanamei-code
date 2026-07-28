import { AnthropicPlugin } from "./provider/anthropic"
import { OpenAIPlugin } from "./provider/openai"
import { OpencodePlugin } from "./provider/opencode"
import { OpenAICompatiblePlugin } from "./provider/openai-compatible"
import { DynamicProviderPlugin } from "./provider/dynamic"
import type { PluginInternal } from "./internal"
import type { Scope } from "effect"

export const ProviderPlugins: PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>[] = [
  AnthropicPlugin,
  OpencodePlugin,
  OpenAIPlugin,
  OpenAICompatiblePlugin,
  DynamicProviderPlugin,
]
