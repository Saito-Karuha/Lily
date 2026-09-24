import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BundleValidationError, indexBundle } from "../../src/resources/bundle.ts";
import { BundleRegistry } from "../../src/resources/registry.ts";
import { removeTree } from "../../src/util/tree.ts";
import { renderResources } from "../../src/resources/render.ts";
import { assembleSystemPrompt } from "../../src/kernel/system-prompt.ts";

const DEMO = join(import.meta.dirname, "../../examples/bundles/demo");
const BASE = join(import.meta.dirname, "../../examples/bundles/base");

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "lily-bundles-"));
});
afterEach(async () => {
	await removeTree(dir);
});

describe("bundle format", () => {
	it("indexes the demo bundle with per-component digests", async () => {
		const index = await indexBundle(DEMO);
		expect(index.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(Object.keys(index.componentDigests).sort()).toEqual(["F", "M", "P", "S", "U"]);
		expect(index.files.find((f) => f.path.endsWith("select_tests.py"))?.executable).toBe(true);
		expect(index.warnings).toEqual([]);
	});

	it("digests are stable and content-addressed", async () => {
		const copy = join(dir, "copy");
		await cp(DEMO, copy, { recursive: true });
		expect((await indexBundle(copy)).digest).toBe((await indexBundle(DEMO)).digest);
		await writeFile(join(copy, "prompt/attached.md"), "changed\n");
		const changed = await indexBundle(copy);
		const original = await indexBundle(DEMO);
		expect(changed.digest).not.toBe(original.digest);
		expect(changed.componentDigests.P).not.toBe(original.componentDigests.P);
		expect(changed.componentDigests.S).toBe(original.componentDigests.S);
	});

	it("rejects files outside components, symlinks, bad skills and bad processors", async () => {
		const bad = join(dir, "bad");
		await cp(BASE, bad, { recursive: true });
		await writeFile(join(bad, "hooks.js"), "process.exit()");
		await mkdir(join(bad, "tools"));
		await writeFile(join(bad, "tools/python.md"), "x");
		await mkdir(join(bad, "skills/Bad_Name"), { recursive: true });
		await writeFile(join(bad, "skills/Bad_Name/SKILL.md"), "---\nname: other\n---\n");
		await mkdir(join(bad, "observation"));
		await writeFile(join(bad, "observation/processor.json"), JSON.stringify({ format: "lily.processor/v1", tools: { bash: [{ steps: [{ op: "exec" }] }] } }));
		await symlink("/etc/passwd", join(bad, "tools/read.md"));
		const error = await indexBundle(bad).catch((e) => e);
		expect(error).toBeInstanceOf(BundleValidationError);
		const problems = (error as BundleValidationError).problems.join("\n");
		expect(problems).toMatch(/hooks\.js: not part of any component/);
		expect(problems).toMatch(/tools\/python\.md/);
		expect(problems).toMatch(/symbolic links/);
		expect(problems).toMatch(/Bad_Name: skill directory names/);
		expect(problems).toMatch(/frontmatter name/);
		expect(problems).toMatch(/unknown op "exec"/);
	});
});

describe("bundle registry", () => {
	it("publishes immutably, resolves refs and prefixes, and composes student views", async () => {
		const registry = new BundleRegistry(join(dir, "registry"));
		const base = await registry.importDirectory(BASE);
		const demo = await registry.importDirectory(DEMO);
		expect((await registry.importDirectory(DEMO)).digest).toBe(demo.digest);
		await registry.setRef("base", base.digest);
		expect(await registry.resolve("base")).toBe(base.digest);
		expect(await registry.resolve(demo.digest.slice(7, 19))).toBe(demo.digest);
		const objectFile = join(await registry.path(demo.digest), "prompt/attached.md");
		await expect(writeFile(objectFile, "tamper")).rejects.toThrow();

		// Student view: A⁺ = (M, S) from demo, V = (P, U, F) from base.
		const view = await registry.compose({ M: demo.digest, S: demo.digest, P: base.digest, U: base.digest, F: base.digest });
		expect(view.componentDigests.S).toBe(demo.componentDigests.S);
		expect(view.componentDigests.M).toBe(demo.componentDigests.M);
		expect(view.componentDigests.P).toBe(base.componentDigests.P);
		expect(view.origin.kind).toBe("composite");
		expect(await registry.changedComponents(base.digest, demo.digest)).toEqual(["P", "M", "S", "U", "F"]);
		const diff = await registry.diff(base.digest, view.digest);
		expect(diff.filter((d) => d.component === "S").map((d) => d.action)).toEqual(["add", "add"]);
	});

	it("records derived bundles with free-form provenance and follows their lineage", async () => {
		const registry = new BundleRegistry(join(dir, "registry"));
		const base = await registry.importDirectory(BASE);
		const data = { producedBy: "some external process", evidence: ["run_x"] };
		const demo = await registry.importDirectory(DEMO, { kind: "derived", parents: [base.digest], data });
		expect(demo.origin).toEqual({ kind: "derived", parents: [base.digest], data });
		expect((await registry.lineage(demo.digest)).map((r) => r.digest)).toEqual([demo.digest, base.digest]);
		expect((await registry.lineage(base.digest)).map((r) => r.digest)).toEqual([base.digest]);
	});
});

describe("resource rendering and prompt assembly", () => {
	it("renders every component with guest paths and records block provenance", async () => {
		const index = await indexBundle(DEMO);
		const rendered = await renderResources(DEMO, index, "/opt/lily/resources");
		expect(rendered.skills[0]?.location).toBe("/opt/lily/resources/skills/run-tests/SKILL.md");
		expect(rendered.memoryLocation).toBe("/opt/lily/resources/memory");
		const prompt = assembleSystemPrompt(rendered, { workspace: "/workspace" });
		expect(prompt.blocks.map((b) => b.kind)).toEqual(["kernel", "attached_prompt", "tool_guidance", "skills", "memory", "environment"]);
		expect(prompt.text).toContain("<available_skills>");
		expect(prompt.text).toContain('<tool name="bash">');
		expect(prompt.text.endsWith("Current working directory: /workspace")).toBe(true);
		expect(prompt.blocks.find((b) => b.kind === "attached_prompt")?.componentDigest).toBe(index.componentDigests.P);
		const bare = assembleSystemPrompt(undefined, { workspace: "/workspace" });
		expect(bare.blocks.map((b) => b.kind)).toEqual(["kernel", "environment"]);
	});
});

