import type { Api, Context as AiContext, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

class PayloadRendered extends Error {
	constructor() {
		super("payload rendered; request not sent");
		this.name = "PayloadRendered";
	}
}

const offline: typeof globalThis.fetch = async () => {
	throw new Error("renderCallPayload never sends requests");
};

/**
 * The provider-native request body (wire payload) that `models` would send for `context` and
 * `options`, built by the same pi-ai code path as a real request (message conversion, compat
 * handling, request options) and stopped at its `onPayload` hook, before anything is sent. With
 * a recorded call's context and options it reproduces the recorded payload; with another context
 * (for example a call view under other resources) it gives the payload that context would have
 * produced under the same conditions.
 *
 * Credentials are resolved as for a real request (some providers shape the payload by the kind of
 * credential), so the provider must be configured on this host.
 */
export async function renderCallPayload(
	models: Models,
	model: Model<Api>,
	context: AiContext,
	options: Record<string, unknown> = {},
): Promise<unknown> {
	let payload: unknown;
	let captured = false;
	const stream = models.streamSimple(model, context, {
		...(options as ModelsSimpleStreamOptions),
		onPayload: (body: unknown) => {
			payload = body;
			captured = true;
			throw new PayloadRendered();
		},
		fetch: offline,
	} as ModelsSimpleStreamOptions);
	const message = await stream.result();
	if (!captured) {
		throw new Error(`The ${model.api} adapter of ${model.provider}/${model.id} produced no payload: ${message.errorMessage ?? message.stopReason}`);
	}
	return payload;
}
