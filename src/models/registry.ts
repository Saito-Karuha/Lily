import { readFile } from "node:fs/promises";
import {
	type Api,
	type AuthContext,
	createModels,
	createProvider,
	defaultProviderAuthContext,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Model,
	type MutableModels,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CustomProviderConfig, LilyConfig } from "./config.ts";

/** Auth that reads only environment variables unless ambient host credentials are explicitly allowed. */
function authContext(config: LilyConfig): AuthContext {
	const base = defaultProviderAuthContext();
	if (config.allowAmbientCredentials) return base;
	return { env: base.env, fileExists: async () => false };
}

const API_IMPLEMENTATIONS: Record<CustomProviderConfig["api"], () => ProviderStreams> = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
};

export function customProvider(id: string, config: CustomProviderConfig) {
	const models: Model<Api>[] = config.models.map((m) => ({
		id: m.id,
		name: m.name ?? m.id,
		api: config.api,
		provider: id,
		baseUrl: config.baseUrl,
		reasoning: m.reasoning ?? false,
		input: m.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? 32_768,
		maxTokens: m.maxTokens ?? 8192,
		...(m.samplingParams ? { samplingParams: m.samplingParams } : {}),
		...(config.headers ? { headers: config.headers } : {}),
	}));
	return createProvider({
		id,
		baseUrl: config.baseUrl,
		auth: {
			apiKey: {
				name: `${id} API key`,
				resolve: async ({ ctx }) => {
					const key = config.apiKeyEnv ? await ctx.env(config.apiKeyEnv) : undefined;
					if (config.apiKeyEnv && !key) return undefined;
					return { auth: { apiKey: key ?? "none" }, source: config.apiKeyEnv ?? "keyless" };
				},
			},
		},
		models,
		api: API_IMPLEMENTATIONS[config.api](),
	});
}

/** One scripted assistant turn for the offline `scripted/<name>` provider. */
export interface ScriptedTurn {
	text?: string;
	thinking?: string;
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/**
 * Builds the model registry: pi-ai's built-in providers (keys from environment
 * variables), custom endpoints from config, and optional scripted providers.
 */
export function buildModels(config: LilyConfig): MutableModels {
	const models = createModels({ authContext: authContext(config) });
	for (const provider of builtinProviders()) models.setProvider(provider);
	for (const [id, provider] of Object.entries(config.providers ?? {})) models.setProvider(customProvider(id, provider));
	return models;
}

/** Registers `scripted/<name>` that replays turns from a JSON file — for demos and end-to-end tests. */
export async function registerScriptedProvider(models: MutableModels, name: string, scriptPath: string) {
	const turns = JSON.parse(await readFile(scriptPath, "utf8")) as ScriptedTurn[];
	const handle = fauxProvider({
		provider: "scripted",
		models: [{ id: name, name: `Scripted: ${name}`, contextWindow: 128_000, maxTokens: 16_384 }],
		tokensPerSecond: 400,
	});
	handle.setResponses(turns.map(scriptedMessage));
	models.setProvider(handle.provider);
	return handle;
}

export function scriptedMessage(turn: ScriptedTurn) {
	const blocks = [
		...(turn.thinking ? [{ type: "thinking" as const, thinking: turn.thinking }] : []),
		...(turn.text ? [fauxText(turn.text)] : []),
		...(turn.toolCalls ?? []).map((call) => fauxToolCall(call.name, call.arguments as never)),
	];
	return fauxAssistantMessage(blocks, { stopReason: turn.toolCalls?.length ? "toolUse" : "stop" });
}
