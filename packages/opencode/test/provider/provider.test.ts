import { afterEach, expect, test } from "bun:test"
import { mkdir, unlink } from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped, TestInstance } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { Filesystem } from "@/util/filesystem"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const originalEnv = new Map<string, string | undefined>()

const rememberEnv = (k: string) => {
  if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
}

const setProcessEnv = (k: string, v: string) =>
  Effect.sync(() => {
    rememberEnv(k)
    process.env[k] = v
  })

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

const remove = (k: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    delete process.env[k]
    yield* Env.use.remove(k)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const providerLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelsDev.node,
      RuntimeFlags.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const list = Provider.use.list()

const paid = (providers: Record<string, { models: Record<string, { cost: { input: number } }> }>) => {
  const item = providers[ProviderV2.ID.make("opencode")]
  expect(item).toBeDefined()
  return Object.values(item.models).filter((model) => model.cost.input > 0).length
}

const languageBaseURL = (language: unknown) => (language as { config: { baseURL: string } }).config.baseURL

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
const experimentalModels = testEffect(providerLayer({ enableExperimentalModels: true }))

const alphaProviderConfig = {
  provider: {
    "custom-provider": {
      name: "Custom Provider",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.custom.com/v1",
      models: {
        "active-model": {
          name: "Active Model",
        },
        "alpha-model": {
          name: "Alpha Model",
          status: "alpha" as const,
        },
      },
      options: {
        apiKey: "custom-key",
      },
    },
  },
}

it.instance("provider loaded from env variable", () =>
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    // Provider should retain its connection source even if custom loaders
    // merge additional options.
    expect(providers[ProviderV2.ID.anthropic].source).toBe("env")
    expect(providers[ProviderV2.ID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
  }),
)

it.instance(
  "provider loaded from config with apiKey option",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
  }),
  { config: { provider: { anthropic: { options: { apiKey: "config-api-key" } } } } },
)

it.instance(
  "disabled_providers excludes provider",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeUndefined()
  }),
  { config: { disabled_providers: ["anthropic"] } },
)

it.instance(
  "enabled_providers restricts to only listed providers",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    yield* setProcessEnv("OPENAI_API_KEY", "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
  }),
  { config: { enabled_providers: ["anthropic"] } },
)

it.instance(
  "model whitelist filters models for provider",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).toContain("claude-sonnet-4-20250514")
    expect(models.length).toBe(1)
  }),
  { config: { provider: { anthropic: { whitelist: ["claude-sonnet-4-20250514"] } } } },
)

it.instance(
  "model blacklist excludes specific models",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).not.toContain("claude-sonnet-4-20250514")
  }),
  { config: { provider: { anthropic: { blacklist: ["claude-sonnet-4-20250514"] } } } },
)

it.instance(
  "custom model alias via config",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].models["my-alias"]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].models["my-alias"].name).toBe("My Custom Alias")
  }),
  {
    config: {
      provider: {
        anthropic: { models: { "my-alias": { id: "claude-sonnet-4-20250514", name: "My Custom Alias" } } },
      },
    },
  },
)

it.instance(
  "custom provider with npm package",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].name).toBe("Custom Provider")
    expect(providers[ProviderV2.ID.make("custom-provider")].models["custom-model"]).toBeDefined()
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          env: ["CUSTOM_API_KEY"],
          models: {
            "custom-model": {
              name: "Custom Model",
              tool_call: true,
              limit: { context: 128000, output: 4096 },
            },
          },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)

it.instance(
  "filters alpha provider models by default",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")].models["active-model"]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].models["alpha-model"]).toBeUndefined()
  }),
  { config: alphaProviderConfig },
)

experimentalModels.instance(
  "includes alpha provider models when experimental models are enabled",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")].models["active-model"]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].models["alpha-model"]).toBeDefined()
  }),
  { config: alphaProviderConfig },
)

