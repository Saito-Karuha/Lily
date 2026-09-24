// Starts a run whose tool never finishes, then kills its own process as soon as the
// tool is dispatched — simulating a worker crash in the middle of a side effect.
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { LocalBackend } from "../../src/env/backends/local.ts";
import { LilyRuntime } from "../../src/runtime/runtime.ts";

const home = process.argv[2]!;
const models = createModels();
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo side-effect >> effects.log; sleep 30" })], { stopReason: "toolUse" })]);
const runtime = await LilyRuntime.create({ home, config: { model: "faux/faux-1" }, models, backends: [new LocalBackend()] });
const session = await runtime.createSession({
	mode: "interactive",
	model: "faux/faux-1",
	bundle: null,
	environment: { backend: "local", initialState: { kind: "mount", path: process.argv[3]! } },
});
session.events.subscribe(({ event }) => {
	if (event.type === "tool_start") setTimeout(() => process.kill(process.pid, "SIGKILL"), 400);
});
process.stdout.write(`${session.id}\n`);
await session.prompt("do it");
