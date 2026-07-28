import { AnthropicPlugin } from "./provider/anthropic"
import { OpenAIPlugin } from "./provider/openai"
import { OpencodePlugin } from "./provider/opencode"
import type { PluginInternal } from "./internal"
import type { Scope } from "effect"

export const ProviderPlugins: PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>[] = [
  AnthropicPlugin,
  OpencodePlugin,
  OpenAIPlugin,
]