it.instance(
  "custom DeepSeek openai-compatible model defaults interleaved reasoning field",
  Effect.gen(function* () {
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("custom-provider")]
    expect(provider.models["deepseek-r1"].capabilities.interleaved).toEqual({ field: "reasoning_content" })
    expect(provider.models["deepseek-details"].capabilities.interleaved).toEqual({ field: "reasoning_details" })
    expect(provider.models["custom-model"].capabilities.interleaved).toBe(false)
    expect(
      providers[ProviderV2.ID.make("custom-anthropic-provider")].models["deepseek-r1"].capabilities.interleaved,
    ).toBe(false)
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          models: {
            "deepseek-r1": { name: "DeepSeek R1" },
            "deepseek-details": { name: "DeepSeek Details", interleaved: { field: "reasoning_details" } },
            "custom-model": { name: "Custom Model" },
          },
          options: { apiKey: "custom-key" },
        },
        "custom-anthropic-provider": {
          name: "Custom Anthropic Provider",
          npm: "@ai-sdk/anthropic",
          api: "https://api.custom.com/v1",
          models: { "deepseek-r1": { name: "DeepSeek R1" } },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)

it.instance(
  "env variable takes precedence, config merges options",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "env-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    // Config options should be merged
    expect(providers[ProviderV2.ID.anthropic].options.timeout).toBe(60000)
    expect(providers[ProviderV2.ID.anthropic].options.headerTimeout).toBe(10000)
    expect(providers[ProviderV2.ID.anthropic].options.chunkTimeout).toBe(15000)
  }),
  { config: { provider: { anthropic: { options: { timeout: 60000, headerTimeout: 10000, chunkTimeout: 15000 } } } } },
)

it.instance("getModel returns model for valid provider/model", () =>
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-4-20250514"))
    expect(model).toBeDefined()
    expect(String(model.providerID)).toBe("anthropic")
    expect(String(model.id)).toBe("claude-sonnet-4-20250514")
    const language = yield* provider.getLanguage(model)
    expect(language).toBeDefined()
  }),
)

it.instance("getModel throws ModelNotFoundError for invalid model", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const exit = yield* Provider.use
      .getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("nonexistent-model"))
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

it.instance("getModel throws ModelNotFoundError for invalid provider", () =>
  Effect.gen(function* () {
    const exit = yield* Provider.use
      .getModel(ProviderV2.ID.make("nonexistent-provider"), ModelV2.ID.make("some-model"))
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

// Pure synchronous unit tests — no Effect runtime needed.

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(String(result.providerID)).toBe("anthropic")
  expect(String(result.modelID)).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(String(result.providerID)).toBe("openrouter")
  expect(String(result.modelID)).toBe("anthropic/claude-3-opus")
})

it.instance("defaultModel returns first available model when no config set", () =>
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.defaultModel()
    expect(model.providerID).toBeDefined()
    expect(model.modelID).toBeDefined()
  }),
)

it.instance(
  "defaultModel respects config model setting",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.defaultModel()
    expect(String(model.providerID)).toBe("anthropic")
    expect(String(model.modelID)).toBe("claude-sonnet-4-20250514")
  }),
  { config: { model: "anthropic/claude-sonnet-4-20250514" } },
)

it.instance(
  "defaultModel treats empty provider config as no allowlist",
  Effect.gen(function* () {
    yield* setProcessEnv("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.defaultModel()
    expect(model.providerID).toBeDefined()
    expect(model.modelID).toBeDefined()
  }),
  { config: { provider: {} } },
)

it.instance(
  "defaultModel returns a typed error when config excludes every provider",
  Effect.gen(function* () {
    const error = yield* Provider.use.defaultModel().pipe(Effect.flip)
    expect(error).toBeInstanceOf(Provider.NoProvidersError)
    expect(error._tag).toBe("ProviderNoProvidersError")
  }),
  { config: { enabled_providers: [] } },
)

it.instance(
  "provider with baseURL from config",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-openai")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-openai")].options.baseURL).toBe("https://custom.openai.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-openai": {
          name: "Custom OpenAI",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "gpt-4": { name: "GPT-4", tool_call: true, limit: { context: 128000, output: 4096 } } },
          options: { apiKey: "test-key", baseURL: "https://custom.openai.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "model cost defaults to zero when not specified",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.cost.input).toBe(0)
    expect(model.cost.output).toBe(0)
    expect(model.cost.cache.read).toBe(0)
    expect(model.cost.cache.write).toBe(0)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "test-model": { name: "Test Model", tool_call: true, limit: { context: 128000, output: 4096 } } },
          options: { apiKey: "test-key" },
        },
      },
    },
  },
)

