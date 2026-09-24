import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { KERNEL_TOOL_NAMES } from "../kernel/tools/specs.ts";
import { type Digest, digestOf, sha256 } from "../util/hash.ts";
import { ProcessorSpecError, validateProcessorSpec } from "./processor/dsl.ts";

/**
 * A resource bundle R = (P, M, S, U, F): everything the proposer may change.
 * The kernel K (loop, tools, prompt assembly, compaction, storage) is never
 * part of a bundle.
 *
 *   manifest.json                 name / description
 *   prompt/attached.md            P  attached system-prompt instructions
 *   tools/{read,bash,edit,write}.md  U  per-tool guidance (separate prompt area)
 *   skills/<name>/SKILL.md (+files)  S  skills, discovered by catalog, read on demand
 *   memory/**                     M  experience library, read through normal tools
 *   observation/processor.json    F  declarative observation processor
 */
export const BUNDLE_FORMAT = "lily.bundle/v1";

export const COMPONENTS = ["P", "M", "S", "U", "F"] as const;
export type Component = (typeof COMPONENTS)[number];

export const COMPONENT_DIRS: Record<Component, string> = {
	P: "prompt",
	M: "memory",
	S: "skills",
	U: "tools",
	F: "observation",
};

export const COMPONENT_NAMES: Record<Component, string> = {
	P: "attached prompt",
	M: "memory",
	S: "skills",
	U: "tool guidance",
	F: "observation processor",
};

export interface BundleManifest {
	format: typeof BUNDLE_FORMAT;
	name: string;
	description?: string;
	/** Present on composite bundles: which bundle each component was taken from. */
	composite?: Partial<Record<Component, Digest>>;
}

export interface BundleFile {
	path: string;
	size: number;
	sha256: Digest;
	executable: boolean;
}

export interface BundleIndex {
	digest: Digest;
	manifest: BundleManifest;
	componentDigests: Record<Component, Digest>;
	files: BundleFile[];
	warnings: string[];
}

export interface BundleLimits {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	maxAttachedPromptBytes: number;
	maxToolGuidanceBytes: number;
	maxSkillDescription: number;
}

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
	maxFiles: 2000,
	maxFileBytes: 2 * 1024 * 1024,
	maxTotalBytes: 32 * 1024 * 1024,
	maxAttachedPromptBytes: 16 * 1024,
	maxToolGuidanceBytes: 4 * 1024,
	maxSkillDescription: 1024,
};

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db"]);

export class BundleValidationError extends Error {
	readonly problems: string[];

	constructor(problems: string[]) {
		super(`Invalid resource bundle:\n- ${problems.join("\n- ")}`);
		this.name = "BundleValidationError";
		this.problems = problems;
	}
}

export function componentOf(path: string): Component | "manifest" | undefined {
	if (path === "manifest.json") return "manifest";
	const top = path.split("/")[0];
	return COMPONENTS.find((c) => COMPONENT_DIRS[c] === top);
}

interface ScannedFile extends BundleFile {
	absolute: string;
}

/**
 * Walks a bundle directory without following symlinks. Rejects anything that
 * is not a regular file or directory so a bundle can never smuggle links or
 * device nodes into an environment.
 */
async function scan(root: string, limits: BundleLimits, problems: string[]): Promise<ScannedFile[]> {
	const files: ScannedFile[] = [];
	let total = 0;
	const walk = async (dir: string): Promise<void> => {
		for (const name of (await readdir(dir)).sort()) {
			if (IGNORED_NAMES.has(name)) continue;
			const absolute = join(dir, name);
			const rel = relative(root, absolute).split(sep).join(posix.sep);
			if (/[\u0000-\u001f\\]/.test(name)) {
				problems.push(`${rel}: invalid characters in file name`);
				continue;
			}
			const info = await lstat(absolute);
			if (info.isSymbolicLink()) {
				problems.push(`${rel}: symbolic links are not allowed`);
			} else if (info.isDirectory()) {
				await walk(absolute);
			} else if (info.isFile()) {
				if (info.size > limits.maxFileBytes) problems.push(`${rel}: file exceeds ${limits.maxFileBytes} bytes`);
				total += info.size;
				const data = await readFile(absolute);
				files.push({ path: rel, size: info.size, sha256: sha256(data), executable: (info.mode & 0o111) !== 0, absolute });
			} else {
				problems.push(`${rel}: only regular files and directories are allowed`);
			}
			if (files.length > limits.maxFiles) {
				problems.push(`bundle has more than ${limits.maxFiles} files`);
				return;
			}
		}
	};
	await walk(root);
	if (total > limits.maxTotalBytes) problems.push(`bundle exceeds ${limits.maxTotalBytes} bytes in total`);
	return files;
}

export interface SkillMetadata {
	name: string;
	description: string;
	/** Bundle-relative path of SKILL.md. */
	path: string;
	disableModelInvocation?: boolean;
}

/** Parses SKILL.md frontmatter (`---\nname: …\ndescription: …\n---`). */
export function parseSkillFrontmatter(text: string): { data: Record<string, unknown>; body: string } | undefined {
	const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return undefined;
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) return undefined;
	const raw = parseYaml(normalized.slice(4, end));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const after = normalized.slice(end + 4);
	return { data: raw as Record<string, unknown>, body: after.startsWith("\n") ? after.slice(1) : after };
}

/**
 * Scans and validates a bundle directory against the fixed kernel rules and
 * returns its content-addressed index. Nothing in the bundle is executed.
 */
