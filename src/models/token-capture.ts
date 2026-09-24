import type { Api, Model } from "@earendil-works/pi-ai";
import type { TokenCaptureFactory, TokenEvidence } from "./recording.ts";

interface ChunkChoice {
	index?: number;
	token_ids?: number[] | null;
}

interface CompletionChunk {
	prompt_token_ids?: number[] | null;
	choices?: ChunkChoice[];
}

/** Accumulates vLLM token evidence from SSE chunks or a JSON body. */
class TokenAccumulator {
	prompt: number[] | undefined;
	output: number[] = [];

	add(chunk: CompletionChunk): void {
		if (Array.isArray(chunk.prompt_token_ids) && !this.prompt) this.prompt = chunk.prompt_token_ids;
		for (const choice of chunk.choices ?? []) {
			if ((choice.index ?? 0) === 0 && Array.isArray(choice.token_ids)) this.output.push(...choice.token_ids);
		}
	}

	evidence(): TokenEvidence | undefined {
		if (!this.prompt && this.output.length === 0) return undefined;
		return { promptTokenIds: this.prompt ?? [], outputTokenIds: this.output };
	}
}

async function consumeSse(stream: ReadableStream<Uint8Array>, accumulator: TokenAccumulator): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const handle = (line: string) => {
		if (!line.startsWith("data:")) return;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return;
		try {
			accumulator.add(JSON.parse(data) as CompletionChunk);
		} catch {
			// Not a JSON chunk; ignore.
		}
	};
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			handle(buffer.slice(0, newline).replace(/\r$/, ""));
			buffer = buffer.slice(newline + 1);
		}
	}
	if (buffer) handle(buffer);
}

/**
 * Token capture for vLLM's OpenAI-compatible server (v0.10.2+): asks for
 * `return_token_ids` and reads `prompt_token_ids` (first chunk) and
 * `choices[0].token_ids` (every chunk) from a tee of the HTTP response, so the
 * SDK and pi-ai see an unchanged stream. The recorded ids are exactly what the
 * engine templated and sampled — no retokenization.
 */
export function vllmTokenCapture(providerIds: Iterable<string>): TokenCaptureFactory {
	const enabled = new Set(providerIds);
	return (model: Model<Api>) => {
		if (!enabled.has(model.provider) || model.api !== "openai-completions") return undefined;
		const accumulator = new TokenAccumulator();
		const pending: Promise<void>[] = [];
		const capturingFetch: typeof globalThis.fetch = async (input, init) => {
			const response = await globalThis.fetch(input, init);
			if (!response.ok || !response.body) return response;
			const type = response.headers.get("content-type") ?? "";
			const [forClient, forCapture] = response.body.tee();
			if (type.includes("text/event-stream")) {
				pending.push(consumeSse(forCapture, accumulator).catch(() => {}));
			} else {
				pending.push(
					new Response(forCapture)
						.json()
						.then((body) => accumulator.add(body as CompletionChunk))
						.catch(() => {}),
				);
			}
			return new Response(forClient, { status: response.status, statusText: response.statusText, headers: response.headers });
		};
		return {
			fetch: capturingFetch,
			patchOptions: (options) => ({ ...options, samplingParams: { ...options.samplingParams, return_token_ids: true } }),
			evidence: async () => {
				await Promise.all(pending);
				return accumulator.evidence();
			},
		};
	};
}