it.instance(
  "model options are merged from existing model",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.options.customOption).toBe("custom-value")
  }),
  {
    config: {
      provider: {
        anthropic: {
          options: { apiKey: "test-api-key" },
          models: { "claude-sonnet-4-20250514": { options: { customOption: "custom-value" } } },
        },
      },
    },
  },
)

it.instance(
  "provider removed when all models filtered out",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeUndefined()
  }),
  { config: { provider: { anthropic: { options: { apiKey: "test-api-key" }, whitelist: ["nonexistent-model"] } } } },
)

it.instance("closest finds model by partial match", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const result = yield* Provider.use.closest(ProviderV2.ID.anthropic, ["sonnet-4"])
    expect(result).toBeDefined()
    expect(String(result?.providerID)).toBe("anthropic")
    expect(String(result?.modelID)).toContain("sonnet-4")
  }),
)

it.instance("closest returns undefined for nonexistent provider", () =>
  Effect.gen(function* () {
    const result = yield* Provider.use.closest(ProviderV2.ID.make("nonexistent"), ["model"])
    expect(result).toBeUndefined()
  }),
)

it.instance(
  "getModel uses realIdByKey for aliased models",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic].models["my-sonnet"]).toBeDefined()

    const model = yield* Provider.use.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("my-sonnet"))
    expect(model).toBeDefined()
    expect(String(model.id)).toBe("my-sonnet")
    expect(model.name).toBe("My Sonnet Alias")
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { "my-sonnet": { id: "claude-sonnet-4-20250514", name: "My Sonnet Alias" } },
        },
      },
    },
  },
)

it.instance(
  "provider api field sets model api.url",
  Effect.gen(function* () {
    const providers = yield* list
    // api field is stored on model.api.url, used by getSDK to set baseURL
    expect(providers[ProviderV2.ID.make("custom-api")].models["model-1"].api.url).toBe("https://api.example.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-api": {
          name: "Custom API",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.example.com/v1",
          env: [],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test-key" },
        },
      },
    },
  },
)

it.instance(
  "explicit baseURL overrides api field",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-api")].options.baseURL).toBe("https://custom.override.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-api": {
          name: "Custom API",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.example.com/v1",
          env: [],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test-key", baseURL: "https://custom.override.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "model inherits properties from existing database model",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.name).toBe("Custom Name for Sonnet")
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.attachment).toBe(true)
    expect(model.limit.context).toBeGreaterThan(0)
  }),
  {
    config: {
      provider: { anthropic: { models: { "claude-sonnet-4-20250514": { name: "Custom Name for Sonnet" } } } },
    },
  },
)

it.instance(
  "disabled_providers prevents loading even with env var",
  Effect.gen(function* () {
    yield* set("OPENAI_API_KEY", "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
  }),
  { config: { disabled_providers: ["openai"] } },
)

it.instance(
  "enabled_providers with empty array allows no providers",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    yield* set("OPENAI_API_KEY", "test-openai-key")
    const providers = yield* list
    expect(Object.keys(providers).length).toBe(0)
  }),
  { config: { enabled_providers: [] } },
)

it.instance(
  "whitelist and blacklist can be combined",
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).toContain("claude-sonnet-4-20250514")
    expect(models).not.toContain("claude-opus-4-20250514")
    expect(models.length).toBe(1)
  }),
  {
    config: {
      provider: {
        anthropic: {
          whitelist: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
          blacklist: ["claude-opus-4-20250514"],
        },
      },
    },
  },
)

it.instance(
  "model modalities default correctly",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.capabilities.input.text).toBe(true)
    expect(model.capabilities.output.text).toBe(true)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "test-model": { name: "Test Model", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "model with custom cost values",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.cost.input).toBe(5)
    expect(model.cost.output).toBe(15)
    expect(model.cost.cache.read).toBe(2.5)
    expect(model.cost.cache.write).toBe(7.5)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-model": {
              name: "Test Model",
              tool_call: true,
              limit: { context: 8000, output: 2000 },
              cost: { input: 5, output: 15, cache_read: 2.5, cache_write: 7.5 },
            },
          },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance("getSmallModel returns appropriate small model", () =>
  Effect.gen(function* () {
    yield* set("ANTHROPIC_API_KEY", "test-api-key")
    const model = yield* Provider.use.getSmallModel(ProviderV2.ID.anthropic)
    expect(model).toBeDefined()
    expect(model?.id).toContain("haiku")
  }),
)


