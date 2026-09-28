import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { EnvdClient } from "./envd-client.ts";
import type { EnvironmentUsage } from "./types.ts";

const run = promisify(execFile);

type Reader = (path: string) => Promise<string | undefined>;

const hostRead: Reader = (path) => readFile(path, "utf8").catch(() => undefined);

/** CPU and peak memory of a cgroup (v2 files, with the v1 equivalents as fallback). */
async function cgroupUsage(read: Reader, dir: string): Promise<{ cpuMs?: number; memoryPeakBytes?: number }> {
	const out: { cpuMs?: number; memoryPeakBytes?: number } = {};
	const cpuStat = await read(`${dir}/cpu.stat`);
	const usec = cpuStat ? /^usage_usec (\d+)$/m.exec(cpuStat)?.[1] : undefined;
	if (usec !== undefined) out.cpuMs = Math.round(Number(usec) / 1000);
	else {
		const ns = (await read(`${dir}/cpuacct/cpuacct.usage`))?.trim();
		if (ns && /^\d+$/.test(ns)) out.cpuMs = Math.round(Number(ns) / 1e6);
	}
	const peak = ((await read(`${dir}/memory.peak`)) ?? (await read(`${dir}/memory/memory.max_usage_in_bytes`)))?.trim();
	if (peak && /^\d+$/.test(peak)) out.memoryPeakBytes = Number(peak);
	return out;
}

function usage(values: { cpuMs?: number; memoryPeakBytes?: number }, source: EnvironmentUsage["source"]): EnvironmentUsage | undefined {
	return values.cpuMs === undefined && values.memoryPeakBytes === undefined ? undefined : { ...values, source };
}

/** Usage of the host cgroup a process belongs to (Linux, cgroup v2). */
export async function hostCgroupUsage(dir: string): Promise<EnvironmentUsage | undefined> {
	return usage(await cgroupUsage(hostRead, dir), "host");
}

/** The cgroup v2 directory of a host process, e.g. /sys/fs/cgroup/system.slice/docker-….scope. */
export async function hostCgroupDir(pid: number): Promise<string | undefined> {
	const text = await hostRead(`/proc/${pid}/cgroup`);
	const path = text ? /^0::(\/\S*)$/m.exec(text)?.[1] : undefined;
	return path === undefined ? undefined : `/sys/fs/cgroup${path === "/" ? "" : path}`;
}

/** Usage read inside the guest from its own cgroup (a container's cgroup namespace root). */
export async function guestCgroupUsage(client: EnvdClient): Promise<EnvironmentUsage | undefined> {
	const read: Reader = (path) => client.readFile(path, 4096).then((r) => r.data.toString("utf8"), () => undefined);
	return usage(await cgroupUsage(read, "/sys/fs/cgroup"), "guest");
}

let clockTicks: Promise<number> | undefined;

/** CPU time (all threads) and peak resident memory of a host process, from /proc (Linux). */
export async function hostProcessUsage(pid: number): Promise<EnvironmentUsage | undefined> {
	clockTicks ??= run("getconf", ["CLK_TCK"]).then(
		(r) => Number(r.stdout.trim()) || 100,
		() => 100,
	);
	const out: { cpuMs?: number; memoryPeakBytes?: number } = {};
	const stat = await hostRead(`/proc/${pid}/stat`);
	// Fields after the command name, which is parenthesized and may contain spaces: state is field 3, utime 14, stime 15.
	const fields = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
	if (fields && fields.length > 12) out.cpuMs = Math.round(((Number(fields[11]) + Number(fields[12])) * 1000) / (await clockTicks));
	const status = await hostRead(`/proc/${pid}/status`);
	const hwm = status ? /^VmHWM:\s+(\d+) kB$/m.exec(status)?.[1] : undefined;
	if (hwm !== undefined) out.memoryPeakBytes = Number(hwm) * 1024;
	return usage(out, "host");
}
