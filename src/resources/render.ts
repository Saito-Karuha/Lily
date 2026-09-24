import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import { KERNEL_TOOL_NAMES, type KernelToolName } from "../kernel/tools/specs.ts";
import type { Digest } from "../util/hash.ts";
import { type BundleFile, type Component, readSkills, type SkillMetadata } from "./bundle.ts";
import { type ProcessorSpec, validateProcessorSpec } from "./processor/dsl.ts";

/** A bundle's content prepared for one environment's path layout. */
export interface RenderedResources {
	digest: Digest;
	componentDigests: Record<Component, Digest>;
	attachedPrompt?: string;
	toolGuidance: Partial<Record<KernelToolName, string>>;
	skills: Array<SkillMetadata & { location: string }>;
	/** Guest path of the memory directory when the bundle ships memory. */
	memoryLocation?: string;
	memoryHasIndex: boolean;
	processor?: ProcessorSpec;
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Reads the P/U/S/M/F content of a bundle directory. `guestResourcesPath` is
 * where the same files are visible inside the environment; every path shown to
 * the model points there, so the catalog and the mounted files always match.
 */
export async function renderResources(
	bundleDir: string,
	index: { digest: Digest; componentDigests: Record<Component, Digest>; files: BundleFile[] },
	guestResourcesPath: string,
): Promise<RenderedResources> {
	const toolGuidance: Partial<Record<KernelToolName, string>> = {};
	for (const tool of KERNEL_TOOL_NAMES) {
		const text = await readOptional(join(bundleDir, "tools", `${tool}.md`));
		if (text?.trim()) toolGuidance[tool] = text.trim();
	}
	const skills = (await readSkills(bundleDir, index.files)).map((skill) => ({
		...skill,
		location: posix.join(guestResourcesPath, skill.path),
	}));
	const hasMemory = index.files.some((f) => f.path.startsWith("memory/"));
	const processorText = await readOptional(join(bundleDir, "observation", "processor.json"));
	const attached = (await readOptional(join(bundleDir, "prompt", "attached.md")))?.trim();
	return {
		digest: index.digest,
		componentDigests: index.componentDigests,
		...(attached ? { attachedPrompt: attached } : {}),
		toolGuidance,
		skills,
		...(hasMemory ? { memoryLocation: posix.join(guestResourcesPath, "memory") } : {}),
		memoryHasIndex: index.files.some((f) => f.path === "memory/index.md"),
		...(processorText ? { processor: validateProcessorSpec(JSON.parse(processorText)) } : {}),
	};
}

export function skillCatalog(resources: RenderedResources): string {
	return formatSkillsForSystemPrompt(
		resources.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.location,
			content: "",
			...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
		})),
	);
}
