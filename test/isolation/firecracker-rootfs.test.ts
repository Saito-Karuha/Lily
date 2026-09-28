import { execFile } from "node:child_process";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileDigest } from "../../src/env/backends/file-cache.ts";
import { FirecrackerBackend, type FirecrackerBackendOptions } from "../../src/env/backends/firecracker.ts";
import { EnvironmentManager } from "../../src/env/manager.ts";
import type { EnvironmentLease, EnvironmentSpec } from "../../src/env/types.ts";
import { LilyHome } from "../../src/store/home.ts";
import { tempDir } from "../helpers/env.ts";

/**
 * Firecracker root filesystems and caches: per-environment images, the overlay mode whose
 * creation time does not depend on the image size, reflink mode's explicit failure, resource
 * drives cached by bundle digest, and host-side usage. Runs with LILY_TEST_BACKEND=firecracker
 * and LILY_FC_KERNEL / LILY_FC_ROOTFS (optionally LILY_FC_JAILER), like the acceptance suite.
 */

const run = promisify(execFile);
const kernel = process.env.LILY_FC_KERNEL;
const rootfs = process.env.LILY_FC_ROOTFS;
const enabled = process.env.LILY_TEST_BACKEND === "firecracker" && Boolean(kernel && rootfs);
const DEMO = join(import.meta.dirname, "../../examples/bundles/demo");

async function sh(lease: EnvironmentLease, command: string): Promise<string> {
	const chunks: Buffer[] = [];
	const exit = await lease.client.exec({ command, timeoutMs: 120_000 }, { onOutput: (d) => chunks.push(d) });
	const out = Buffer.concat(chunks).toString("utf8");
	if (exit.exitCode !== 0) throw new Error(`${command} exited ${exit.exitCode}: ${out}`);
	return out;
}

/** A copy of the base image with extra files written by debugfs (`files`: guest path → content). */
async function variant(dir: string, name: string, files: Record<string, string>): Promise<string> {
	const image = join(dir, `${name}.ext4`);
	await run("cp", ["--sparse=always", rootfs!, image]);
	const commands: string[] = [];
	let i = 0;
	for (const [path, content] of Object.entries(files)) {
		const local = join(dir, `${name}-${i++}`);
		await writeFile(local, content);
		const slash = path.lastIndexOf("/");
		commands.push(`cd ${path.slice(0, slash) || "/"}`, `write ${local} ${path.slice(slash + 1)}`);
	}
	await writeFile(join(dir, `${name}.cmds`), `${commands.join("\n")}\n`);
	await run("debugfs", ["-w", "-f", join(dir, `${name}.cmds`), image], { timeout: 600_000 });
	return image;
}

