/**
 * Lily as a library. Everything a program needs to drive Lily without the TUI:
 * create sessions and runs, choose where they execute, bind or route resource
 * bundles, follow events, and read back what was recorded. Lily provides
 * mechanisms only — datasets, rewards, schedules and bundle search live in the
 * caller.
 */

// Runtime, sessions, runs
export { LilyRuntime, defaultBackends, type RuntimeOptions, type SessionSummary } from "./runtime/runtime.ts";
export { LilySession, readBinding, type RunHandle, type RunOptions, type SessionInit } from "./runtime/session.ts";
export type { SessionBinding } from "./runtime/binding.ts";
export type { LilyEvent } from "./runtime/events.ts";
export { LILY_VERSION } from "./server/api.ts";

// Execution environments
export { EnvironmentManager } from "./env/manager.ts";
export { LocalBackend, type LocalBackendOptions } from "./env/backends/local.ts";
export { ContainerBackend, GUEST_PATHS, type ContainerBackendOptions } from "./env/backends/container.ts";
export { FirecrackerBackend, type FirecrackerBackendOptions } from "./env/backends/firecracker.ts";
export { EnvdClient, EnvdClosedError, EnvdError } from "./env/envd-client.ts";
export type {
	EnvironmentBackend,
	EnvironmentInfo,
	EnvironmentLease,
	EnvironmentLimits,
	EnvironmentSpec,
	InitialState,
	IsolationLevel,
} from "./env/types.ts";

// Resource bundles and routing
export { BUNDLE_FORMAT, COMPONENTS, COMPONENT_DIRS, indexBundle, type BundleIndex, type BundleManifest, type Component } from "./resources/bundle.ts";
export { BundleRegistry, diffFiles, type BundleOrigin, type BundleRecord, type FileChange } from "./resources/registry.ts";
export { renderResources, type RenderedResources } from "./resources/render.ts";
export { ROUTED_BUNDLE, loadRouter, type BundleRouter, type RouteDecision, type RouteRecord, type RouteRequest } from "./resources/router.ts";
export {
	PROCESSOR_FORMAT,
	baselineProcessor,
	createProcessor,
	validateProcessorSpec,
	type ObservationProcessor,
	type ProcessorSpec,
} from "./resources/processor/dsl.ts";

// Recorded data
export { LilyHome } from "./store/home.ts";
export { ArtifactStore } from "./store/artifacts.ts";
export {
	LILY_KERNEL_VERSION,
	RunStore,
	listRunIds,
	type Fidelity,
	type ModelCallRecord,
	type RunManifest,
	type RunOutcome,
	type RunStatus,
	type ToolCallRecord,
} from "./store/runs.ts";
export { TRAJECTORY_FORMAT, exportRun, type ExportOptions, type ExportedCall, type ExportedTrajectory } from "./trajectory/export.ts";
export { ViewError, renderCallView, type CallView, type ResourceBlockKind, type ViewOptions } from "./trajectory/view.ts";
export { renderTrajectoryMarkdown } from "./trajectory/render-md.ts";

// Models and configuration
export { loadConfig, saveConfig, parseModelRef, type CustomProviderConfig, type LilyConfig } from "./models/config.ts";
export { buildModels, registerScriptedProvider, type ScriptedTurn } from "./models/registry.ts";
export { vllmTokenCapture } from "./models/token-capture.ts";

// HTTP control surface
export { createApi } from "./server/api.ts";
export { createHttpServer } from "./server/http.ts";
