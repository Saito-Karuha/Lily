import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connectVsock } from "../../src/env/backends/firecracker.ts";
import { envdBinary, hostTarget } from "../../src/env/envd-binary.ts";
import { EnvdClient } from "../../src/env/envd-client.ts";
import { tempDir } from "../helpers/env.ts";

/**
 * Firecracker exposes guest vsock ports on a host Unix socket: the client sends
 * `CONNECT <port>\n` and gets `OK <local-port>\n`. This fake bridge speaks that
 * handshake and then pipes the connection into a real lily-envd, which is enough
 * to verify the controller side of the firecracker backend without KVM.
 */
describe("firecracker vsock bridge (host side)", () => {
	let server: Server | undefined;
	afterAll(() => server?.close());

	it("performs the CONNECT handshake (after early refusals) and speaks the envd protocol", async () => {
		const dir = await tempDir();
		const path = join(dir, "v.sock");
		const { os, arch } = hostTarget();
		const binary = await envdBinary(os, arch);
		let attempts = 0;
		server = createServer((socket) => {
			attempts++;
			if (attempts < 3) {
				socket.destroy(); // guest not listening yet
				return;
			}
			socket.once("data", (chunk) => {
				expect(chunk.toString()).toBe("CONNECT 1024\n");
				socket.write("OK 1073741824\n");
				const envd = spawn(binary, ["serve", "--stdio", "--cwd", dir, "--tmp", dir], { stdio: ["pipe", "pipe", "inherit"] });
				socket.pipe(envd.stdin!);
				envd.stdout!.pipe(socket);
				socket.on("close", () => envd.kill());
			});
		});
		await new Promise<void>((resolve) => server!.listen(path, resolve));
		const socket = await connectVsock(path, 1024, 10_000, { exitCode: null });
		const client = new EnvdClient(socket, socket);
		const hello = await client.handshake();
		expect(hello.protocol).toBe(1);
		const chunks: Buffer[] = [];
		const exit = await client.exec({ command: "echo over-vsock" }, { onOutput: (d) => chunks.push(d) });
		expect(exit.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toBe("over-vsock\n");
		expect(attempts).toBe(3);
		socket.destroy();
	});

	it("keeps bytes that arrive with the OK line and gives up at the deadline when the guest never answers", async () => {
		const dir = await tempDir();
		const eager = join(dir, "eager.sock");
		const silent = join(dir, "silent.sock");
		const servers = [
			createServer((socket) => socket.once("data", () => socket.write("OK 1\nearly-bytes\n"))),
			// Firecracker holds a host connection until the guest's vsock driver answers.
			createServer(() => {}),
		];
		await Promise.all(servers.map((srv, i) => new Promise<void>((resolve) => srv.listen(i === 0 ? eager : silent, resolve))));
		try {
			const socket = await connectVsock(eager, 52, 5_000, { exitCode: null });
			// connectVsock hands the socket over paused (the envd client's reader resumes it).
			const first = await new Promise<string>((resolve) => {
				socket.once("data", (d: Buffer) => resolve(d.toString()));
				socket.resume();
			});
			expect(first).toBe("early-bytes\n");
			socket.destroy();
			const started = Date.now();
			await expect(connectVsock(silent, 52, 700, { exitCode: null })).rejects.toThrow(/timed out/);
			expect(Date.now() - started).toBeLessThan(3_000);
		} finally {
			for (const srv of servers) srv.close();
		}
	});
});
