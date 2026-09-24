import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContainerBackend } from "../../src/env/backends/container.ts";
import { EnvironmentManager } from "../../src/env/manager.ts";
import type { EnvironmentLease } from "../../src/env/types.ts";
import { LilyHome } from "../../src/store/home.ts";
import { tempDir } from "../helpers/env.ts";

/**
 * VM isolation acceptance for Apple's `container` backend (one lightweight VM
 * with its own Linux kernel per environment). Skipped unless the container
 * services are running. Set LILY_TEST_IMAGE to use another image/mirror.
 */
const IMAGE = process.env.LILY_TEST_IMAGE ?? "docker.m.daocloud.io/library/python:3.12-slim";
const DEMO = join(import.meta.dirname, "../../examples/bundles/demo");
const backend = new ContainerBackend({ dialect: "apple", defaultImage: IMAGE });
const available = (await backend.probe()).available;

async function sh(lease: EnvironmentLease, command: string): Promise<{ code: number | null; out: string }> {
	const chunks: Buffer[] = [];
	const exit = await lease.client.exec({ command, timeoutMs: 30_000 }, { onOutput: (d) => chunks.push(d) });
	return { code: exit.exitCode, out: Buffer.concat(chunks).toString("utf8") };
}

describe.skipIf(!available)("apple-container backend isolation (VM per environment)", () => {
	let manager: EnvironmentManager;
	let a: EnvironmentLease;
	let b: EnvironmentLease;

	beforeAll(async () => {
		const home = new LilyHome(await tempDir("lily-home-"));
		await home.init();
		manager = new EnvironmentManager(home);
		manager.register(backend);
		const repo = await tempDir();
		await writeFile(join(repo, "task.txt"), "task");
		process.env.LILY_TEST_SECRET = "sk-host-secret";
		[a, b] = await Promise.all([
			manager.provision({ backend: "apple-container", initialState: { kind: "directory", path: repo }, resourcesDir: DEMO, limits: { cpus: 2, memoryMb: 1024 } }),
			manager.provision({ backend: "apple-container", initialState: { kind: "directory", path: repo } }),
		]);
	}, 300_000);

	afterAll(async () => {
		await manager?.destroyAll();
		// Other test files may be running containers concurrently: only check ours.
		const remaining = await backend.listContainers();
		expect(remaining.filter((name) => name.endsWith(a?.info.envId ?? "-") || name.endsWith(b?.info.envId ?? "-"))).toEqual([]);
	}, 120_000);

	it("gives every environment the same logical layout", () => {
		expect(a.info.isolation).toBe("vm");
		expect(a.info.paths).toEqual(b.info.paths);
		expect(a.info.paths.workspace).toBe("/workspace");
		expect(a.info.guest.os).toBe("linux");
	});

	it("runs the task inside its own Linux kernel", async () => {
		const r = await sh(a, "cat task.txt && pwd && python3 -c 'print(6*7)' && uname -s");
		expect(r.out).toBe("task/workspace\n42\nLinux\n");
		const kernelA = (await sh(a, "cat /proc/sys/kernel/random/boot_id")).out;
		const kernelB = (await sh(b, "cat /proc/sys/kernel/random/boot_id")).out;
		expect(kernelA).not.toBe(kernelB);
	});

	it("sees only its own processes and files", async () => {
		await sh(b, "echo private-b > /workspace/secret.txt; sleep 300 &");
		const ps = await sh(a, "ls /proc | grep -E '^[0-9]+$' | wc -l");
		expect(Number(ps.out.trim())).toBeLessThan(40);
		const read = await sh(a, "cat /workspace/secret.txt 2>&1 || true");
		expect(read.out).not.toContain("private-b");
		const hostHome = await sh(a, "ls /Users 2>&1 || echo absent");
		expect(hostHome.out).toContain("absent");
	});

	it("receives no host environment variables or credentials", async () => {
		const env = await sh(a, "env");
		expect(env.out).not.toContain("sk-host-secret");
		expect(env.out).toContain("HOME=/home/agent");
	});

	it("has read-only resources and no network", async () => {
		const skill = await sh(a, "cat /opt/lily/resources/skills/run-tests/SKILL.md | head -2");
		expect(skill.out).toContain("name: run-tests");
		const write = await sh(a, "echo x > /opt/lily/resources/prompt/attached.md 2>&1 || echo denied");
		expect(write.out).toContain("denied");
		const envd = await sh(a, "echo x > /opt/lily/bin/lily-envd 2>&1 || echo denied");
		expect(envd.out).toContain("denied");
		const net = await sh(a, "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 53), timeout=3)\" 2>/dev/null && echo reachable || echo blocked");
		expect(net.out.trim()).toBe("blocked");
	});

	it("applies CPU and memory limits to the VM", async () => {
		// Apple's runtime adds one vCPU for its guest agent: --cpus 2 shows 3 CPUs (host has 10).
		expect(Number((await sh(a, "nproc")).out.trim())).toBeLessThanOrEqual(3);
		const memKb = Number((await sh(a, "grep MemTotal /proc/meminfo | awk '{print $2}'")).out.trim());
		expect(memKb).toBeLessThan(1200 * 1024);
	});

	it("shares a mounted host directory as /workspace for interactive use", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "host.txt"), "from host\n");
		const lease = await manager.provision({ backend: "apple-container", initialState: { kind: "mount", path: dir } });
		try {
			const r = await sh(lease, "cat host.txt && echo from-vm > vm.txt");
			expect(r.out).toBe("from host\n");
			const { readFile } = await import("node:fs/promises");
			expect(await readFile(join(dir, "vm.txt"), "utf8")).toBe("from-vm\n");
		} finally {
			await lease.destroy();
		}
	}, 120_000);

	it("exports the workspace and reaps orphaned background processes", async () => {
		await sh(a, "echo exported > result.txt");
		const archive = await a.exportWorkspace();
		expect(archive.byteLength).toBeGreaterThan(0);
		await sh(a, "(sleep 0.1 &) ; sleep 0.5");
		const zombies = await sh(a, "cat /proc/[0-9]*/stat 2>/dev/null | awk '$3==\"Z\"' | wc -l");
		expect(zombies.out.trim()).toBe("0");
	});
});
