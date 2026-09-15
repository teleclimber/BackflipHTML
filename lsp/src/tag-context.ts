/**
 * What tag the cursor is in, and what encloses it — read from the document's
 * text rather than from a compiled tree.
 *
 * Text, because these answer while a tag or an attribute value is still being
 * typed: the compiled trees are only as fresh as the last save, so their spans
 * have already shifted out from under the cursor by the time a completion is
 * asked for. `resolve.ts` is the tree-based counterpart, exact once the file is
 * saved.
 */

import type { TextDocument } from 'vscode-languageserver-textdocument';
import { isCustomElementTagName, VOID_ELEMENTS } from '@backflip/html';

/** An opening tag and the text it spans, `<TAG …>` as authored. */
export interface OpeningTag {
	tagName: string;
	openTagText: string;
	/** Document offset of the `<`. */
	startOffset: number;
}

/** An opening tag that calls a partial, and the `b-part` value that says so. */
export interface CallSiteTag extends OpeningTag {
	/** The `b-part` value, or null when the tag is a custom element call. */
	bPartValue: string | null;
}

/** A tag name being typed, and the columns a completion replaces. */
export interface TagNameEdit {
	/** The name as authored up to the cursor; empty right after the `<`. */
	typed: string;
	/** Column of the name's first character, which is the one after the `<`. */
	start: number;
	/** Column one past the name's last character, which may sit after the cursor. */
	end: number;
}

/** An attribute whose quote is still open, and where its value sits on the line. */
export interface OpenAttrValue {
	/** The attribute name as authored. */
	name: string;
	/** The value from its opening quote up to the cursor. */
	typed: string;
	/** Column of the value's first character. */
	valueStart: number;
	/** Column one past the value's last character, before the closing quote. */
	valueEnd: number;
}

/**
 * Mask quoted attribute values with spaces so embedded `<` or `>` don't confuse
 * a tag-boundary scan. Lengths are preserved.
 */
export function maskQuoted(s: string): string {
	return s
		.replace(/"[^"]*"/g, m => ' '.repeat(m.length))
		.replace(/'[^']*'/g, m => ' '.repeat(m.length));
}

/**
 * The opening tag whose attribute area contains the cursor. Walks back up to
 * ~50 lines and forward up to ~50 lines so multi-line opening tags resolve.
 * `openTagText` runs to the `>`, or to the end of the lookahead window when
 * none is found within it.
 */
export function findEnclosingOpeningTag(
	doc: TextDocument, lineIdx: number, character: number,
): OpeningTag | null {
	const maxLookback = 50;
	const maxLookahead = 50;
	const startLine = Math.max(0, lineIdx - maxLookback);
	const before = doc.getText({
		start: { line: startLine, character: 0 },
		end: { line: lineIdx, character },
	});
	const beforeMasked = maskQuoted(before);
	const lastGt = beforeMasked.lastIndexOf('>');
	const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)/g;
	let lastMatch: RegExpExecArray | null = null;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(beforeMasked)) !== null) lastMatch = m;
	if (!lastMatch) return null;
	if (lastGt > lastMatch.index) return null; // tag closed before cursor

	const after = doc.getText({
		start: { line: lineIdx, character },
		end: { line: lineIdx + maxLookahead, character: 0 },
	});
	const afterMasked = maskQuoted(after);
	const closeIdx = afterMasked.indexOf('>');
	const afterPart = closeIdx !== -1 ? after.substring(0, closeIdx + 1) : after;

	return {
		tagName: lastMatch[1],
		openTagText: before.substring(lastMatch.index) + afterPart,
		startOffset: doc.offsetAt({ line: startLine, character: 0 }) + lastMatch.index,
	};
}

/** Every complete tag in `text`, with the quoted regions already masked. */
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;

/**
 * The call an opening tag makes, or null when it makes none. Two forms call a
 * partial: `b-part="…"` on any tag, and a custom element tag name.
 */
