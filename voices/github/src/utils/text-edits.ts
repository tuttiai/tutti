/** Most replacements one `edit_file` call may carry. */
export const MAX_EDITS = 50;

/** One exact-text replacement. */
export interface TextEdit {
  old_text: string;
  new_text: string;
}

/** The edited text, or why the edits were refused. */
export type EditOutcome = { ok: true; text: string } | { ok: false; problem: string };

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

function excerpt(text: string): string {
  const oneLine = text.replace(/\n/g, "\\n");
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

/**
 * Apply exact-text replacements in order, each against the text the previous
 * ones left. Every `old_text` must occur exactly once at its turn: missing
 * text means the caller read a different version or mistyped it, and text
 * that occurs twice would leave the choice of which to change to chance.
 * Either way nothing is changed, because a half-applied set is a broken file.
 *
 * @param text - The whole file as it stands.
 * @param edits - The replacements, applied first to last.
 * @returns The new text, or the first problem found.
 */
export function applyEdits(text: string, edits: readonly TextEdit[]): EditOutcome {
  let current = text;
  for (const [index, edit] of edits.entries()) {
    const which = `Edit ${index + 1} ("${excerpt(edit.old_text)}")`;
    if (edit.old_text === edit.new_text) return { ok: false, problem: `${which}: old_text and new_text are the same.` };
    const found = occurrences(current, edit.old_text);
    if (found === 0) {
      return {
        ok: false,
        problem: `${which}: old_text was not found. Read the file again with get_file_contents and copy the text exactly, including whitespace.`,
      };
    }
    if (found > 1) {
      return {
        ok: false,
        problem: `${which}: old_text occurs ${found} times. Include more of the surrounding lines so it matches once.`,
      };
    }
    const at = current.indexOf(edit.old_text);
    current = current.slice(0, at) + edit.new_text + current.slice(at + edit.old_text.length);
  }
  return { ok: true, text: current };
}
