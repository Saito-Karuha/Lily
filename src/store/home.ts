import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LilyError } from "../util/errors.ts";
import { ensureDir } from "../util/fsx.ts";

/** Ids become directory names; reject anything that could escape its parent directory. */
export function safeSegment(id: string, what = "id"): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id) || id.includes("..")) throw new LilyError("invalid_id", `Invalid ${what}: ${JSON.stringify(id)}`);
	return id;
}

/** Layout of Lily's data directory (`$LILY_HOME`, default `~/.lily`). */
export class LilyHome {
	readonly root: string;

	constructor(root?: string) {
		this.root = resolve(root ?? process.env.LILY_HOME ?? join(homedir(), ".lily"));
	}

	get config(): string {
		return join(this.root, "config.json");
	}
	/** Pi JSONL session repository root. */
	get sessions(): string {
		return join(this.root, "sessions");
	}
	/** Lily-owned per-session metadata (bindings, invocation ledger). */
	sessionMeta(sessionId: string): string {
		return join(this.root, "session-meta", safeSegment(sessionId, "session id"));
	}
	get sessionMetaRoot(): string {
		return join(this.root, "session-meta");
	}
	run(runId: string): string {
		return join(this.root, "runs", safeSegment(runId, "run id"));
	}
	get runs(): string {
		return join(this.root, "runs");
	}
	get artifacts(): string {
		return join(this.root, "artifacts");
	}
	get registry(): string {
		return join(this.root, "registry");
	}
	env(envId: string): string {
		return join(this.root, "envs", safeSegment(envId, "environment id"));
	}
	get envs(): string {
		return join(this.root, "envs");
	}
	get batches(): string {
		return join(this.root, "batches");
	}
	get pools(): string {
		return join(this.root, "pools");
	}

	async init(): Promise<void> {
		for (const dir of [this.sessions, this.sessionMetaRoot, this.runs, this.artifacts, this.registry, this.envs]) {
			await ensureDir(dir);
		}
	}
}
