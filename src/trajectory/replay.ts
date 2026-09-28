import type { Context as AiContext, Models } from "@earendil-works/pi-ai";
import { modelConfigRecord } from "../models/config-record.ts";
import { renderCallPayload } from "../models/payload.ts";
import type { TokenCaptureFactory } from "../models/recording.ts";
import { baselineProcessor } from "../resources/processor/dsl.ts";
import type { BundleRegistry } from "../resources/registry.ts";
import { renderResources } from "../resources/render.ts";
import type { ArtifactStore } from "../store/artifacts.ts";
import type { LilyHome } from "../store/home.ts";
import { RunStore } from "../store/runs.ts";
import { LilyError } from "../util/errors.ts";
import { canonicalJson } from "../util/hash.ts";
import { exportCall, type ExportedCall } from "./export.ts";
import { type CallView, type ResourceBlockKind, renderCallView, ViewError, type ViewOptions } from "./view.ts";

/** What replaying recorded calls needs from a runtime. */
export interface ReplayServices {
	home: LilyHome;
	artifacts: ArtifactStore;
	registry: BundleRegistry;
	models: Models;
	tokenCapture?: TokenCaptureFactory;
}

/** A call view described with plain data (bundle refs instead of rendered resources), as over HTTP. */
export interface CallViewRequest {
	/** Bundle (ref or digest) whose resources rebuild the system prompt blocks; `null` for none. Omit to keep the recorded prompt. */
	bundle?: string | null;
	/** Which resource blocks come from `bundle` (default: all four). */
	replace?: ResourceBlockKind[];
	/** Re-render tool observations from their raw outputs: with `bundle`'s processor, or Pi's baseline. Omit to keep them. */
	processor?: "from-resources" | "baseline";
	/** Text placed before the system prompt. */
	systemPrefix?: string;
	observationCapBytes?: number;
	/** What to return: the view's context (default), the wire payload it would produce, or both. */
	output?: "context" | "payload" | "both";
}

export interface CallViewResult {
	runId: string;
	callId: string;
	context?: AiContext;
	payload?: unknown;
	/** The recorded model output, unchanged. */
	target: unknown;
	report: CallView["report"];
	/** With a payload: whether the model's configuration still matches the run manifest's. */
	model?: PayloadModelReport;
}

export interface PayloadModelReport {
	provider: string;
	modelId: string;
	configDigest: string;
	/** False when the model's configuration changed since the run (the payload may then differ from what the run would have sent); null for manifests without a config digest. */
	matchesManifest: boolean | null;
}

export interface CallPayloadResult {
	runId: string;
	callId: string;
	payload: unknown;
	/** When the recorded context was rendered: whether the result equals the payload recorded for the call (null when none was recorded). */
	recordedPayloadMatches?: boolean | null;
	model: PayloadModelReport;
}

async function loadCall(services: ReplayServices, runId: string, callId: string) {
	const store = new RunStore(services.home.run(runId));
	if (!(await store.readManifest().then(() => true, () => false))) throw new LilyError("not_found", `Unknown run ${runId}`);
	const found = await exportCall(store, services.artifacts, callId);
	if (!found) throw new LilyError("not_found", `Run ${runId} has no call ${callId}`);
	return found;
}

async function payloadFor(services: ReplayServices, call: ExportedCall, manifest: { model: { thinkingLevel: string; configDigest?: string } }, context: AiContext) {
	const model = services.models.getModel(call.model.provider, call.model.modelId);
	if (!model) throw new LilyError("unknown_model", `Model ${call.model.provider}/${call.model.modelId} is not configured on this host`);
	const capture = services.tokenCapture?.(model);
	const { configDigest } = modelConfigRecord(model, manifest.model.thinkingLevel, capture ? (capture.mode ?? "custom") : "none");
	const payload = await renderCallPayload(services.models, model, context, call.options ?? {});
	return {
		payload,
		model: {
			provider: model.provider,
			modelId: model.id,
			configDigest: configDigest!,
			matchesManifest: manifest.model.configDigest ? manifest.model.configDigest === configDigest : null,
		},
	};
}

/**
 * The wire payload of a recorded call: of its recorded context (a replay check —
 * `recordedPayloadMatches` says whether it reproduces what was sent), or of another context
 * given by the caller, under the call's recorded request options.
 */
export async function renderRecordedCallPayload(services: ReplayServices, runId: string, callId: string, context?: AiContext): Promise<CallPayloadResult> {
	const { manifest, call } = await loadCall(services, runId, callId);
	const rendered = await payloadFor(services, call, manifest, context ?? call.context);
	return {
		runId,
		callId,
		payload: rendered.payload,
		...(context ? {} : { recordedPayloadMatches: call.payload === undefined ? null : canonicalJson(call.payload) === canonicalJson(rendered.payload) }),
		model: rendered.model,
	};
}

/** `renderCallView` for a stored run, with resources named by bundle ref; optionally renders the view's payload too. */
export async function viewRecordedCall(services: ReplayServices, runId: string, callId: string, request: CallViewRequest = {}): Promise<CallViewResult> {
	const { manifest, call } = await loadCall(services, runId, callId);
	const options: ViewOptions = {};
	if (request.bundle !== undefined) {
		if (request.bundle === null) options.resources = null;
		else {
			const record = await services.registry.get(request.bundle).catch((error: Error) => {
				throw new LilyError("not_found", error.message);
			});
			options.resources = await renderResources(await services.registry.path(record.digest), record, manifest.environment.paths.resources);
		}
	}
	if (request.replace) options.replace = request.replace;
	if (request.processor === "from-resources") options.processor = "from-resources";
	else if (request.processor === "baseline") options.processor = baselineProcessor;
	if (request.systemPrefix) options.systemPrefix = request.systemPrefix;
	if (request.observationCapBytes !== undefined) options.observationCapBytes = request.observationCapBytes;
	let view: CallView;
	try {
		view = await renderCallView(call, manifest, options, services.artifacts);
	} catch (error) {
		if (error instanceof ViewError) throw new LilyError("invalid_view", error.message);
		throw error;
	}
	const output = request.output ?? "context";
	const rendered = output === "context" ? undefined : await payloadFor(services, call, manifest, view.context);
	return {
		runId,
		callId,
		...(output !== "payload" ? { context: view.context } : {}),
		...(rendered ? { payload: rendered.payload, model: rendered.model } : {}),
		target: view.target,
		report: view.report,
	};
}
