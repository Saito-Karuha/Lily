// Seeds a Lily home with a realistic interactive session (runs, a failing command, a diff,
// a follow-up) using an offline scripted model, and (re)writes examples/scripts/chat.json:
//
//   LILY_HOME=/tmp/lily-demo node scripts/seed-demo.ts
//   LILY_HOME=/tmp/lily-demo node bin/lily.mjs --resume <session> --script examples/scripts/chat.json
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { LocalBackend } from "../src/env/backends/local.ts";
import { LilyRuntime } from "../src/runtime/runtime.ts";
import { packageRoot } from "../src/env/envd-binary.ts";

const root = packageRoot();
const examples = join(root, "examples");

const tool = (name: string, args: Record<string, unknown>, text?: string, thinking?: string) =>
	fauxAssistantMessage(
		[...(thinking ? [fauxThinking(thinking)] : []), ...(text ? [fauxText(text)] : []), fauxToolCall(name, args as never)],
		{ stopReason: "toolUse" },
	);
const say = (text: string) => fauxAssistantMessage(text);

async function main() {
	const models = createModels();
	const faux = fauxProvider({ provider: "scripted", models: [{ id: "script", name: "Scripted demo model", contextWindow: 128_000, maxTokens: 8192 }], tokensPerSecond: 2000 });
	models.setProvider(faux.provider);
	const runtime = await LilyRuntime.create({ config: { model: "scripted/script", bundle: "base" }, models, backends: [new LocalBackend(), new LocalBackend({ seatbelt: process.platform === "darwin" })] });
	console.log(`seeding ${runtime.home.root}`);
	const base = await runtime.registry.importDirectory(join(examples, "bundles/base"));
	const demo = await runtime.registry.importDirectory(join(examples, "bundles/demo"));
	await runtime.registry.setRef("base", base.digest);
	await runtime.registry.setRef("demo", demo.digest);

	// An interactive session with a few turns, a failing command, a diff and a follow-up.
	const workspace = await mkdtemp(join(tmpdir(), "lily-demo-ws-"));
	await writeFile(join(workspace, "app.py"), "def greet(name):\n    return 'Hello ' + nme\n\nif __name__ == '__main__':\n    print(greet('lily'))\n");
	await writeFile(join(workspace, "README.md"), "# Demo app\n\nRun `python3 app.py`.\n");
	faux.setResponses([
		tool("bash", { command: "ls -la && python3 app.py" }, "I'll run the app first to see what happens.", "The user says the app crashes. Run it to reproduce."),
		tool("read", { path: "app.py" }, "There's a NameError. Let me read the file."),
		tool("edit", { path: "app.py", edits: [{ oldText: "'Hello ' + nme", newText: "f'Hello {name}!'" }] }, "The variable name has a typo; fixing it with an f-string."),
		tool("bash", { command: "python3 app.py" }),
		say("Fixed the typo (`nme` → `name`) and switched to an f-string. `python3 app.py` now prints:\n\n```\nHello lily!\n```"),
		tool("bash", { command: "grep -rn 'Hello' . | head -20" }, "Let me check for other greetings."),
		say("That was the only occurrence, so nothing else needs to change."),
	]);
	const session = await runtime.createSession({
		mode: "interactive",
		model: "scripted/script",
		bundle: demo.digest,
		environment: { backend: "local", initialState: { kind: "mount", path: workspace } },
		workspaceLabel: workspace,
	});
	await (await session.prompt("The app crashes when I run it. Can you fix it?")).done;
	await (await session.prompt("Are there other places with the same problem?")).done;
	console.log(`interactive session ${session.id}`);

	// A script the TUI can use to keep chatting offline (`--script examples/scripts/chat.json`).
	const scriptDir = join(examples, "scripts");
	await mkdir(scriptDir, { recursive: true });
	const chat = Array.from({ length: 40 }, (_, i) =>
		i % 2 === 0
			? { text: "Let me look around the workspace.", toolCalls: [{ name: "bash", arguments: { command: "ls -la && git status 2>/dev/null | head -5" } }] }
			: { text: "This is the offline scripted model: it lists the workspace and replies. Configure a real model with `lily config model <provider/model>`." },
	);
	await writeFile(join(scriptDir, "chat.json"), `${JSON.stringify(chat, null, 2)}\n`);
	await runtime.close();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
