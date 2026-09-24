import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../../src/env/backends/local.ts";
import { EnvironmentManager } from "../../src/env/manager.ts";
import type { EnvironmentLease, InitialState } from "../../src/env/types.ts";
import { LilyHome } from "../../src/store/home.ts";

export async function tempDir(prefix = "lily-test-"): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function localEnvironment(
	initialState: InitialState,
	options: { seatbelt?: boolean; resourcesDir?: string } = {},
): Promise<{ lease: EnvironmentLease; manager: EnvironmentManager; home: LilyHome }> {
	const home = new LilyHome(await tempDir("lily-home-"));
	await home.init();
	const manager = new EnvironmentManager(home);
	manager.register(new LocalBackend({ seatbelt: options.seatbelt }));
	const lease = await manager.provision({
		backend: options.seatbelt ? "seatbelt" : "local",
		initialState,
		...(options.resourcesDir ? { resourcesDir: options.resourcesDir } : {}),
	});
	return { lease, manager, home };
}
