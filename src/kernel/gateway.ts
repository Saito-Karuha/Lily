import type { AgentHarnessTool, AgentToolResult, Context, JsonValue } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { EnvironmentLease } from "../env/types.ts";
import type { ObservationProcessor } from "../resources/processor/dsl.ts";
import type { ArtifactStore } from "../store/artifacts.ts";
import { digestOf } from "../util/hash.ts";
import type { InvocationLedger, InvocationState } from "./ledger.ts";
import type { Observation } from "./tools/baseline.ts";
import { DEFAULT_RAW_LIMITS, executeRaw, type RawEnvelope, type RawLimits } from "./tools/raw.ts";
import { isKernelToolName, KERNEL_TOOL_NAMES, type KernelToolName, piToolSpecs } from "./tools/specs.ts";

/** Kernel hard cap on model-visible text per observation, applied after F. */
export const DEFAULT_OBSERVATION_CAP_BYTES = 256 * 1024;

/** Metadata attached to every Lily tool result (`details.lily`); never shown to the model. */
export interface LilyToolMeta {
	invocationId: string;
	toolName: KernelToolName;
	isError: boolean;
	rawRef: string;
	rawComplete: boolean;
	processorId: string;
	envId: string;
	envGeneration: number;
	durationMs: number;
	exitCode?: number | null;
	capped?: boolean;
	/** True when this result was re-fetched from the ledger instead of re-executed. */
	reconciled?: boolean;
}

export interface LilyToolDetails {
	lily: LilyToolMeta;
	[key: string]: unknown;
}

/** The environment was lost (or a previous attempt left an effect unaccounted for); the run must stop. */
export class OutcomeUnknownError extends Error {
	readonly invocationId: string;

	constructor(invocationId: string, reason: string) {
		super(`Tool outcome unknown (${reason}). The run was stopped so the effect is not repeated blindly.`);
		this.name = "OutcomeUnknownError";
		this.invocationId = invocationId;
	}
}

export interface GatewayOptions {
	runId: string;
	lease: EnvironmentLease;
	ledger: InvocationLedger;
	artifacts: ArtifactStore;
	processor: ObservationProcessor;
	rawLimits?: RawLimits;
	observationCapBytes?: number;
	/** Called before an OutcomeUnknownError is thrown, e.g. to request a durable abort. */
	onOutcomeUnknown?: (info: { invocationId: string; operationId: string; reason: string }) => void;
	/** Called when a tool is requested but the environment is already gone (nothing dispatched). */
	onEnvironmentUnavailable?: () => void;
	/** Called after every settled execution (fresh or reconciled). */
	onSettled?: (event: { invocationId: string; toolCallId: string; raw: RawEnvelope; observation: Observation; meta: LilyToolMeta }) => void;
}

export interface GatewayCall {
	invocationId: string;
	operationId: string;
	toolCallId: string;
	toolName: KernelToolName;
	args: Record<string, JsonValue>;
	context: Context;
	onProgress?: (text: string) => void;
}

/**
 * Execution gateway: the only path from the loop to an environment. It records
 * a durable intent, runs the raw executor inside the environment, archives the
 * raw envelope before any formatting, derives the observation through F, and
 * applies the kernel cap. Results are re-fetched, never re-executed, on replay.
 */
export class ExecutionGateway {
	readonly #options: GatewayOptions;

	constructor(options: GatewayOptions) {
		this.#options = options;
	}

	get processor(): ObservationProcessor {
		return this.#options.processor;
	}

	async execute(call: GatewayCall): Promise<AgentToolResult<LilyToolDetails>> {
		const { ledger, lease, artifacts, processor } = this.#options;
		await ledger.load();
		const existing = ledger.get(call.invocationId);
		if (existing?.completed) return this.#reconcile(call, existing.completed);
		if (existing?.dispatched || existing?.unknown) {
			const reason = existing.unknown?.reason ?? "dispatched before a restart without a recorded result";
			if (!existing.unknown) await ledger.append({ type: "unknown", invocationId: call.invocationId, reason, at: Date.now() });
			this.#unknown(call, reason);
		}
		if (lease.destroyed || lease.client.closed) {
			// Nothing was dispatched, so this is an infrastructure failure rather than an unknown outcome.
			this.#options.onEnvironmentUnavailable?.();
			throw new Error("Execution environment is not available");
		}
		await ledger.append({
			type: "dispatched",
			invocationId: call.invocationId,
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			runId: this.#options.runId,
			operationId: call.operationId,
			envId: lease.info.envId,
			envGeneration: lease.info.generation,
			argsDigest: digestOf(call.args),
			args: call.args,
			at: Date.now(),
		});
		let raw: RawEnvelope;
		try {
			raw = await executeRaw(call.toolName, call.args, {
				env: lease.env,
				shell: lease.client,
				invocationId: call.invocationId,
				context: call.context,
				tmpDir: lease.info.paths.tmp,
				limits: this.#options.rawLimits ?? DEFAULT_RAW_LIMITS,
				onOutput: call.onProgress,
			});
		} catch (error) {
			if (lease.client.closed) {
				const reason = `environment lost during ${call.toolName}`;
				await ledger.append({ type: "unknown", invocationId: call.invocationId, reason, at: Date.now() });
				this.#unknown(call, reason);
			}
			throw error;
		}
		if (lease.client.closed) {
			// A file operation may report a transport failure as an ordinary error.
			const reason = `environment lost during ${call.toolName}`;
			await ledger.append({ type: "unknown", invocationId: call.invocationId, reason, at: Date.now() });
			this.#unknown(call, reason);
		}
		const rawRef = await artifacts.putJson(raw);
		const { observation, capped } = this.#observe(raw);
		const observationRef = await artifacts.putJson(observation);
		await ledger.append({
			type: "completed",
			invocationId: call.invocationId,
			rawRef,
			rawComplete: raw.complete,
			processorId: processor.id,
			observationRef,
			isError: observation.isError,
			durationMs: raw.durationMs,
			at: Date.now(),
		});
		const meta = this.#meta(call, raw, rawRef, observation, capped, false);
		this.#options.onSettled?.({ invocationId: call.invocationId, toolCallId: call.toolCallId, raw, observation, meta });
		return toToolResult(observation, meta);
	}

