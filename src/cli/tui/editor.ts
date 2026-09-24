import { Editor, type EditorOptions, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { editorTheme } from "./style.ts";

export interface EditorActions {
	/** Esc outside autocomplete. */
	escape(): void;
	ctrlC(): void;
	/** Ctrl+D on an empty editor. */
	exit(): void;
	selectModel(): void;
	toggleTools(): void;
	toggleThinking(): void;
}

/**
 * The prompt editor with Lily's app keys (after Pi's CustomEditor) and the
 * working status embedded in its top border while a run is active.
 */
export class LilyEditor extends Editor {
	actions: EditorActions | undefined;
	/** Styled status for the top border, or undefined when idle. */
	status: (() => string | undefined) | undefined;

	constructor(tui: TUI, options: EditorOptions = {}) {
		super(tui, editorTheme, options);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const status = this.status?.();
		if (!status || hiddenLineCount > 0 || width < 12) return super.renderTopBorder(width, hiddenLineCount);
		const text = truncateToWidth(status, width - 5, "…");
		return `${this.borderColor("── ")}${text}${this.borderColor(` ${"─".repeat(Math.max(0, width - visibleWidth(text) - 4))}`)}`;
	}

	override handleInput(data: string): void {
		const actions = this.actions;
		if (actions) {
			if (matchesKey(data, "escape") && !this.isShowingAutocomplete()) return actions.escape();
			if (matchesKey(data, "ctrl+c")) return actions.ctrlC();
			if (matchesKey(data, "ctrl+d") && this.getText().length === 0) return actions.exit();
			if (matchesKey(data, "ctrl+l")) return actions.selectModel();
			if (matchesKey(data, "ctrl+o")) return actions.toggleTools();
			if (matchesKey(data, "ctrl+t")) return actions.toggleThinking();
		}
		// Enter on a slash-command argument completion (/model gpt…) picks it *and* runs the
		// command; pi-tui's editor would only insert it.
		if (matchesKey(data, "enter") && this.isShowingAutocomplete() && /^\/\S+\s/.test(this.getText())) {
			super.handleInput("\t");
			super.handleInput("\r");
			return;
		}
		super.handleInput(data);
	}
}
