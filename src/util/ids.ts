import { randomBytes } from "node:crypto";
import { uuidv7 } from "@earendil-works/pi-ai";

/** Time-sortable id with a readable prefix, e.g. `run_0199…`. */
export function newId(prefix: string): string {
	return `${prefix}_${uuidv7().replace(/-/g, "")}`;
}

export function randomToken(bytes = 16): string {
	return randomBytes(bytes).toString("hex");
}
