/** Error carrying a stable machine-readable code for API and CLI surfaces. */
export class LilyError extends Error {
	readonly code: string;
	readonly details?: unknown;

	constructor(code: string, message: string, details?: unknown) {
		super(message);
		this.name = "LilyError";
		this.code = code;
		this.details = details;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