export async function indexBundle(root: string, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): Promise<BundleIndex> {
	const problems: string[] = [];
	const warnings: string[] = [];
	const files = await scan(root, limits, problems);
	const byPath = new Map(files.map((f) => [f.path, f]));

	let manifest: BundleManifest | undefined;
	const manifestFile = byPath.get("manifest.json");
	if (!manifestFile) problems.push("manifest.json is missing");
	else {
		try {
			const parsed = JSON.parse(await readFile(manifestFile.absolute, "utf8")) as BundleManifest;
			if (parsed.format !== BUNDLE_FORMAT) problems.push(`manifest.json: format must be "${BUNDLE_FORMAT}"`);
			if (typeof parsed.name !== "string" || parsed.name.trim() === "" || parsed.name.length > 128) {
				problems.push("manifest.json: name must be a non-empty string (≤128 chars)");
			}
			manifest = parsed;
		} catch (error) {
			problems.push(`manifest.json: ${(error as Error).message}`);
		}
	}

	const skillDirs = new Set<string>();
	for (const file of files) {
		const component = componentOf(file.path);
		if (component === undefined) {
			problems.push(`${file.path}: not part of any component (allowed: manifest.json, ${Object.values(COMPONENT_DIRS).join("/, ")}/)`);
			continue;
		}
		const parts = file.path.split("/");
		if (component === "P" && file.path !== "prompt/attached.md") problems.push(`${file.path}: prompt/ may only contain attached.md`);
		if (component === "P" && file.size > limits.maxAttachedPromptBytes) {
			problems.push(`${file.path}: attached prompt exceeds ${limits.maxAttachedPromptBytes} bytes`);
		}
		if (component === "U") {
			const tool = parts.length === 2 ? parts[1]!.replace(/\.md$/, "") : "";
			if (!(KERNEL_TOOL_NAMES as readonly string[]).includes(tool) || !parts[1]!.endsWith(".md")) {
				problems.push(`${file.path}: tools/ may only contain ${KERNEL_TOOL_NAMES.map((t) => `${t}.md`).join(", ")}`);
			} else if (file.size > limits.maxToolGuidanceBytes) {
				problems.push(`${file.path}: tool guidance exceeds ${limits.maxToolGuidanceBytes} bytes`);
			}
		}
		if (component === "F" && file.path !== "observation/processor.json") {
			problems.push(`${file.path}: observation/ may only contain processor.json`);
		}
		if (component === "S") {
			if (parts.length < 3) problems.push(`${file.path}: skills must live in skills/<name>/`);
			else skillDirs.add(parts[1]!);
		}
	}

	for (const dir of skillDirs) {
		if (!SKILL_NAME.test(dir)) problems.push(`skills/${dir}: skill directory names must match ${SKILL_NAME}`);
		const skillFile = byPath.get(`skills/${dir}/SKILL.md`);
		if (!skillFile) {
			problems.push(`skills/${dir}: SKILL.md is missing`);
			continue;
		}
		const parsed = parseSkillFrontmatter(await readFile(skillFile.absolute, "utf8"));
		if (!parsed) {
			problems.push(`skills/${dir}/SKILL.md: missing YAML frontmatter`);
			continue;
		}
		if (parsed.data.name !== dir) problems.push(`skills/${dir}/SKILL.md: frontmatter name must equal "${dir}"`);
		const description = parsed.data.description;
		if (typeof description !== "string" || description.trim() === "") {
			problems.push(`skills/${dir}/SKILL.md: description is required`);
		} else if (description.length > limits.maxSkillDescription) {
			problems.push(`skills/${dir}/SKILL.md: description exceeds ${limits.maxSkillDescription} characters`);
		}
	}

	const processorFile = byPath.get("observation/processor.json");
	if (processorFile) {
		try {
			validateProcessorSpec(JSON.parse(await readFile(processorFile.absolute, "utf8")));
		} catch (error) {
			const message = error instanceof ProcessorSpecError || error instanceof SyntaxError ? error.message : String(error);
			problems.push(`observation/processor.json: ${message}`);
		}
	}

	const hasMemory = files.some((f) => componentOf(f.path) === "M");
	if (hasMemory && !byPath.has("memory/index.md")) warnings.push("memory/ has no index.md entry point");

	if (problems.length > 0 || !manifest || !manifestFile) throw new BundleValidationError(problems);

	const publicFiles: BundleFile[] = files.map(({ absolute: _absolute, ...file }) => file);
	const componentDigests = Object.fromEntries(
		COMPONENTS.map((c) => [c, digestOf(publicFiles.filter((f) => componentOf(f.path) === c))]),
	) as Record<Component, Digest>;
	const digest = digestOf({ format: BUNDLE_FORMAT, manifest: manifestFile.sha256, components: componentDigests });
	return { digest, manifest, componentDigests, files: publicFiles, warnings };
}

/** Skill metadata of an indexed bundle directory. */
export async function readSkills(root: string, files: BundleFile[]): Promise<SkillMetadata[]> {
	const skills: SkillMetadata[] = [];
	for (const file of files) {
		const parts = file.path.split("/");
		if (parts.length !== 3 || parts[0] !== "skills" || parts[2] !== "SKILL.md") continue;
		const parsed = parseSkillFrontmatter(await readFile(join(root, file.path), "utf8"));
		if (!parsed) continue;
		skills.push({
			name: String(parsed.data.name),
			description: String(parsed.data.description),
			path: file.path,
			...(parsed.data["disable-model-invocation"] === true ? { disableModelInvocation: true } : {}),
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}
