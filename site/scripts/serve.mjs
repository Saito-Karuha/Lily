// A tiny static file server for previewing the built site (no dependencies).
//
//   node scripts/serve.mjs [dir=dist] [--port 4173]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = Number(portFlag >= 0 ? args[portFlag + 1] : process.env.PORT || 4173);
const root = resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port") ?? "dist");

const TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".png": "image/png",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

export function serve({ dir = root, port: p = port, quiet = false } = {}) {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		let path = normalize(join(dir, decodeURIComponent(url.pathname)));
		if (!path.startsWith(dir)) {
			res.writeHead(403).end("forbidden");
			return;
		}
		if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
		if (!existsSync(path)) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
			if (!quiet) console.log(`404 ${url.pathname}`);
			return;
		}
		res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
		createReadStream(path).pipe(res);
	});
	server.listen(p, "127.0.0.1", () => console.log(`serving ${dir} at http://127.0.0.1:${p}/`));
	return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
