import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Digest } from "../util/hash.ts";

/** Session bundle value meaning "ask the runtime's router at the start of every run". */
export const ROUTED_BUNDLE = "@router";

/** What a router sees when a run is about to start. */
export interface RouteRequest {
	sessionId: string;
	runId: string;
	mode: "interactive" | "batch";
	prompt: string;
	/** Session labels overlaid with the run's own labels. */
	labels: Record<string, string>;
}

export interface RouteDecision {
	/** Bundle ref, digest or unique digest prefix; null runs the bare kernel. */
	bundle: string | null;
	/** Free-form, JSON-serializable data recorded in the run manifest (why this bundle). */
	info?: Record<string, unknown>;
}

/**
 * Chooses a resource bundle per run for sessions bound to `@router`. Lily only
 * calls it and records the decision; which bundles exist and how they are
 * chosen, grown or retired is entirely the router's business.
 */
export interface BundleRouter {
	/** Recorded in run manifests. */
	name: string;
	route(request: RouteRequest): RouteDecision | Promise<RouteDecision>;
}

/** Recorded in the manifest of a routed run. */
export interface RouteRecord {
	router: string;
	requested: typeof ROUTED_BUNDLE;
	bundle: Digest | null;
	info?: Record<string, unknown>;
}

/**
 * Loads a router from an ES module whose default export is either a
 * `BundleRouter` object or a bare `route` function.
 */
export async function loadRouter(modulePath: string, cwd = process.cwd()): Promise<BundleRouter> {
	const path = isAbsolute(modulePath) ? modulePath : resolve(cwd, modulePath);
	const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
	const exported = mod.default;
	if (typeof exported === "function") {
		return { name: path, route: exported as BundleRouter["route"] };
	}
	if (exported && typeof exported === "object" && typeof (exported as BundleRouter).route === "function") {
		const router = exported as Partial<BundleRouter> & Pick<BundleRouter, "route">;
		return { name: router.name ?? path, route: router.route.bind(router) };
	}
	throw new Error(`${path}: the default export must be a route function or an object with a route() method`);
}
