import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listArchive, packDirectory } from "../../src/env/archive.ts";
import { EnvdError } from "../../src/env/envd-client.ts";
import type { EnvironmentLease } from "../../src/env/types.ts";
import { localEnvironment, tempDir } from "../helpers/env.ts";

const ctx = BACKGROUND_CONTEXT;
let lease: EnvironmentLease;
let source: string;

beforeAll(async () => {
	source = await tempDir();
	await mkdir(join(source, "src"));
	await writeFile(join(source, "src/a.txt"), "alpha\nbeta\n");
	await writeFile(join(source, "run.sh"), "#!/bin/sh\necho ran\n", { mode: 0o755 });
	({ lease } = await localEnvironment({ kind: "directory", path: source }));
});

afterAll(async () => {
	await lease?.destroy();
});

describe("envd client over a local environment", () => {
	it("initializes the workspace by copying (the host source is untouched)", async () => {
		const ws = lease.info.paths.workspace;
		expect(ws).not.toBe(source);
		expect(await readFile(join(ws, "src/a.txt"), "utf8")).toBe("alpha\nbeta\n");
		await lease.env.writeFile("src/a.txt", "changed", ctx);
		expect(await readFile(join(source, "src/a.txt"), "utf8")).toBe("alpha\nbeta\n");
		const exit = await lease.client.exec({ command: "./run.sh", cwd: ws });
		expect(exit.exitCode).toBe(0);
	});

	it("maps filesystem errors to Pi FileErrors with Node-style messages", async () => {
		const missing = await lease.env.readTextFile("nope.txt", ctx);
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error.code).toBe("not_found");
			expect(missing.error.message).toBe(`ENOENT: no such file or directory, open '${join(lease.info.paths.workspace, "nope.txt")}'`);
		}
		await expect(lease.client.request("fs.read", { path: "relative" })).rejects.toBeInstanceOf(EnvdError);
	});

	it("streams combined output in order and reports exit codes", async () => {
		const chunks: Buffer[] = [];
		const exit = await lease.client.exec({ command: "echo a; echo b 1>&2; echo c; exit 3" }, { onOutput: (d) => chunks.push(d) });
		expect(Buffer.concat(chunks).toString()).toBe("a\nb\nc\n");
		expect(exit.exitCode).toBe(3);
	});

	it("cancels a whole process group via AbortSignal", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const done = lease.client.exec({ command: "sleep 30 & sleep 30" }, {}, controller.signal);
		setTimeout(() => controller.abort(), 200);
		const exit = await done;
		expect(exit.cancelled).toBe(true);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("never passes host environment variables into the guest", async () => {
		process.env.LILY_TEST_SECRET = "sk-should-not-leak";
		const chunks: Buffer[] = [];
		await lease.client.exec({ command: "env" }, { onOutput: (d) => chunks.push(d) });
		const env = Buffer.concat(chunks).toString();
		expect(env).not.toContain("sk-should-not-leak");
		expect(env).toContain(`HOME=${lease.info.paths.home}`);
	});

	it("round-trips archives", async () => {
		const archive = await lease.exportWorkspace();
		const names = await listArchive(archive);
		expect(names.some((n) => n.endsWith("src/a.txt"))).toBe(true);
		const packed = await packDirectory(source);
		const result = await lease.client.upload(join(lease.info.paths.tmp, "copy"), packed);
		expect(result.files).toBeGreaterThan(0);
	});
});
