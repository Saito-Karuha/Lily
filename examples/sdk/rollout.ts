// An external orchestrator built on Lily's SDK — the kind of code a trainer or an evaluation
// harness writes for itself. Lily knows nothing about task files, checks or scores; this file
// does, using only Lily's mechanisms: isolated sessions, labels, routing, exec in the run's
// environment, run annotations and trajectory export.
//
//   node examples/sdk/rollout.ts --model <provider/model-id> [--bundle <ref|@router>] [--router <module>]
//        [--backend <name>] [--concurrency 4] [--tasks examples/tasks/python/tasks.jsonl] [--out dir]
//
// Outside this repository, import from "lily-harness" instead of "../../src/index.ts".
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { exportRun, LilyRuntime, loadRouter, RunStore, type RunOutcome } from "../../src/index.ts";

export interface Task {
	id: string;
	group?: string;
	prompt: string;
	/** Host directory the agent starts from (copied into a fresh environment). */
	repo: string;
	/** Python script run in the workspace after the agent finished; exit code 0 = passed. */
	check: string;
}

export interface TaskResult {
	id: string;
	runId: string;
	status: RunOutcome["status"];
	passed: boolean;
	checkOutput: string;
}

export async function loadTasks(file: string): Promise<Task[]> {
	const base = dirname(resolve(file));
	return (await readFile(file, "utf8"))
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Task)
		.map((task) => ({ ...task, repo: resolve(base, task.repo), check: resolve(base, task.check) }));
}

/** Runs every task in its own fresh environment, `concurrency` at a time, and checks each result. */
export async function rollout(
	runtime: LilyRuntime,
	tasks: Task[],
	options: { model: string; bundle?: string | null; backend?: string; concurrency?: number; maxTurns?: number },
): Promise<TaskResult[]> {
	const results: TaskResult[] = [];
	const queue = [...tasks];
	const worker = async () => {
		for (let task = queue.shift(); task; task = queue.shift()) results.push(await runOne(runtime, task, options));
	};
	await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
	return results.sort((a, b) => a.id.localeCompare(b.id));
}

async function runOne(
	runtime: LilyRuntime,
	task: Task,
	options: { model: string; bundle?: string | null; backend?: string; maxTurns?: number },
): Promise<TaskResult> {
	const session = await runtime.createSession({
		mode: "batch",
		title: task.id,
		model: options.model,
		bundle: options.bundle ?? null,
		environment: runtime.isolatedEnvironment({ kind: "directory", path: task.repo }, options.backend),
		// Labels are recorded in the run manifest and shown to the router (e.g. to route by group).
		labels: { task: task.id, ...(task.group ? { group: task.group } : {}) },
		budget: { maxTurns: options.maxTurns ?? 20 },
	});
	try {
		const handle = await session.prompt(task.prompt);
		const outcome = await handle.done;
		// The check runs in the same environment after the run, outside the agent's context:
		// the agent never saw it and it is not part of the trajectory.
		const script = await readFile(task.check, "utf8");
		const check = await session.exec(`python3 - <<'LILY_CHECK'\n${script}\nLILY_CHECK`, { timeoutMs: 60_000 });
		const passed = outcome.status === "completed" && check.exitCode === 0;
		const checkOutput = check.output.slice(-2000);
		await new RunStore(runtime.home.run(handle.runId)).annotate("check", { passed, exitCode: check.exitCode, output: checkOutput });
		return { id: task.id, runId: handle.runId, status: outcome.status, passed, checkOutput };
	} finally {
		await runtime.closeSession(session.id, { destroyEnvironment: true });
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			model: { type: "string" },
			bundle: { type: "string" },
			router: { type: "string" },
			backend: { type: "string" },
			concurrency: { type: "string" },
			tasks: { type: "string" },
			out: { type: "string" },
			home: { type: "string" },
		},
	});
	const router = values.router ? await loadRouter(values.router) : undefined;
	const runtime = await LilyRuntime.create({ ...(values.home ? { home: values.home } : {}), ...(router ? { router } : {}) });
	const model = values.model ?? runtime.config.model;
	if (!model) throw new Error("pass --model <provider/model-id> or configure a default model");
	try {
		const tasks = await loadTasks(values.tasks ?? join(import.meta.dirname, "../tasks/python/tasks.jsonl"));
		const results = await rollout(runtime, tasks, {
			model,
			bundle: values.bundle ?? runtime.config.bundle ?? null,
			...(values.backend ? { backend: values.backend } : {}),
			concurrency: Number(values.concurrency ?? 4),
		});
		for (const r of results) console.log(`${r.passed ? "pass" : "FAIL"}  ${r.id.padEnd(16)} ${r.status.padEnd(10)} ${r.runId}`);
		console.log(`${results.filter((r) => r.passed).length}/${results.length} passed`);
		if (values.out) {
			await mkdir(values.out, { recursive: true });
			for (const r of results) {
				const trajectory = await exportRun(new RunStore(runtime.home.run(r.runId)), runtime.artifacts, { includeRaw: true });
				await writeFile(join(values.out, `${r.id}.traj.json`), JSON.stringify(trajectory));
			}
			console.log(`trajectories → ${values.out}`);
		}
	} finally {
		await runtime.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