export function asCallSiteTag(tag: OpeningTag): CallSiteTag | null {
	const bPart = tag.openTagText.match(/\bb-part=(["'])([^"']*)\1/);
	if (bPart) return { ...tag, bPartValue: bPart[2] };
	if (isCustomElementTagName(tag.tagName)) return { ...tag, bPartValue: null };
	return null;
}

/**
 * The partial call the cursor's tag sits directly inside, or null when its
 * parent element is not a call.
 *
 * Counts tags backwards from the cursor's own tag rather than taking the
 * nearest `b-part` written above it: a call nested in a call body, or a sibling
 * call that has already closed, would otherwise answer for a tag it does not
 * contain. Void and self-closing tags open nothing, so they are skipped.
 *
 * `b-in` is the caller: it only routes into a slot when it sits on a direct
 * child of a call body, so a parent that is not a call means the `b-in` names
 * nothing.
 */
export function findEnclosingCallSiteTag(
	doc: TextDocument, lineIdx: number, character: number,
): CallSiteTag | null {
	const own = findEnclosingOpeningTag(doc, lineIdx, character);
	const cutoff = own ? own.startOffset : doc.offsetAt({ line: lineIdx, character });
	const before = doc.getText().substring(0, cutoff);
	const masked = maskQuoted(before);

	const tags: { index: number; isClosing: boolean; tagName: string; opensScope: boolean }[] = [];
	let m: RegExpExecArray | null;
	TAG_RE.lastIndex = 0;
	while ((m = TAG_RE.exec(masked)) !== null) {
		const tagName = m[2];
		const selfClosing = m[3].trimEnd().endsWith('/');
		tags.push({
			index: m.index,
			isClosing: m[1] === '/',
			tagName,
			opensScope: !selfClosing && !VOID_ELEMENTS.has(tagName.toLowerCase()),
		});
	}

	let depth = 0;
	for (let i = tags.length - 1; i >= 0; i--) {
		const tag = tags[i];
		if (tag.isClosing) {
			depth++;
			continue;
		}
		if (!tag.opensScope) continue;
		if (depth > 0) {
			depth--;
			continue;
		}
		// An unclosed opening tag: the element the cursor's tag is a child of.
		const openTagText = before.substring(tag.index, masked.indexOf('>', tag.index) + 1);
		return asCallSiteTag({ tagName: tag.tagName, openTagText, startOffset: tag.index });
	}
	return null;
}

/**
 * The tag name being typed at the cursor, and the extent a completion replaces.
 *
 * Null unless the text before the cursor ends at a `<` followed by nothing but
 * name characters — which is what separates a tag being named from an attribute
 * area, a closing tag, or ordinary text. The extent reaches forward past the
 * cursor so a name edited from the middle is rewritten rather than doubled.
 */
export function tagNameBeingTyped(line: string, character: number): TagNameEdit | null {
	const m = line.substring(0, character).match(/<([a-zA-Z][a-zA-Z0-9-]*)?$/);
	if (!m || m.index === undefined) return null;
	const ahead = line.substring(character).match(/^[a-zA-Z0-9-]*/)![0];
	return {
		typed: m[1] ?? '',
		start: m.index + 1,
		end: character + ahead.length,
	};
}

/**
 * The attribute whose quote is still open at the cursor, given the whole line.
 * `namePattern` is a regex source matching the attribute names to answer for.
 *
 * The value's extent is where completion items get written: back to the opening
 * quote and forward to the closing one, so accepting an item rewrites the value
 * rather than appending to what is already typed.
 */
export function openAttrValueEdit(
	line: string, character: number, namePattern: string,
): OpenAttrValue | null {
	const m = line.substring(0, character).match(new RegExp(`(${namePattern})=(["'])([^"']*)$`));
	if (!m) return null;
	const typed = m[3];
	const ahead = line.substring(character).match(/^[^"']*/)![0];
	return {
		name: m[1],
		typed,
		valueStart: character - typed.length,
		valueEnd: character + ahead.length,
	};
}
