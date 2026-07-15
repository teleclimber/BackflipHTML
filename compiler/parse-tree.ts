import { RewritingStream } from 'parse5-html-rewriting-stream';
import stream from 'node:stream';

import { BackflipError } from './errors.js';
import { attrLoc, tagLoc, tagSrcLoc, errorLoc } from './loc.js';
import { VOID_ELEMENTS } from './helpers.js';
import type { SourceLoc } from './types.js';

/**
 * Pass A of the compiler: build a dumb, faithful source tree from an HTML
 * slice using parse5's SAX events. This module has NO directive knowledge —
 * all `b-*` / `{{ }}` semantics live in lower.ts (Pass B).
 *
 * This is also the single point where parse5 `sourceCodeLocation` objects are
 * converted to our `SourceLoc` (via the loc.ts converters). Everything
 * downstream consumes `SourceLoc` only.
 */

export interface SourceAttr {
	name: string;             // as reported by parse5 (lowercased)
	value: string;
	loc?: SourceLoc;          // from sourceCodeLocation.attrs — converted here, once
}

export interface SourceElement {
	kind: 'element';
	tagName: string;
	attrs: SourceAttr[];
	selfClosing: boolean;     // explicit `/>` in source
	isVoid: boolean;          // tagName in VOID_ELEMENTS
	rawOpenTag: string;       // exact source text of the open tag (needed for
	                          // unresolvedRaw and error-recovery fallbacks)
	rawCloseTag?: string;     // exact source text of the close tag, when one was matched
	openLoc?: SourceLoc;      // converted from parse5 sourceCodeLocation
	closeLoc?: SourceLoc;
	children: SourceNode[];   // always empty for void / self-closing elements
}

// Text location as the parser reports it for text tokens; lowering only ever
// needs the start (interpolation locs are derived by scanning the raw text).
export interface TextLoc {
	startLine: number;
	startCol: number;
	startOffset: number;
}

export interface SourceText {
	kind: 'text';
	raw: string;              // exact source text (entities NOT decoded — parse5's raw)
	loc?: TextLoc;
	/**
	 * Set on error-recovery text (a stray or mismatched close tag demoted to
	 * text). Verbatim text is never split for `{{ }}` interpolation — the old
	 * streaming compiler pushed recovery raws directly, bypassing onText.
	 */
	verbatim?: boolean;
	/**
	 * The recovery error that produced this verbatim text. It rides on the node
	 * (instead of a separate error list) so that lowering emits it in document
	 * order, interleaved correctly with the errors lowering itself produces.
	 */
	error?: BackflipError;
}

export type SourceNode = SourceElement | SourceText;

/**
 * Build a faithful source tree from an HTML slice using parse5's SAX events.
 *
 * Malformed input never throws: recovery turns broken structure into
 * `SourceText` nodes carrying their `BackflipError` (see recovery rules below),
 * mirroring the old streaming compiler:
 *
 * - Stray end tag with an empty stack → "popped the last tagMatcher
 *   prematurely"; the end tag's raw text becomes (verbatim) text content at
 *   the current position.
 * - Mismatched end tag (`</b>` closing `<i>`) → "mismatched start/end tags";
 *   the open element stays open and the close tag's raw becomes text content
 *   inside it.
 * - Unclosed elements at EOF: no error; the elements simply never receive a
 *   `rawCloseTag`/`closeLoc` and keep the children collected so far.
 *
 * The returned `errors` list is reserved for problems that are not anchored to
 * a tree position; recovery errors ride on their SourceText node (see above).
 * Currently it is always empty — stream-level failures reject the promise.
 *
 * Comments and doctype nodes are silently dropped: the old streaming compiler
 * registered no comment/doctype handlers, so they never reached the AST. This
 * is pre-existing behavior preserved by this refactor, not a new decision.
 *
 * Known divergence from the old streaming compiler (deliberate, malformed
 * input only): a self-closing `<b-unwrap b-in="..."/>` used to be pushed onto
 * the tag stack anyway (the one unguarded push in the old code), which made
 * every subsequent close tag mismatch and cascade into recovery errors. The
 * tree builder treats all self-closing tags uniformly (no children), so the
 * cascade is gone; lowering still records the named slot.
 */
export function buildSourceTree(html: string, filename?: string): Promise<{ nodes: SourceNode[], errors: BackflipError[] }> {
	return new Promise((resolve, reject) => {
		const nodes: SourceNode[] = [];
		const errors: BackflipError[] = [];
		const stack: SourceElement[] = [];
		const container = (): SourceNode[] => stack.length > 0 ? stack[stack.length - 1].children : nodes;

		const s = new stream.Readable({ encoding: 'utf8' });
		s.push(html);
		s.push(null);

		const rewriteStream = new RewritingStream();

		rewriteStream.on('startTag', (tag, raw) => { try {
			const el: SourceElement = {
				kind: 'element',
				tagName: tag.tagName,
				attrs: tag.attrs.map((a) => {
					const attr: SourceAttr = { name: a.name, value: a.value };
					const loc = attrLoc(tag, a.name);
					if (loc) attr.loc = loc;
					return attr;
				}),
				selfClosing: !!tag.selfClosing,
				isVoid: VOID_ELEMENTS.has(tag.tagName),
				rawOpenTag: raw,
				children: [],
			};
			// fallbackLen = raw.length only matters if the parser ever omitted
			// endOffset; RewritingStream always supplies full locations.
			const openLoc = tagSrcLoc(tag, raw.length);
			if (openLoc) el.openLoc = openLoc;
			container().push(el);
			if (!el.selfClosing && !el.isVoid) stack.push(el);
		} catch (e) { reject(e); } });

		rewriteStream.on('endTag', (tag, raw) => { try {
			const open = stack.pop();
			if (!open) {
				container().push({
					kind: 'text', raw, verbatim: true,
					error: new BackflipError("popped the last tagMatcher prematurely", errorLoc(filename, tagLoc(tag))),
				});
				return;
			}
			if (open.tagName !== tag.tagName) {
				// Push the entry back: the open element stays open; the close tag
				// becomes text content inside it.
				stack.push(open);
				container().push({
					kind: 'text', raw, verbatim: true,
					error: new BackflipError(`mismatched start/end tags: ${open.tagName} ${tag.tagName}`, errorLoc(filename, tagLoc(tag))),
				});
				return;
			}
			open.rawCloseTag = raw;
			const closeLoc = tagSrcLoc(tag);
			if (closeLoc) open.closeLoc = closeLoc;
		} catch (e) { reject(e); } });

		rewriteStream.on('text', (textToken, raw) => { try {
			const node: SourceText = { kind: 'text', raw };
			const loc = textToken.sourceCodeLocation;
			if (loc) node.loc = { startLine: loc.startLine, startCol: loc.startCol, startOffset: loc.startOffset };
			// NOTE: adjacent text tokens are deliberately NOT merged. The old
			// compiler ran `{{ }}` splitting per text event, so an interpolation
			// split across two tokens never matched; merging here would change that.
			container().push(node);
		} catch (e) { reject(e); } });

		// No 'comment' / 'doctype' handlers: dropped (see doc comment).

		s.pipe(rewriteStream);
		s.on('error', (err) => { reject(err); });
		rewriteStream.on('error', (err) => { reject(err); });
		rewriteStream.on('end', () => {
			// Unclosed elements at EOF just stay on the stack — no error, their
			// collected children remain in place (matches the old compiler).
			resolve({ nodes, errors });
		});
	});
}
