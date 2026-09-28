import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelConfigRecord } from "../store/runs.ts";
import { digestOf, sha256 } from "../util/hash.ts";

/**
 * The configuration of `model` that shapes its requests, as recorded in run manifests. URLs and
 * headers are only digested (they may carry credentials); everything else is kept verbatim.
 */
export function modelConfigRecord(model: Model<Api>, thinkingLevel: string, tokenCapture: string): ModelConfigRecord {
	const record: Omit<ModelConfigRecord, "configDigest"> = {
		provider: model.provider,
		modelId: model.id,
		api: model.api,
		thinkingLevel,
		...(model.baseUrl ? { baseUrlDigest: sha256(model.baseUrl) } : {}),
		...(model.headers && Object.keys(model.headers).length ? { headersDigest: digestOf(model.headers) } : {}),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		input: [...model.input],
		...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
		...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}),
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		tokenCapture,
	};
	return { ...record, configDigest: digestOf(record) };
}
