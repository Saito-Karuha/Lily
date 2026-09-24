import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContainerBackend, type ContainerBackendOptions } from "../../src/env/backends/container.ts";
import { FirecrackerBackend } from "../../src/env/backends/firecracker.ts";
import { EnvdClosedError } from "../../src/env/envd-client.ts";
import { EnvironmentManager, type EnvironmentRecord } from "../../src/env/manager.ts";
import type { EnvironmentBackend, EnvironmentLease, EnvironmentSpec, IsolationLevel } from "../../src/env/types.ts";
import { LilyHome } from "../../src/store/home.ts";
import { tempDir } from "../helpers/env.ts";

/**
 * Backend acceptance suite: the same isolation, lifecycle and cleanup checks for every
 * container / VM backend. Pick the backend with LILY_TEST_BACKEND:
 *
 *   apple-container | docker | gvisor | podman | podman-gvisor | firecracker
 *
 * The suite is skipped when the variable is unset or the backend's probe() fails.
 * Optional: LILY_TEST_IMAGE (image for container backends), LILY_TEST_EGRESS (host:port reachable
 * from an egress environment, "0" to skip), and for firecracker LILY_FC_KERNEL, LILY_FC_ROOTFS,
 * LILY_FC_BIN, LILY_FC_JAILER. scripts/verify/ sets up a Linux VM that has docker, podman and gVisor.
 */

const run = promisify(execFile);
const BACKEND = process.env.LILY_TEST_BACKEND ?? "";
const REPO_ROOT = join(import.meta.dirname, "../..");
const DEMO = join(REPO_ROOT, "examples/bundles/demo");
const EGRESS = process.env.LILY_TEST_EGRESS ?? "mirrors.tuna.tsinghua.edu.cn:443";

interface Traits {
	isolation: IsolationLevel;
	/** Own kernel per environment. */
	vm: boolean;
	/** Host directories can be shared as /workspace. */
	mount: boolean;
	egress: boolean;
	/** pids limit enforced. */
	pids: boolean;
	/** vCPUs visible to `nproc` for `cpus: 2` (upper bound), or undefined when only a CFS quota applies. */
	nproc?: number;
	/** Exceeding the memory limit kills the whole environment (gVisor: the host OOM-kills the sandbox). */
	oomKillsEnvironment?: boolean;
	/** The same backend configured to run commands as UID/GID 1000. */
	nonRoot?: () => EnvironmentBackend;
	/** Kills the environment's container/VM from outside, as a crash would. */
	kill(lease: EnvironmentLease): Promise<void>;
	/** Names of backend objects (containers, VM processes) still present for these env ids. */
	leftovers(envIds: string[]): Promise<string[]>;
}

function containerTraits(backend: ContainerBackend, traits: Omit<Traits, "kill" | "leftovers" | "nonRoot">, cli: string, options: ContainerBackendOptions): Traits {
	return {
		...traits,
		nonRoot: () => new ContainerBackend({ ...options, user: "1000:1000", name: `${backend.name}-nonroot` }),
		kill: async (lease) => {
			await run(cli, ["kill", String(lease.info.details.container)], { timeout: 60_000 });
		},
		leftovers: async (envIds) => (await backend.listContainers()).filter((name) => envIds.some((id) => name.endsWith(id))),
	};
}

