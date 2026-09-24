import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnvironmentLease } from "../../src/env/types.ts";
import { localEnvironment, tempDir } from "../helpers/env.ts";

const DEMO = join(import.meta.dirname, "../../examples/bundles/demo");
const onMac = process.platform === "darwin";

async function sh(lease: EnvironmentLease, command: string): Promise<{ code: number | null; out: string }> {
	const chunks: Buffer[] = [];
	const exit = await lease.client.exec({ command, timeoutMs: 15_000 }, { onOutput: (d) => chunks.push(d) });
	return { code: exit.exitCode, out: Buffer.concat(chunks).toString("utf8") };
}

describe.skipIf(!onMac)("seatbelt backend isolation", () => {
	let a: EnvironmentLease;
	let b: EnvironmentLease;
	let hostSecret: string;

	beforeAll(async () => {
		// A file in the real home directory stands in for ~/.ssh, API keys, etc.
		hostSecret = join(homedir(), `.lily-isolation-probe-${process.pid}`);
		await writeFile(hostSecret, "host secret");
		const repo = await tempDir();
		await writeFile(join(repo, "task.txt"), "task");
		({ lease: a } = await localEnvironment({ kind: "directory", path: repo }, { seatbelt: true, resourcesDir: DEMO }));
		({ lease: b } = await localEnvironment({ kind: "directory", path: repo }, { seatbelt: true }));
		expect(a.info.isolation).toBe("process-sandbox");
	});

	afterAll(async () => {
		await a?.destroy();
		await b?.destroy();
		const { rm } = await import("node:fs/promises");
		await rm(hostSecret, { force: true });
	});

	it("works normally inside its own workspace", async () => {
		const r = await sh(a, "cat task.txt && echo ok > out.txt && cat out.txt && python3 -c 'print(6*7)'");
		expect(r.code).toBe(0);
		expect(r.out).toBe("taskok\n42\n");
	});

	it("cannot read the host user's files", async () => {
		const r = await sh(a, `cat ${hostSecret}`);
		expect(r.code).not.toBe(0);
		expect(r.out).not.toContain("host secret");
		const ls = await sh(a, `ls ${homedir()}`);
		expect(ls.code).not.toBe(0);
	});

	it("cannot read or write another environment's workspace", async () => {
		await sh(b, "echo private-b > secret.txt");
		const read = await sh(a, `cat ${join(b.info.paths.workspace, "secret.txt")}`);
		expect(read.code).not.toBe(0);
		expect(read.out).not.toContain("private-b");
		const write = await sh(a, `echo x > ${join(b.info.paths.workspace, "planted.txt")}`);
		expect(write.code).not.toBe(0);
	});

	it("cannot write outside its workspace, home and tmp", async () => {
		const r = await sh(a, `echo x > /private/tmp/lily-escape-${process.pid} || echo denied`);
		expect(r.out).toContain("denied");
		const res = await sh(a, `echo x > ${join(a.info.paths.resources, "prompt", "attached.md")} || echo denied`);
		expect(res.out).toContain("denied");
		const skill = await sh(a, `cat ${join(a.info.paths.resources, "skills", "run-tests", "SKILL.md")}`);
		expect(skill.out).toContain("name: run-tests");
	});

	it("has no network access by default", async () => {
		const r = await sh(a, "curl -sS --max-time 3 https://example.com >/dev/null 2>&1 && echo reachable || echo blocked");
		expect(r.out.trim()).toBe("blocked");
		const py = await sh(a, "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 53), timeout=3)\" 2>/dev/null && echo reachable || echo blocked");
		expect(py.out.trim()).toBe("blocked");
	});
});