describe.skipIf(!enabled)("firecracker root filesystems", () => {
	let dir: string;
	let home: LilyHome;
	const managers: EnvironmentManager[] = [];

	async function managerWith(options: Partial<FirecrackerBackendOptions> = {}): Promise<EnvironmentManager> {
		const manager = new EnvironmentManager(home, { maxConcurrent: 8 });
		manager.register(
			new FirecrackerBackend({
				kernel: kernel!,
				rootfs: rootfs!,
				cacheDir: join(home.cache, "firecracker"),
				...(process.env.LILY_FC_JAILER ? { jailer: process.env.LILY_FC_JAILER } : {}),
				...options,
			}),
		);
		managers.push(manager);
		return manager;
	}

	const spec = (extra: Partial<EnvironmentSpec> = {}): EnvironmentSpec => ({ backend: "firecracker", initialState: { kind: "empty" }, limits: { memoryMb: 1024 }, ...extra });

	beforeAll(async () => {
		dir = await tempDir("lily-fc-");
		home = new LilyHome(await tempDir("lily-home-"));
		await home.init();
	});

	afterAll(async () => {
		await Promise.all(managers.map((m) => m.destroyAll()));
	}, 120_000);

	it("boots each environment from its own root filesystem and records its digest", async () => {
		const marked = await variant(dir, "marked", { "/etc/lily-variant": "marked\n" });
		const manager = await managerWith({ images: { marked } });
		const [plain, own, named] = await Promise.all([
			manager.provision(spec()),
			manager.provision(spec({ rootfs: marked })),
			manager.provision(spec({ image: "marked" })),
		]);
		expect(await sh(plain, "cat /etc/lily-variant 2>/dev/null || echo none")).toBe("none\n");
		expect(await sh(own, "cat /etc/lily-variant")).toBe("marked\n");
		expect(await sh(named, "cat /etc/lily-variant")).toBe("marked\n");
		const base = await fileDigest(rootfs!);
		expect(plain.info.rootfs).toEqual({ path: rootfs, digest: base.digest, bytes: base.bytes });
		expect(own.info.rootfs?.digest).toBe((await fileDigest(marked)).digest);
		expect(own.info.rootfs?.digest).not.toBe(base.digest);
		expect(named.info.rootfs?.path).toBe(marked);
		await expect(manager.provision(spec({ image: "unknown" }))).rejects.toThrow(/no root filesystem for image unknown/);
		await Promise.all([plain, own, named].map((l) => l.destroy()));
	}, 600_000);

	it("stacks a private writable layer of limits.diskMb on a shared read-only image", async () => {
		const manager = await managerWith();
		const before = (await fileDigest(rootfs!)).digest;
		const [a, b] = await Promise.all([manager.provision(spec({ limits: { memoryMb: 1024, diskMb: 768 } })), manager.provision(spec())]);
		expect(a.info.details.rootfsMode).toBe("overlay");
		expect(await sh(a, "awk '$2 == \"/\" {print $3}' /proc/mounts")).toBe("overlay\n");
		const sizeMb = Number((await sh(a, "df -m / | awk 'NR==2 {print $2}'")).trim());
		expect(sizeMb).toBeGreaterThan(640);
		expect(sizeMb).toBeLessThanOrEqual(768);
		await sh(a, "echo mine > /etc/written-by-a && rm -f /etc/hostname && dd if=/dev/zero of=/big bs=1M count=64 status=none");
		expect(await sh(b, "cat /etc/written-by-a 2>/dev/null || echo absent; cat /etc/hostname")).toBe("absent\nlily\n");
		// The writable layer is bounded: filling it fails instead of growing on the host.
		expect(await sh(a, "dd if=/dev/zero of=/fill bs=1M count=1024 status=none 2>/dev/null && echo filled || echo full")).toBe("full\n");
		await Promise.all([a.destroy(), b.destroy()]);
		// The shared image was never written.
		const st = await stat(rootfs!);
		expect((await fileDigest(rootfs!)).digest).toBe(before);
		expect(st.size).toBeGreaterThan(0);
	}, 600_000);

	it("creates overlay VMs in the same time whatever the image size, and refuses reflink mode where it cannot reflink", async () => {
		// ~1.6 GiB of real data in a 4 GiB image, next to the small base image.
		const payload = join(dir, "payload.bin");
		await run("dd", ["if=/dev/urandom", `of=${payload}`, "bs=1M", "count=1600", "status=none"], { timeout: 600_000 });
		const big = join(dir, "big.ext4");
		await run("cp", ["--sparse=always", rootfs!, big]);
		await run("e2fsck", ["-fy", big]).catch(() => {});
		await run("resize2fs", [big, "4096M"], { timeout: 300_000 });
		await writeFile(join(dir, "big.cmds"), `cd /opt\nwrite ${payload} payload.bin\n`);
		await run("debugfs", ["-w", "-f", join(dir, "big.cmds"), big], { timeout: 600_000 });
		const bigBytes = (await stat(big)).blocks * 512;
		expect(bigBytes).toBeGreaterThan(1500 * 1024 * 1024);
		// Digests are computed once per image version; do it before timing.
		await fileDigest(big, join(home.cache, "firecracker", "digests.json"));

		const time = async (manager: EnvironmentManager, extra: Partial<EnvironmentSpec>) => {
			const started = performance.now();
			const lease = await manager.provision(spec(extra));
			const ms = performance.now() - started;
			await lease.destroy();
			return ms;
		};
		const overlay = await managerWith();
		await time(overlay, {});
		const small = await time(overlay, {});
		const large = await time(overlay, { rootfs: big });
		const copy = await managerWith({ rootfsMode: "copy" });
		const copied = await time(copy, { rootfs: big });
		console.log(`[firecracker-rootfs] overlay small ${Math.round(small)} ms, overlay big ${Math.round(large)} ms, copy big ${Math.round(copied)} ms`);
		expect(large).toBeLessThan(small * 2 + 500);

		const reflink = await managerWith({ rootfsMode: "reflink" });
		const fs = (await run("stat", ["-f", "-c", "%T", home.root])).stdout.trim();
		if (!["xfs", "btrfs"].includes(fs)) await expect(reflink.provision(spec())).rejects.toThrow(/reflink/);
	}, 1_200_000);

	it("packs a bundle's resource drive once per digest and shares it", async () => {
		const manager = await managerWith();
		const resources = { resourcesDir: DEMO, resourcesDigest: `sha256:${"d".repeat(64)}` };
		const [a, b] = await Promise.all([manager.provision(spec(resources)), manager.provision(spec(resources))]);
		expect(a.info.details.resourceDrive).toBe("cached");
		expect(b.info.details.resourceDrive).toBe("cached");
		const cacheDir = join(home.cache, "firecracker", "resources");
		const files = (await readdir(cacheDir)).filter((n) => !n.startsWith("."));
		expect(files).toEqual([`${"d".repeat(64)}.ext4`]);
		const ino = (await stat(join(cacheDir, files[0]!))).ino;
		for (const lease of [a, b]) {
			expect(await sh(lease, "head -2 /opt/lily/resources/skills/run-tests/SKILL.md")).toContain("name: run-tests");
			expect(await sh(lease, "(touch /opt/lily/resources/x) 2>/dev/null && echo writable || echo denied")).toBe("denied\n");
		}
		const c = await manager.provision(spec(resources));
		expect((await stat(join(cacheDir, files[0]!))).ino).toBe(ino);
		// Without a digest the drive is packed for the VM alone.
		const d = await manager.provision(spec({ resourcesDir: DEMO }));
		expect(d.info.details.resourceDrive).toBe("packed");
		await Promise.all([a, b, c, d].map((l) => l.destroy()));
	}, 600_000);
});