function underTest(name: string): { backend: EnvironmentBackend; traits: Traits } | undefined {
	const image = process.env.LILY_TEST_IMAGE;
	switch (name) {
		case "apple-container": {
			const options: ContainerBackendOptions = { dialect: "apple", defaultImage: image ?? "docker.m.daocloud.io/library/python:3.12-slim" };
			const backend = new ContainerBackend(options);
			// Apple's runtime adds one vCPU for its guest agent.
			return { backend, traits: containerTraits(backend, { isolation: "vm", vm: true, mount: true, egress: true, pids: true, nproc: 3 }, "container", options) };
		}
		case "docker":
		case "gvisor": {
			const gvisor = name === "gvisor";
			const options: ContainerBackendOptions = { dialect: "docker", ...(gvisor ? { runtime: "runsc" } : {}), defaultImage: image ?? "python:3.12-slim" };
			const backend = new ContainerBackend(options);
			const traits = { isolation: gvisor ? "user-kernel" : "container", vm: false, mount: true, egress: true, pids: true, ...(gvisor ? { nproc: 2, oomKillsEnvironment: true } : {}) } as const;
			return { backend, traits: containerTraits(backend, traits, "docker", options) };
		}
		case "podman":
		case "podman-gvisor": {
			const gvisor = name === "podman-gvisor";
			const options: ContainerBackendOptions = {
				dialect: "podman",
				...(gvisor ? { runtime: "runsc", name: "podman-gvisor" } : {}),
				defaultImage: image ?? "docker.io/library/python:3.12-slim",
			};
			const backend = new ContainerBackend(options);
			const traits = { isolation: gvisor ? "user-kernel" : "container", vm: false, mount: true, egress: true, pids: true, ...(gvisor ? { nproc: 2, oomKillsEnvironment: true } : {}) } as const;
			return { backend, traits: containerTraits(backend, traits, "podman", options) };
		}
		case "firecracker": {
			const kernel = process.env.LILY_FC_KERNEL;
			const rootfs = process.env.LILY_FC_ROOTFS;
			if (!kernel || !rootfs) return undefined;
			const backend = new FirecrackerBackend({
				kernel,
				rootfs,
				...(process.env.LILY_FC_BIN ? { firecracker: process.env.LILY_FC_BIN } : {}),
				...(process.env.LILY_FC_JAILER ? { jailer: process.env.LILY_FC_JAILER } : {}),
			});
			return {
				backend,
				traits: {
					isolation: "vm",
					vm: true,
					mount: false,
					egress: false,
					pids: true,
					nproc: 2,
					kill: async (lease) => {
						process.kill(Number(lease.info.details.pid), "SIGKILL");
					},
					leftovers: async (envIds) => {
						const { stdout } = await run("ps", ["-eo", "args"]);
						// Firecracker ids drop the underscore (`--id env0199…`); config paths keep it.
						const ids = envIds.flatMap((id) => [id, id.replace(/[^A-Za-z0-9-]/g, "")]);
						return stdout.split("\n").filter((line) => /firecracker|jailer/.test(line) && ids.some((id) => line.includes(id)));
					},
				},
			};
		}
	}
	return undefined;
}

const target = underTest(BACKEND);
const probe = target ? await target.backend.probe() : { available: false, reason: `LILY_TEST_BACKEND=${JSON.stringify(BACKEND)} is not a testable backend` };
if (BACKEND && !probe.available) console.warn(`[backend-acceptance] skipping ${BACKEND}: ${probe.reason}`);

async function sh(lease: EnvironmentLease, command: string, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
	const chunks: Buffer[] = [];
	const exit = await lease.client.exec({ command, timeoutMs }, { onOutput: (d) => chunks.push(d) });
	return { code: exit.exitCode, out: Buffer.concat(chunks).toString("utf8") };
}

