import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonIfExists } from "../../src/util/fsx.ts";
import { tempDir } from "../helpers/env.ts";

const BIN = join(import.meta.dirname, "../../bin/lily.mjs");

async function envRecords(home: string): Promise<Array<{ status: string }>> {
	const ids = await readdir(join(home, "envs")).catch(() => [] as string[]);
	const records = await Promise.all(ids.map((id) => readJsonIfExists<{ status: string }>(join(home, "envs", id, "env.json"))));
	return records.filter((r): r is { status: string } => Boolean(r));
}

describe("the CLI destroys its environments when it is told to stop", () => {
	for (const signal of ["SIGHUP", "SIGTERM"] as const) {
		it(`on ${signal} during a run`, async () => {
			const home = await tempDir("lily-signal-home-");
			const workspace = await tempDir("lily-signal-ws-");
			const script = join(home, "script.json");
			await writeFile(script, JSON.stringify([{ toolCalls: [{ name: "bash", arguments: { command: "sleep 30" } }] }, { text: "done" }]));
			const child = spawn(process.execPath, [BIN, "-p", "wait", "--script", script, "--backend", "local"], {
				cwd: workspace,
				env: { ...process.env, LILY_HOME: home },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
			const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
			// Wait until the command is running inside a ready environment.
			const deadline = Date.now() + 20_000;
			while (!stderr.includes("sleep 30") || !(await envRecords(home)).some((r) => r.status === "ready")) {
				if (Date.now() > deadline) throw new Error(`run did not start: ${stderr}`);
				await new Promise((r) => setTimeout(r, 100));
			}
			child.kill(signal);
			expect(await exited).toBe(128 + (signal === "SIGHUP" ? 1 : 15));
			expect((await envRecords(home)).map((r) => r.status)).toEqual(["destroyed"]);
		}, 40_000);
	}
});
