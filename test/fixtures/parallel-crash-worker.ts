import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { LocalBackend } from "../../src/env/backends/local.ts";
import { LilyRuntime } from "../../src/runtime/runtime.ts";

const models = createModels();
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([
	fauxToolCall("bash", { command: "printf 'once\\n' >> fast.log" }, { id: "fast" }),
	fauxToolCall("bash", { command: "printf 'once\\n' >> slow-a.log; printf started; sleep 30" }, { id: "slow-a" }),
	fauxToolCall("bash", { command: "printf 'once\\n' >> slow-b.log; printf started; sleep 30" }, { id: "slow-b" }),
], { stopReason: "toolUse" })]);
const runtime = await LilyRuntime.create({ home: process.argv[2]!, config: { model: "faux/faux-1" }, models, backends: [new LocalBackend()] });
const session = await runtime.createSession({
	mode: "batch", model: "faux/faux-1", bundle: null, toolExecution: "parallel",
	environment: { backend: "local", initialState: { kind: "mount", path: process.argv[3]! } },
});
let fastCompleted = false;
const slowStarted = new Set<string>();
session.events.subscribe(({ event }) => {
	if (event.type === "tool_end" && event.toolCallId === "fast") fastCompleted = true;
	if (event.type === "tool_update" && event.toolCallId.startsWith("slow-") && event.text.includes("started")) slowStarted.add(event.toolCallId);
	if (fastCompleted && slowStarted.size === 2) process.kill(process.pid, "SIGKILL");
});
process.stdout.write(`${session.id}\n`);
await session.prompt("three independent commands");
