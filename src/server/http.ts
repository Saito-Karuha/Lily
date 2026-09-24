import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LilyError } from "../util/errors.ts";

export type Params = Record<string, string>;

export interface RequestContext {
	req: IncomingMessage;
	res: ServerResponse;
	params: Params;
	query: URLSearchParams;
	body: () => Promise<unknown>;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

interface Route {
	method: string;
	pattern: RegExp;
	keys: string[];
	handler: Handler;
}

/** Marker for handlers that already wrote the response (streams, files). */
export const HANDLED = Symbol("handled");

export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const MAX_BODY = 8 * 1024 * 1024;

/** Minimal JSON router: `:name` segments and a trailing `*` wildcard (as `params.rest`). */
export class Router {
	readonly #routes: Route[] = [];

	on(method: string, path: string, handler: Handler): this {
		const keys: string[] = [];
		const source = path
			.split("/")
			.map((segment) => {
				if (segment === "*") {
					keys.push("rest");
					return "(.*)";
				}
				if (segment.startsWith(":")) {
					keys.push(segment.slice(1));
					return "([^/]+)";
				}
				return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			})
			.join("/");
		this.#routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
		return this;
	}

	get(path: string, handler: Handler) {
		return this.on("GET", path, handler);
	}
	post(path: string, handler: Handler) {
		return this.on("POST", path, handler);
	}
	put(path: string, handler: Handler) {
		return this.on("PUT", path, handler);
	}
	patch(path: string, handler: Handler) {
		return this.on("PATCH", path, handler);
	}
	delete(path: string, handler: Handler) {
		return this.on("DELETE", path, handler);
	}

	match(method: string, path: string): { handler: Handler; params: Params } | undefined {
		for (const route of this.#routes) {
			if (route.method !== method) continue;
			const m = route.pattern.exec(path);
			if (!m) continue;
			const params: Params = {};
			route.keys.forEach((key, i) => {
				let value: string;
				try {
					value = decodeURIComponent(m[i + 1] ?? "");
				} catch {
					throw new HttpError(400, "Malformed path parameter");
				}
				// Ids name files under LILY_HOME: decoded values must stay single, non-dot segments.
				const segments = key === "rest" ? value.split("/") : [value];
				if (/[\\\0]/.test(value) || (key !== "rest" && value.includes("/")) || segments.some((s) => s === "." || s === "..")) {
					throw new HttpError(400, `Invalid path parameter ${key}`);
				}
				params[key] = value;
			});
			return { handler: route.handler, params };
		}
		return undefined;
	}
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolveBody, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > MAX_BODY) {
				reject(new HttpError(413, "Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolveBody({});
			try {
				resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new HttpError(400, "Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

export interface HttpServerOptions {
	router: Router;
	/** Hostnames accepted in the Host header (DNS-rebinding protection for a local server). */
	allowedHosts?: string[];
}

/** Local HTTP server for the JSON API under /api. */
export function createHttpServer(options: HttpServerOptions): Server {
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const host = (req.headers.host ?? "").replace(/:\d+$/, "");
		if (options.allowedHosts && !options.allowedHosts.includes(host)) {
			sendJson(res, 403, { error: { code: "forbidden_host", message: `Host ${host} not allowed` } });
			return;
		}
		try {
			if (url.pathname.startsWith("/api/")) {
				const match = options.router.match(req.method ?? "GET", url.pathname);
				if (!match) throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
				const result = await match.handler({ req, res, params: match.params, query: url.searchParams, body: () => readBody(req) });
				if (result === HANDLED) return;
				sendJson(res, 200, result ?? { ok: true });
				return;
			}
			sendJson(res, 404, { error: { code: "not_found", message: `Not found: ${url.pathname} (the API lives under /api)` } });
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			const status = error instanceof HttpError ? error.status : error instanceof LilyError ? (error.code === "not_found" ? 404 : 400) : 500;
			const code = error instanceof LilyError ? error.code : status === 404 ? "not_found" : status === 500 ? "internal" : "bad_request";
			sendJson(res, status, { error: { code, message: error instanceof Error ? error.message : String(error) } });
		}
	});
}