/** Counts processes whose command line matches a pattern (no procps needed in the guest). */
function countProcs(pattern: string): string {
	// "[s]leep" matches "sleep" but not this command line itself.
	const self = `[${pattern[0]}]${pattern.slice(1)}`;
	return `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c -- '${self}' || true`;
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

const timings: Record<string, number | string> = {};

describe.skipIf(!probe.available)(`backend acceptance: ${BACKEND}`, () => {
	// Collected even when skipped: fall back to inert values when no backend is under test.
	const backend = target?.backend as EnvironmentBackend;
	const traits = (target?.traits ?? {}) as Traits;
	let home: LilyHome;
	let manager: EnvironmentManager;
	let repo: string;
	let a: EnvironmentLease;
	let b: EnvironmentLease;
	const created: string[] = [];

	async function provision(spec: Omit<EnvironmentSpec, "backend">, into = manager): Promise<EnvironmentLease> {
		const started = performance.now();
		const lease = await into.provision({ backend: backend.name, ...spec });
		created.push(lease.info.envId);
		timings[`provision#${created.length}`] = Math.round(performance.now() - started);
		return lease;
	}

	beforeAll(async () => {
		home = new LilyHome(await tempDir("lily-home-"));
		await home.init();
		manager = new EnvironmentManager(home);
		manager.register(backend);
		repo = await tempDir();
		await writeFile(join(repo, "task.txt"), "task");
		await mkdir(join(repo, "sub"));
		await writeFile(join(repo, "sub", "keep.txt"), "kept\n");
		await mkdir(join(repo, "node_modules"));
		await writeFile(join(repo, "node_modules", "junk.js"), "junk");
		process.env.LILY_TEST_SECRET = "sk-host-secret";
		const limits = { cpus: 2, memoryMb: 1024, pids: 128 };
		[a, b] = await Promise.all([
			provision({ initialState: { kind: "directory", path: repo, exclude: ["node_modules"] }, resourcesDir: DEMO, limits, env: { LILY_SPEC_VAR: "from-spec" } }),
			provision({ initialState: { kind: "directory", path: repo } }),
		]);
	}, 600_000);

	afterAll(async () => {
		await manager?.destroyAll();
		if (created.length) expect(await traits.leftovers(created)).toEqual([]);
		console.log(`[backend-acceptance] ${BACKEND} timings (ms): ${JSON.stringify(timings)}`);
	}, 300_000);

	it("reports its isolation level and the fixed guest layout", () => {
		expect(a.info.backend).toBe(backend.name);
		expect(a.info.isolation).toBe(traits.isolation);
		expect(a.info.paths).toEqual({ workspace: "/workspace", resources: "/opt/lily/resources", home: "/home/agent", tmp: "/tmp" });
		expect(a.info.paths).toEqual(b.info.paths);
		expect(a.info.guest.os).toBe("linux");
	});

	it("runs commands with exit codes, cwd and combined output", async () => {
		const r = await sh(a, "echo out; echo err >&2; pwd; uname -s; exit 3");
		expect(r.code).toBe(3);
		expect(r.out).toBe("out\nerr\n/workspace\nLinux\n");
		const samples: number[] = [];
		for (let i = 0; i < 20; i++) {
			const started = performance.now();
			expect((await sh(a, "true")).code).toBe(0);
			samples.push(performance.now() - started);
		}
		samples.sort((x, y) => x - y);
		timings.execMedian = Math.round(samples[10]! * 10) / 10;
		timings.execP90 = Math.round(samples[18]! * 10) / 10;
	}, 120_000);

	it("copies a host directory in (honouring excludes) without touching the host copy", async () => {
		const r = await sh(a, "cat task.txt; echo; cat sub/keep.txt; ls -a; echo changed > task.txt; echo new > created.txt");
		expect(r.out).toContain("task\nkept\n");
		expect(r.out).not.toContain("node_modules");
		expect((await sh(b, "ls node_modules")).out).toContain("junk.js");
		expect(await readFile(join(repo, "task.txt"), "utf8")).toBe("task");
		await expect(readFile(join(repo, "created.txt"))).rejects.toThrow();
	});

	it("extracts an archive as the initial workspace", async () => {
		const dir = await tempDir();
		const archive = join(dir, "state.tar.gz");
		await tar.c({ gzip: true, cwd: repo, file: archive, portable: true }, ["task.txt", "sub"]);
		const lease = await provision({ initialState: { kind: "archive", path: archive } });
		try {
			expect((await sh(lease, "cat task.txt sub/keep.txt")).out).toBe("taskkept\n");
		} finally {
			await lease.destroy();
		}
	}, 300_000);

	it(traits.mount ? "shares a mounted host directory as /workspace" : "rejects host directory mounts", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "host.txt"), "from host\n");
		if (!traits.mount) {
			await expect(manager.provision({ backend: backend.name, initialState: { kind: "mount", path: dir } })).rejects.toThrow(/mount/);
			return;
		}
		const lease = await provision({ initialState: { kind: "mount", path: dir } });
		try {
			expect((await sh(lease, "cat host.txt && echo from-guest > guest.txt")).out).toBe("from host\n");
			expect(await readFile(join(dir, "guest.txt"), "utf8")).toBe("from-guest\n");
		} finally {
			await lease.destroy();
		}
		expect(await readFile(join(dir, "host.txt"), "utf8")).toBe("from host\n");
	}, 300_000);

	it("exposes the resource bundle read-only, even to root", async () => {
		expect((await sh(a, "id -u")).out.trim()).toBe(String(a.info.guest.uid));
		expect((await sh(a, "head -2 /opt/lily/resources/skills/run-tests/SKILL.md")).out).toContain("name: run-tests");
		for (const attempt of [
			"echo x > /opt/lily/resources/prompt/attached.md",
			"touch /opt/lily/resources/new-file",
			"rm -f /opt/lily/resources/manifest.json && test ! -e /opt/lily/resources/manifest.json",
			"chmod -R u+w /opt/lily/resources && echo x >> /opt/lily/resources/manifest.json",
		]) {
			const r = await sh(a, `(${attempt}) 2>/dev/null && echo WRITABLE || echo denied`);
			expect(r.out.trim(), attempt).toBe("denied");
		}
	});

	it("keeps the envd binary out of reach", async () => {
		for (const attempt of [
			"echo x > /opt/lily/bin/lily-envd",
			"touch /opt/lily/bin/planted",
			"cp /bin/true /opt/lily/bin/lily-envd",
			"rm -f /opt/lily/bin/lily-envd && test ! -e /opt/lily/bin/lily-envd",
		]) {
			const r = await sh(a, `(${attempt}) 2>/dev/null && echo WRITABLE || echo denied`);
			expect(r.out.trim(), attempt).toBe("denied");
		}
		expect((await sh(a, "/opt/lily/bin/lily-envd version")).out.trim()).toBe(a.info.guest.envdVersion);
	});

	it("passes no host environment variables into the guest", async () => {
		const env = (await sh(a, "env; echo ---; tr '\\0' '\\n' < /proc/1/environ")).out;
		expect(env).not.toContain("sk-host-secret");
		expect(env).toContain("HOME=/home/agent");
		expect(env).toContain(`LILY_ENV_ID=${a.info.envId}`);
		expect(env).toContain("LILY_SPEC_VAR=from-spec");
		expect(env).toContain("TMPDIR=/tmp");
	});

	it("has no network by default, but a working loopback", async () => {
		const connect = (host: string, port: number) =>
			`python3 -c "import socket; socket.create_connection(('${host}', ${port}), timeout=3)" 2>/dev/null && echo reachable || echo blocked`;
		expect((await sh(a, connect("1.1.1.1", 53))).out.trim()).toBe("blocked");
		expect((await sh(a, connect("223.5.5.5", 53))).out.trim()).toBe("blocked");
		expect((await sh(a, `python3 -c "import socket; socket.getaddrinfo('example.com', 443)" 2>/dev/null && echo resolved || echo no-dns`)).out.trim()).toBe("no-dns");
		const lo = await sh(
			a,
			`python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(); c=socket.create_connection(s.getsockname(), timeout=3); print('loopback-ok')"`,
		);
		expect(lo.out.trim()).toBe("loopback-ok");
	});

	it.skipIf(EGRESS === "0")(traits.egress ? "reaches the outside world only with network: egress" : "rejects network: egress", async () => {
		if (!traits.egress) {
			await expect(manager.provision({ backend: backend.name, initialState: { kind: "empty" }, limits: { network: "egress" } })).rejects.toThrow(/egress/);
			return;
		}
		const [host, port] = EGRESS.split(":");
		const lease = await provision({ initialState: { kind: "empty" }, limits: { network: "egress" } });
		try {
			const r = await sh(lease, `python3 -c "import socket; socket.create_connection(('${host}', ${port}), timeout=10); print('reachable')" 2>&1`);
			expect(r.out.trim()).toBe("reachable");
		} finally {
			await lease.destroy();
		}
	}, 300_000);

	it("applies cpu, memory and pids limits", async () => {
		const nproc = Number((await sh(a, "nproc")).out.trim());
		const cgroup = (await sh(a, "cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max 2>/dev/null")).out;
		const memKb = Number((await sh(a, "awk '/MemTotal/ {print $2}' /proc/meminfo")).out.trim());
		if (traits.nproc !== undefined) expect(nproc).toBeLessThanOrEqual(traits.nproc);
		else expect(cgroup).toContain("200000 100000");
		// Either the kernel only has ~1 GiB, or the cgroup caps it at exactly 1 GiB.
		expect(memKb < 1300 * 1024 || cgroup.includes(String(1024 * 1024 * 1024))).toBe(true);
		timings.limits = `nproc=${nproc} memTotalKb=${memKb} cgroup=${cgroup.trim().replace(/\n/g, "|")}`;
		if (!traits.pids) return;
		// pids: 200 concurrent children cannot fit under pids=128.
		const fork = await sh(
			a,
			`python3 -c "
import os, time
kids = []
try:
    for i in range(200):
        pid = os.fork()
        if pid == 0:
            time.sleep(30)
            os._exit(0)
        kids.append(pid)
except OSError as e:
    print('fork-failed', e.errno)
for pid in kids:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
print('forked', len(kids))
"`,
			120_000,
		);
		timings.pids = fork.out.trim().replace(/\n/g, " ");
		expect(fork.out).toContain("fork-failed");
		// gVisor's in-sandbox pids accounting lags slightly (observed: up to ~10 tasks over).
		const slack = traits.isolation === "user-kernel" ? 16 : 0;
		expect(Number(/forked (\d+)/.exec(fork.out)?.[1] ?? "999")).toBeLessThan(128 + slack);
		expect((await sh(a, "echo still-alive")).out).toBe("still-alive\n");
	}, 300_000);

	it(traits.oomKillsEnvironment ? "loses the whole environment when it exceeds its memory limit" : "kills only the process that exceeds the memory limit", async () => {
		const lease = await provision({ initialState: { kind: "empty" }, limits: { memoryMb: 512 } });
		try {
			const hog = await sh(lease, `python3 -c "b = bytearray(1024 * 1024 * 1024); b[::4096] = b'x' * len(b[::4096]); print('ALLOC' + 'ATED')" 2>&1; echo "exit=$?"`, 120_000).catch(
				(error: unknown) => ({ code: null, out: String(error) }),
			);
			timings.memoryHog = hog.out.trim().split("\n").slice(-2).join(" ").slice(0, 160);
			expect(hog.out).not.toContain("ALLOCATED");
			if (traits.oomKillsEnvironment) {
				expect(await waitFor(() => lease.destroyed, 30_000)).toBe(true);
			} else {
				expect(hog.out).toMatch(/exit=(137|1)\b/);
				expect((await sh(lease, "echo still-alive")).out).toBe("still-alive\n");
			}
		} finally {
			await lease.destroy();
		}
	}, 300_000);

	it("keeps environments apart: files, processes and the host", async () => {
		await sh(b, "echo private-b > /workspace/secret.txt; (sleep 313 >/dev/null 2>&1 &)");
		expect((await sh(a, "cat /workspace/secret.txt 2>&1 || true")).out).not.toContain("private-b");
		expect(Number((await sh(a, countProcs("sleep 313"))).out.trim())).toBe(0);
		expect(Number((await sh(b, countProcs("sleep 313"))).out.trim())).toBeGreaterThan(0);
		// User processes only (kernel threads, visible in a VM, have an empty cmdline).
		const userProcs = `n=0; for p in /proc/[0-9]*; do [ -n "$(tr -d '\\0' < $p/cmdline 2>/dev/null)" ] && n=$((n+1)); done; echo $n`;
		expect(Number((await sh(a, userProcs)).out.trim())).toBeLessThan(20);
		// The controller host's files (this repository) are not visible.
		expect((await sh(a, `test -e '${REPO_ROOT}/package.json' && echo present || echo absent`)).out.trim()).toBe("absent");
		if (traits.vm) {
			const bootA = (await sh(a, "cat /proc/sys/kernel/random/boot_id")).out;
			expect(bootA).not.toBe((await sh(b, "cat /proc/sys/kernel/random/boot_id")).out);
		}
	});

	it("reaps orphaned background processes", async () => {
		await sh(a, "for i in 1 2 3 4 5; do (sleep 0.1 &); done; sleep 1");
		const zombies = await sh(a, "cat /proc/[0-9]*/stat 2>/dev/null | awk '$3==\"Z\"' | wc -l");
		expect(zombies.out.trim()).toBe("0");
	});

	it("times out and cancels long commands together with their process trees", async () => {
		let started = performance.now();
		const timedOut = await a.client.exec({ command: "sleep 611 & sleep 612; echo never", timeoutMs: 1000 });
		expect(timedOut.timedOut).toBe(true);
		expect(performance.now() - started).toBeLessThan(10_000);
		expect(await waitFor(async () => (await sh(a, countProcs("sleep 61[12]"))).out.trim() === "0", 10_000)).toBe(true);

		const controller = new AbortController();
		started = performance.now();
		setTimeout(() => controller.abort(), 300);
		const cancelled = await a.client.exec({ command: "trap '' TERM; sleep 621 & sleep 622" }, {}, controller.signal);
		expect(cancelled.cancelled).toBe(true);
		expect(performance.now() - started).toBeLessThan(10_000);
		expect(await waitFor(async () => (await sh(a, countProcs("sleep 62[12]"))).out.trim() === "0", 10_000)).toBe(true);

		const viaEnv = new AbortController();
		setTimeout(() => viaEnv.abort(), 300);
		const result = await a.env.exec("sleep 631", {}, withAbortSignal(viaEnv.signal, BACKGROUND_CONTEXT));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("aborted");
		const timeout = await a.env.exec("sleep 632", { timeout: 1 }, BACKGROUND_CONTEXT);
		expect(timeout.ok ? "ok" : timeout.error.code).toBe("timeout");
	}, 120_000);

	it("exports the workspace as a tar.gz", async () => {
		await sh(a, "mkdir -p out && echo exported > out/result.txt");
		const archive = await a.exportWorkspace();
		const dir = await tempDir();
		const file = join(dir, "ws.tgz");
		await writeFile(file, archive);
		await tar.x({ file, cwd: dir });
		expect(await readFile(join(dir, "out", "result.txt"), "utf8")).toBe("exported\n");
		expect(await readFile(join(dir, "task.txt"), "utf8")).toBe("changed\n");
	});

	it("detects a lost lease when the backend dies", async () => {
		const lease = await provision({ initialState: { kind: "empty" } });
		const pending = lease.client.exec({ command: "sleep 300" }).then(
			() => "finished",
			(error: unknown) => error,
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const killed = performance.now();
		await traits.kill(lease);
		expect(await pending).toBeInstanceOf(EnvdClosedError);
		expect(await waitFor(() => lease.destroyed, 30_000)).toBe(true);
		timings.lostDetectionMs = Math.round(performance.now() - killed);
		expect(await waitFor(async () => {
			const record = JSON.parse(await readFile(join(home.env(lease.info.envId), "env.json"), "utf8")) as EnvironmentRecord;
			return record.status === "lost";
		}, 30_000)).toBe(true);
		expect(await waitFor(async () => (await traits.leftovers([lease.info.envId])).length === 0, 60_000)).toBe(true);
	}, 300_000);

	it.skipIf(!traits.nonRoot)("runs commands as an unprivileged user when configured", async () => {
		const variant = traits.nonRoot!();
		manager.register(variant);
		const lease = await manager.provision({ backend: variant.name, initialState: { kind: "directory", path: repo }, resourcesDir: DEMO });
		created.push(lease.info.envId);
		try {
			const r = await sh(
				lease,
				[
					"id -u",
					"cat task.txt; echo",
					"echo w > /workspace/w.txt && echo workspace-ok",
					"echo h > $HOME/h.txt && echo home-ok",
					"echo t > /tmp/t.txt && echo tmp-ok",
					"(echo x > /opt/lily/resources/new) 2>/dev/null || echo resources-denied",
					"(touch /etc/lily-probe) 2>/dev/null || echo system-denied",
				].join("; "),
			);
			expect(r.out).toBe("1000\ntask\nworkspace-ok\nhome-ok\ntmp-ok\nresources-denied\nsystem-denied\n");
			expect(lease.info.guest.uid).toBe(1000);
		} finally {
			await lease.destroy();
		}
	}, 300_000);

	it("sweeps environments of dead controllers, but never another home's", async () => {
		const lease = await provision({ initialState: { kind: "empty" } });
		// Another Lily home on the same machine must leave this environment alone.
		const otherHome = new LilyHome(await tempDir("lily-home-"));
		await otherHome.init();
		const other = new EnvironmentManager(otherHome);
		other.register(backend);
		expect(await other.sweep()).toEqual([]);
		expect((await sh(lease, "echo alive")).out).toBe("alive\n");
		// Simulate a crashed controller: the record's owner is gone and nobody holds the lease.
		const recordPath = join(home.env(lease.info.envId), "env.json");
		const record = JSON.parse(await readFile(recordPath, "utf8")) as EnvironmentRecord;
		await writeFile(recordPath, JSON.stringify({ ...record, ownerPid: 2 ** 22 + 12345 }));
		const restarted = new EnvironmentManager(home);
		restarted.register(backend);
		expect(await restarted.sweep()).toContain(lease.info.envId);
		expect(await traits.leftovers([lease.info.envId])).toEqual([]);
		expect(await waitFor(() => lease.destroyed, 30_000)).toBe(true);
	}, 300_000);
});