	async #reconcile(call: GatewayCall, completed: NonNullable<InvocationState["completed"]>): Promise<AgentToolResult<LilyToolDetails>> {
		const raw = await this.#options.artifacts.getJson<RawEnvelope>(completed.rawRef);
		const observation = await this.#options.artifacts.getJson<Observation>(completed.observationRef);
		const meta = this.#meta(call, raw, completed.rawRef, observation, false, true);
		meta.processorId = completed.processorId;
		this.#options.onSettled?.({ invocationId: call.invocationId, toolCallId: call.toolCallId, raw, observation, meta });
		return toToolResult(observation, meta);
	}

	#observe(raw: RawEnvelope): { observation: Observation; capped: boolean } {
		const processed = this.#options.processor.process(raw);
		return capObservation(processed, this.#options.observationCapBytes ?? DEFAULT_OBSERVATION_CAP_BYTES);
	}

	#meta(
		call: GatewayCall,
		raw: RawEnvelope,
		rawRef: string,
		observation: Observation,
		capped: boolean,
		reconciled: boolean,
	): LilyToolMeta {
		const { lease, processor } = this.#options;
		return {
			invocationId: call.invocationId,
			toolName: call.toolName,
			isError: observation.isError,
			rawRef,
			rawComplete: raw.complete,
			processorId: processor.id,
			envId: lease.info.envId,
			envGeneration: lease.info.generation,
			durationMs: raw.durationMs,
			...(raw.tool === "bash" ? { exitCode: raw.exec?.exitCode ?? null } : {}),
			...(capped ? { capped } : {}),
			...(reconciled ? { reconciled } : {}),
		};
	}

	#unknown(call: GatewayCall, reason: string): never {
		this.#options.onOutcomeUnknown?.({ invocationId: call.invocationId, operationId: call.operationId, reason });
		throw new OutcomeUnknownError(call.invocationId, reason);
	}
}

function toToolResult(observation: Observation, meta: LilyToolMeta): AgentToolResult<LilyToolDetails> {
	return { content: observation.content, details: { ...(observation.details ?? {}), lily: meta } };
}

/** Kernel envelope: bounds model-visible text regardless of what F produced. */
export function capObservation(observation: Observation, capBytes: number): { observation: Observation; capped: boolean } {
	let remaining = capBytes;
	let capped = false;
	const content: Array<TextContent | ImageContent> = [];
	for (const part of observation.content) {
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		const size = Buffer.byteLength(part.text);
		if (size <= remaining) {
			content.push(part);
			remaining -= size;
			continue;
		}
		capped = true;
		const bytes = Buffer.from(part.text, "utf8");
		let end = Math.max(0, remaining);
		while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
		content.push({
			type: "text",
			text: `${bytes.subarray(0, end).toString("utf8")}\n\n[Output truncated to ${capBytes} bytes by the Lily kernel limit.]`,
		});
		remaining = 0;
	}
	return { observation: capped ? { ...observation, content } : observation, capped };
}

export interface LilyToolContext {
	gateway: ExecutionGateway;
}

/**
 * The four kernel tools as Pi harness tools: Pi's own schema, description and
 * argument preparation, with execution routed through the gateway. `replay:
 * "safe"` lets recovery call back in with the same invocation id; the gateway
 * then returns the recorded result or stops the run — it never re-runs an
 * effect whose outcome is unknown.
 */
export function createLilyTools(): AgentHarnessTool<LilyToolContext>[] {
	const specs = piToolSpecs();
	return KERNEL_TOOL_NAMES.map((name) => {
		const spec = specs[name];
		const tool: AgentHarnessTool<LilyToolContext> = {
			name: spec.name,
			label: spec.label,
			description: spec.description,
			parameters: spec.parameters,
			...(spec.prepareArguments ? { prepareArguments: spec.prepareArguments } : {}),
			executionMode: "sequential",
			replay: "safe",
			async execute(toolCallId, params, onUpdate, toolContext, invocation, context) {
				if (!isKernelToolName(name)) throw new Error(`Unknown tool ${name}`);
				let live = "";
				let lastEmit = 0;
				return toolContext.gateway.execute({
					invocationId: invocation.invocationId,
					operationId: invocation.operationId,
					toolCallId,
					toolName: name,
					args: params as Record<string, JsonValue>,
					context,
					onProgress:
						name === "bash"
							? (chunk) => {
									live = (live + chunk).slice(-16 * 1024);
									const now = Date.now();
									if (now - lastEmit < 150) return;
									lastEmit = now;
									onUpdate({ content: [{ type: "text", text: live }], details: undefined as never });
								}
							: undefined,
				});
			},
		};
		return tool;
	});
}
