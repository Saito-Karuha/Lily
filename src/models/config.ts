import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EnvironmentLimits } from "../env/types.ts";
import type { LilyHome } from "../store/home.ts";
import { readJsonIfExists, writeJsonAtomic } from "../util/fsx.ts";
import type { FirecrackerBackendOptions } from "../env/backends/firecracker.ts";

/** A custom model endpoint (e.g. a self-hosted vLLM / SGLang server). */
export interface CustomProviderConfig {
	/** pi-ai API implementation: "openai-completions" | "openai-responses" | "anthropic-messages". */
	api: "openai-completions" | "openai-responses" | "anthropic-messages";
	baseUrl: string;
	/** Environment variable holding the API key; omit for keyless local servers. */
	apiKeyEnv?: string;
	headers?: Record<string, string>;
	/**
	 * pi-ai compatibility settings for every model of this provider (e.g. for openai-completions
	 * `sendSessionAffinityHeaders`, `chatTemplateKwargs`, `supportsDeveloperRole`); a model's own
	 * `compat` keys override these.
	 */
	compat?: Record<string, unknown>;
	models: Array<{
		id: string;
		name?: string;
		contextWindow?: number;
		maxTokens?: number;
		reasoning?: boolean;
		input?: Array<"text" | "image">;
		samplingParams?: Record<string, unknown>;
		compat?: Record<string, unknown>;
	}>;
	/** Ask the engine for sampled token ids so exports can be token_exact. */
	tokenCapture?: "vllm";
}

export interface LilyConfig {
	/** Default model as "provider/model-id". */
	model?: string;
	thinking?: ThinkingLevel;
	/** Default resource bundle ref or digest (`@router` to route every run through `router`). */
	bundle?: string;
	/** ES module whose default export routes runs of `@router` sessions to bundles (path relative to LILY_HOME or absolute). */
	router?: string;
	providers?: Record<string, CustomProviderConfig>;
	environment?: {
		backend?: string;
		image?: string;
		limits?: EnvironmentLimits;
		/** Environments that may exist at once in one Lily process (default 16). */
		maxConcurrent?: number;
		/** Extra host paths the Seatbelt backend may read. */
		seatbeltReadPaths?: string[];
		/** Enables the Firecracker backend (Linux + KVM); see scripts/firecracker/README.md. */
		firecracker?: FirecrackerBackendOptions;
	};
	compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
	/** Allow provider auth to use ambient host credential files (gcloud ADC, AWS profiles). Default false. */
	allowAmbientCredentials?: boolean;
	server?: {
		port?: number;
		host?: string;
		/**
		 * Host directories the HTTP API may read host paths from (workspaces, initial states, root
		 * filesystems, bundle imports). Unset: any path is accepted.
		 */
		allowedRoots?: string[];
	};
}

export async function loadConfig(home: LilyHome): Promise<LilyConfig> {
	return (await readJsonIfExists<LilyConfig>(home.config)) ?? {};
}

export async function saveConfig(home: LilyHome, config: LilyConfig): Promise<void> {
	await writeJsonAtomic(home.config, config);
}

export function parseModelRef(ref: string): { provider: string; modelId: string } {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) throw new Error(`Model must be "provider/model-id", got "${ref}"`);
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
