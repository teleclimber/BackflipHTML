import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
import { BackflipError } from './errors.js';
import { appendCoalesced } from './walk.js';
import {
	attrErrorLoc, bDataNameLoc, errorLoc, interpolationLoc,
	dataLocAttr as dataLocAttrPure,
} from './loc.js';
import {
	isCustomElementTagName, effectiveAttrNames, parseBPartValue, parseBForValue,
	DOCUMENT_LEVEL_TAGS, VOID_ELEMENTS, INTERPOLATION_RE,
} from './helpers.js';
import { classifyOpenTagAttrs, buildAttrParts } from './attrs.js';
import { validateStaticAssetAttr, type AssetAttrCtx } from './assets.js';
import type { SourceNode, SourceElement, SourceText, SourceAttr, TextLoc } from './parse-tree.js';
import type {
	SourceLoc, TNode, RawTNode, PrintTNode, ForTNode, IfTNode, IfBranch,
	SlotTNode, PartialRefTNode, BPartCallTNode, CustomElementCallTNode, ParentTNode,
	RootTNode, NamedPartialRoot, CustomElementPartialRoot, CompiledFile, CompileOptions, PartialDef, PartialBinding,
	ElementTNode, AttrPart,
} from './types.js';

/**
 * Pass B of the compiler: lower a faithful SourceNode tree (from
 * parse-tree.ts) for one partial slice into the compiled TNode AST. All
 * directive semantics live here.
 *
 * The lowering deliberately mirrors the old streaming compiler's cursor state
 * machine — an explicit `St` (cur_tnode / cur_parent / current partial root)
 * threaded through the recursion in place of the old tag stack — because a
 * number of long-standing behaviors are cursor artifacts that tests and
 * downstream consumers observe (see the "quirk:" characterization tests in
 * compiler_test.ts):
 *
 * - text following a self-closing custom-element call or b-part carrier merges
 *   into the raw node BEFORE the call (the cursor is not advanced for those);
 * - the first text lowered directly into a b-unwrap partial root, a custom
 *   element definition root, or a b-unwrap flow container seeds an empty
 *   RawTNode when it starts with an interpolation;
 * - content following a closed flow element inside slot content escapes the
 *   slot (the cursor restores to the flow node's outer parent);
 * - flow-wrapped elements never receive closeTagLoc (the stack entry holds the
 *   if/for node for b-else chaining, not the element).
 *
 * No module-level mutable state: everything is threaded through `Ctx`
 * (per-run immutable services + shared sinks) and `St` (the cursor).
 */

// Per-run context: error sink, output, and services. Created once per
// lowerSlice call; the fields themselves are stable (errors/compiledFile are
// appended into).
interface Ctx {
	filename?: string;
	includeLocs: boolean;
	assetCtx: AssetAttrCtx;
	errors: BackflipError[];
	compiledFile: CompiledFile;
}

// The cursor: a direct port of the old closure variables currentPartialRoot /
// currentPartialName / cur_tnode / cur_parent. cur_parent is maintained in
// lockstep with cur_tnode (any code that assigns one considers the other).
interface St {
	root: RootTNode | null;      // current partial (null = outside any partial)
	name: string | null;
	curTnode: TNode | null;
	curParent: ParentTNode | null;
}

// Innermost slot-collection context, passed down the recursion. Replaces the
// old tag-stack scan (getSlotCollection): handlers that used to push an entry
// with a structural tnode pass `null` to their children; handlers that pushed
// a slotCollection pass that; {tag}-only entries pass the inherited value.
interface SlotCollection {
	partialRef: PartialRefTNode;
	partialRefParent: ParentTNode;   // container of the partialRef
	currentSlot: string;
}

/**
 * Lower a faithful SourceNode tree for one partial slice into the compiled
 * TNode AST. Errors accumulate into the returned list; the source tree is not
 * mutated.
 */
export function lowerSlice(
	nodes: SourceNode[],
	partialDef: PartialDef,
	options: CompileOptions | undefined,
): { compiledFile: CompiledFile, errors: BackflipError[] } {
	const filename = partialDef.loc.filename;
	const ctx: Ctx = {
		filename,
		includeLocs: options?.includeLocs ?? false,
		assetCtx: { assetMap: options?.assetMap, assetDirs: options?.assetDirs, filename },
		errors: [],
		compiledFile: { partials: new Map() },
	};
	const st: St = { root: null, name: null, curTnode: null, curParent: null };
	for (const node of nodes) {
		lowerNode(node, st, null, 0, ctx);
	}
	return { compiledFile: ctx.compiledFile, errors: ctx.errors };
}

// --- small shared helpers ---

function isContainer(el: SourceElement): boolean {
	return !el.selfClosing && !el.isVoid;
}

function findAttr(el: SourceElement, name: string): SourceAttr | undefined {
	return el.attrs.find(a => a.name === name);
}

function findAttrLoc(el: SourceElement, name: string): SourceLoc | undefined {
	return findAttr(el, name)?.loc;
}

// Error location for a diagnostic about one attribute of `el`.
function attrErrLoc(el: SourceElement, attrName: string, ctx: Ctx): { filename?: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
	return attrErrorLoc(findAttrLoc(el, attrName), el.openLoc, ctx.filename);
}

// Error location pointing at the open tag itself.
function tagErrLoc(el: SourceElement, ctx: Ctx): { filename?: string, line?: number, col?: number } | undefined {
	return errorLoc(ctx.filename, { line: el.openLoc?.startLine, col: el.openLoc?.startCol });
}

type ErrLoc = { filename?: string, line?: number, col?: number, endLine?: number, endCol?: number };

// Parse an expression and forward any interpretBackcode errors (e.g. unsupported
// operator, syntax error) into the run's error accumulator. Without this the
// parsed AST would still be embedded into the output and surface at runtime as
// a ReferenceError or similar.
function interpretBackcodeAt(code: string, loc: ErrLoc | SourceLoc | undefined, ctx: Ctx): Parsed {
	const parsed = interpretBackcode(code);
	for (const err of parsed.errs) {
		ctx.errors.push(new BackflipError(err, loc ? toErrLoc(loc, ctx.filename) : undefined));
	}
	return parsed;
}

function toErrLoc(loc: ErrLoc | SourceLoc, filename?: string): ErrLoc {
	if ('startLine' in loc) {
		return { filename, line: loc.startLine, col: loc.startCol, endLine: loc.endLine, endCol: loc.endCol };
	}
	return loc;
}

// --- cursor primitives (ports of the old closure helpers) ---

// Routing rule: when cur_parent is null OR is the current partial root, the
// lowering is at a "slot-routable" boundary — content goes into the innermost
// slot collection if one exists. Once it has descended into an explicit
// container (ElementTNode / ForTNode / IfBranch), cur_parent points to it and
// content nests inside that container regardless of slot context.
function isAtSlotBoundary(st: St): boolean {
	return st.curParent === null || st.curParent === st.root;
}

// Append raw text at the cursor: merge into cur when it is a raw node
// (note: cur is not necessarily the container's LAST node — see the
// self-closing-call quirk), else push a fresh RawTNode.
function pushRaw(cur: TNode, parent: ParentTNode, raw: string): TNode {
	if (cur.type === 'raw') {
		cur.raw += raw;
		return cur;
	}
	const raw_node: RawTNode = { type: 'raw', raw };
	parent.tnodes!.push(raw_node);
	return raw_node;
}

// Push a raw string into the right place (slot or normal).
function pushRawHere(raw: string, st: St, sc: SlotCollection | null): TNode | null {
	if (sc && isAtSlotBoundary(st)) {
		const slotName = sc.currentSlot;
		if (!sc.partialRef.slots[slotName]) {
			sc.partialRef.slots[slotName] = [];
		}
		const arr = sc.partialRef.slots[slotName];
		appendCoalesced(arr, { type: 'raw', raw });
		return arr[arr.length - 1];
	}
	const container: ParentTNode | null = st.curParent ?? st.root;
	if (container === null) return null;
	if (st.curTnode === null) {
		const raw_node: RawTNode = { type: 'raw', raw };
		container.tnodes!.push(raw_node);
		st.curTnode = raw_node;
		if (st.curParent === null) st.curParent = container;
		return raw_node;
	}
	return pushRaw(st.curTnode, container, raw);
}

// Push a TNode into the current parent or slot.
function pushNodeHere(node: TNode, st: St, sc: SlotCollection | null): void {
	if (sc && isAtSlotBoundary(st)) {
		const slotName = sc.currentSlot;
		if (!sc.partialRef.slots[slotName]) {
			sc.partialRef.slots[slotName] = [];
		}
		sc.partialRef.slots[slotName].push(node);
		return;
	}
	const container: ParentTNode | null = st.curParent ?? st.root;
	if (container !== null) {
		container.tnodes!.push(node);
		if (st.curParent === null) st.curParent = container;
	}
}

// --- attr assembly ---

// Walk an element's attrs through the shared classifier and forward any
// validation errors into the run's accumulator.
function classifyAttrs(el: SourceElement, excludeAttrs: string[], ctx: Ctx) {
	const { segments, hasBind, errors: errs } = classifyOpenTagAttrs(el, excludeAttrs, ctx.assetCtx);
	if (errs.length) ctx.errors.push(...errs);
	return { segments, hasBind };
}

function dataLocAttr(el: SourceElement, st: St, ctx: Ctx): string {
	return dataLocAttrPure(el.openLoc, { includeLocs: ctx.includeLocs, currentPartialName: st.name, filename: ctx.filename });
}

// Build an ElementTNode for a regular HTML element. Attrs are produced via
// classifyOpenTagAttrs (which already filters b-data:* / b-attr:* and validates
// static assets) and converted to AttrPart[]; `excludeAttrs` strips any additional
// directives that belong to a wrapping construct (e.g. `b-part`, `b-slot`, `b-if`).
// The `data-loc=...` string (when enabled) is appended as a synthesized trailing
// static AttrPart so it renders after the source attrs.
function buildElement(el: SourceElement, excludeAttrs: string[], st: St, ctx: Ctx): ElementTNode {
	const { segments } = classifyAttrs(el, excludeAttrs, ctx);
	const locStr = dataLocAttr(el, st, ctx);
	const attrs = buildAttrParts(segments, locStr);
	const elem: ElementTNode = {
		type: 'element',
		tagName: el.tagName,
		attrs,
		tnodes: [],
	};
	if (VOID_ELEMENTS.has(el.tagName)) elem.isVoid = true;
	if (el.selfClosing) elem.selfClosing = true;
	if (el.openLoc) {
		elem.openTagLoc = el.openLoc;
		elem.loc = el.openLoc;  // updated to span through closeTagLoc when close is matched
	}
	return elem;
}

// Like buildElement but returns just the AttrPart[]. Used for custom element
// definitions and call sites, where the wrapping tag is merged at render time
// (no ElementTNode is constructed for it).
function buildAttrPartsFromTag(el: SourceElement, excludeAttrs: string[], st: St, ctx: Ctx): AttrPart[] {
	const { segments } = classifyAttrs(el, excludeAttrs, ctx);
	const locStr = dataLocAttr(el, st, ctx);
	return buildAttrParts(segments, locStr);
}

// Collect b-data:* bindings from a call-site tag (b-part and custom-element calls).
function collectBDataBindings(el: SourceElement, ctx: Ctx): PartialBinding[] {
	const bindings: PartialBinding[] = [];
	for (const attr of el.attrs) {
		if (attr.name.startsWith('b-data:')) {
			const bindingName = attr.name.slice('b-data:'.length);
			const binding: PartialBinding = { kind: 'expr', name: bindingName, data: interpretBackcodeAt(attr.value, attrErrLoc(el, attr.name, ctx), ctx) };
			const nameLoc = bDataNameLoc(attr.loc, bindingName);
			if (nameLoc) binding.nameLoc = nameLoc;
			bindings.push(binding);
		}
	}
	return bindings;
}

// --- text lowering (the single {{ }} splitter) ---

type TextPiece = { kind: 'raw', text: string } | { kind: 'print', node: PrintTNode };

/**
 * Split a raw text run on `{{ expr }}` interpolations. Empty `{{ }}` stays
 * raw. Expression errors are forwarded into ctx.errors as pieces are produced,
 * so error order matches the old per-match emission.
 *
 * `locateErrors` preserves a pre-existing asymmetry: the old slot-text handler
 * attached filename/line/col to expression errors, while onText (element text)
 * passed the SourceLoc object straight to BackflipError, which reads none of
 * its fields — i.e. element-text expression errors were effectively unlocated.
 */
function splitInterpolations(raw: string, textLoc: TextLoc | undefined, locateErrors: boolean, ctx: Ctx): TextPiece[] {
	const pieces: TextPiece[] = [];
	let raw_it = 0;
	for (const m of raw.matchAll(INTERPOLATION_RE)) {
		if (m.index > raw_it) {
			pieces.push({ kind: 'raw', text: raw.substring(raw_it, m.index) });
		}
		const code_str = m[0].substring(2, m[0].length - 2).trim();
		if (!code_str) {
			// empty {{ }}, treat as raw text
			pieces.push({ kind: 'raw', text: m[0] });
			raw_it = m.index + m[0].length;
			continue;
		}
		const printLoc = textLoc ? interpolationLoc(textLoc, raw.substring(0, m.index), m[0]) : undefined;
		const parsed = interpretBackcode(code_str);
		for (const err of parsed.errs) {
			ctx.errors.push(new BackflipError(err, locateErrors && printLoc ? toErrLoc(printLoc, ctx.filename) : undefined));
		}
		const print_node: PrintTNode = { type: 'print', data: parsed };
		if (printLoc) print_node.loc = printLoc;
		pieces.push({ kind: 'print', node: print_node });
		raw_it = m.index + m[0].length;
	}
	if (raw_it < raw.length) {
		pieces.push({ kind: 'raw', text: raw.substring(raw_it) });
	}
	return pieces;
}

function lowerText(node: SourceText, st: St, sc: SlotCollection | null, ctx: Ctx): void {
	// Recovery errors ride on the text node so they surface in document order.
	if (node.error) ctx.errors.push(node.error);

	if (node.verbatim) {
		// Error-recovery text (a demoted close tag): pushed as-is, never split
		// for {{ }} — port of the old endTag recovery path.
		if (st.curTnode !== null && st.curParent !== null) {
			st.curTnode = pushRaw(st.curTnode, st.curParent, node.raw);
		} else if (st.root !== null) {
			pushRawHere(node.raw, st, sc);
		}
		return;
	}

	if (st.root === null) return; // outside any partial

	if (sc && isAtSlotBoundary(st)) {
		// Insert text (with {{ }} support) into the current slot.
		const slotName = sc.currentSlot;
		if (!sc.partialRef.slots[slotName]) {
			sc.partialRef.slots[slotName] = [];
		}
		const arr = sc.partialRef.slots[slotName];
		for (const piece of splitInterpolations(node.raw, node.loc, true, ctx)) {
			if (piece.kind === 'raw') appendCoalesced(arr, { type: 'raw', raw: piece.text });
			else arr.push(piece.node);
		}
	} else {
		const container: ParentTNode | null = st.curParent ?? st.root;
		if (container === null) return;
		if (st.curTnode === null) {
			// First content in this container — seed with an empty raw as the
			// cursor anchor (pre-existing behavior: an interpolation-first text
			// leaves this empty RawTNode in the output).
			const init: RawTNode = { type: 'raw', raw: '' };
			container.tnodes!.push(init);
			st.curTnode = init;
			if (st.curParent === null) st.curParent = container;
		}
		let cur = st.curTnode;
		for (const piece of splitInterpolations(node.raw, node.loc, false, ctx)) {
			if (piece.kind === 'raw') {
				cur = pushRaw(cur, container, piece.text);
			} else {
				container.tnodes!.push(piece.node);
				cur = piece.node;
			}
		}
		st.curTnode = cur;
	}
}

// --- element lowering ---

function lowerNode(node: SourceNode, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	if (node.kind === 'text') lowerText(node, st, sc, ctx);
	else lowerElement(node, st, sc, depth, ctx);
}

function lowerChildren(children: SourceNode[], st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	for (const child of children) {
		lowerNode(child, st, sc, depth, ctx);
	}
}

/**
 * End-of-element bookkeeping, the port of the old endTag handler for a matched
 * close tag. `entry` mirrors the old TagMatcher entry ({tnode, parent} saved at
 * open time); omit it for {tag}-only entries (fallbacks, b-unwrap roots,
 * skipped tags), which restore nothing.
 *
 * Unclosed elements (EOF) have no rawCloseTag: nothing runs — no restore, and
 * the partial's meta.endOffset keeps its last value.
 */
function closeElement(el: SourceElement, st: St, depth: number, ctx: Ctx, entry?: { tnode: TNode, parent: ParentTNode | null }): void {
	if (el.rawCloseTag === undefined) return;

	// Update closeTagLoc / extend the element loc through the close tag bounds
	// (lets LSP and the flatten pass see the full span). Only entries holding an
	// ElementTNode get this — flow entries hold the if/for node instead.
	if (entry && entry.tnode.type === 'element') {
		const closeLoc = el.closeLoc;
		if (closeLoc) {
			const elem = entry.tnode as ElementTNode;
			elem.closeTagLoc = closeLoc;
			const openLoc = elem.openTagLoc;
			if (openLoc) {
				elem.loc = {
					startLine: openLoc.startLine,
					startCol: openLoc.startCol,
					startOffset: openLoc.startOffset,
					endLine: closeLoc.endLine,
					endCol: closeLoc.endCol,
					endOffset: closeLoc.endOffset,
				};
			}
		}
	}

	// A depth-0 close with an open partial ends the partial (the old
	// "tag_stack drained" condition). This is usually the partial root's own
	// close tag, but after a self-closing/void definition root it can be any
	// top-level element's close (pre-existing behavior).
	if (depth === 0 && st.root !== null) {
		st.root.meta!.endOffset = (el.closeLoc?.startOffset ?? 0) + el.rawCloseTag.length;
		st.root = null;
		st.name = null;
		st.curTnode = null;
		st.curParent = null;
		return;
	}

	if (entry) {
		st.curParent = entry.parent ?? null;
		st.curTnode = entry.tnode ?? null;
	}
	// No entry ({tag}-only): leave the cursor unchanged — the popped entry just
	// balanced the old stack.
}

// Error-recovery: drop the tag back to a raw string and keep lowering balanced.
// Used when a handler can't construct its structured node (bad b-for value,
// dangling b-else, multiple flow attrs, misplaced b-name). The children still
// lower into the current container (with the inherited slot context) and the
// close tag is dropped, matching the old fallbackToRawTag + endTag behavior.
function lowerFallbackTag(el: SourceElement, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	const new_cur = pushRawHere(el.rawOpenTag, st, sc);
	if (st.curTnode !== null) {
		st.curTnode = new_cur;
		// curParent unchanged: pushRawHere appends a sibling within the same container.
	}
	if (isContainer(el)) {
		lowerChildren(el.children, st, sc, depth + 1, ctx);
		closeElement(el, st, depth, ctx);
	}
}

// --- the dispatcher (port of the old startTag handler) ---

function lowerElement(el: SourceElement, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	const bNameAttr = findAttr(el, 'b-name');
	if (bNameAttr) return lowerBName(el, bNameAttr, st, sc, depth, ctx);

	// Top-level custom element tag: treat as a partial definition
	if (depth === 0 && st.root === null && isCustomElementTagName(el.tagName)) {
		return lowerCustomElementDefinition(el, st, sc, depth, ctx);
	}

	// b-attr is only allowed on custom element definition tags. Anything that
	// reaches this point in the dispatcher is NOT a custom element definition
	// (those returned above), so any b-attr:* here is an error.
	for (const attr of el.attrs) {
		if (attr.name.startsWith('b-attr:')) {
			ctx.errors.push(new BackflipError(
				`b-attr is only allowed on custom element partial definitions`,
				attrErrLoc(el, attr.name, ctx)
			));
		}
		if (attr.name === 'b-script') {
			ctx.errors.push(new BackflipError(
				`b-script is only allowed on custom element partial definitions`,
				attrErrLoc(el, attr.name, ctx)
			));
		}
	}

	const bPartAttr = findAttr(el, 'b-part');
	if (bPartAttr) return lowerBPart(el, bPartAttr, st, sc, depth, ctx);

	const bSlotAttr = findAttr(el, 'b-slot');
	if (bSlotAttr) return lowerBSlot(el, bSlotAttr, st, sc, depth, ctx);

	const bInAttr = findAttr(el, 'b-in');
	if (bInAttr && sc) return lowerBIn(el, bInAttr, st, sc, depth, ctx);

	// Skip everything outside a partial (children are still walked so that
	// nested b-name / b-attr misplacement errors are reported).
	if (st.root === null) {
		if (isContainer(el)) {
			lowerChildren(el.children, st, sc, depth + 1, ctx);
			closeElement(el, st, depth, ctx);
		}
		return;
	}

	// Track document-level tags inside partials
	if (DOCUMENT_LEVEL_TAGS.has(el.tagName)) {
		st.root.meta!.isDocumentLevel = true;
	}

	// --- b-for / b-if / b-else-if / b-else ---
	const b_as = el.attrs.filter(attr => ['b-for', 'b-if', 'b-else-if', 'b-else'].includes(attr.name));
	if (b_as.length > 1) {
		ctx.errors.push(new BackflipError("more than one b-attr", tagErrLoc(el, ctx)));
		return lowerFallbackTag(el, st, sc, depth, ctx);
	}

	// Custom element call site. With a single flow directive, the call is
	// wrapped in the matching ForTNode / IfTNode (equivalent to wrapping in
	// <b-unwrap b-for|if|...>). Without a flow directive, it's a plain call.
	// b-part precedence already won above; this only runs for plain custom element tags.
	if (isCustomElementTagName(el.tagName)) {
		if (b_as.length === 1) return lowerCustomElementCallWithFlow(el, b_as[0], st, sc, depth, ctx);
		return lowerCustomElementCall(el, st, sc, depth, ctx);
	}

	if (b_as.length === 1) return lowerFlowOnRegularTag(el, b_as[0], st, sc, depth, ctx);

	lowerRegularTag(el, st, sc, depth, ctx);
}

// --- directive handlers ---

function lowerBName(el: SourceElement, bNameAttr: SourceAttr, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	if (depth > 0) {
		ctx.errors.push(new BackflipError("b-name is only allowed on top-level elements", attrErrLoc(el, 'b-name', ctx)));
		// Treat as raw tag within current partial
		return lowerFallbackTag(el, st, sc, depth, ctx);
	}

	for (const flow of ['b-if', 'b-for', 'b-else-if', 'b-else'] as const) {
		if (findAttr(el, flow)) {
			ctx.errors.push(new BackflipError(`${flow} is not allowed on a partial definition`, attrErrLoc(el, flow, ctx)));
		}
	}

	// b-attr is only allowed on custom element partial definitions (a hyphenated tag).
	// b-name partials are NOT custom element partials — flag b-attr:* as an error here.
	for (const attr of el.attrs) {
		if (attr.name.startsWith('b-attr:')) {
			ctx.errors.push(new BackflipError(
				`b-attr is only allowed on custom element partial definitions`,
				attrErrLoc(el, attr.name, ctx)
			));
		}
		if (attr.name === 'b-script') {
			ctx.errors.push(new BackflipError(
				`b-script is only allowed on custom element partial definitions`,
				attrErrLoc(el, attr.name, ctx)
			));
		}
	}

	const partialName = bNameAttr.value;
	const openLoc = el.openLoc;
	const partialRoot: NamedPartialRoot = { type: 'root', kind: 'named', tnodes: [], meta: {
		startOffset: openLoc?.startOffset ?? 0,
		endOffset: openLoc?.startOffset ?? 0, // updated on close
		startLine: openLoc?.startLine ?? 1,
		startCol: openLoc?.startCol ?? 1,
		isDocumentLevel: DOCUMENT_LEVEL_TAGS.has(el.tagName),
	} };
	partialRoot.loc = findAttrLoc(el, 'b-name');
	partialRoot.exported = el.attrs.some(a => a.name === 'b-export');
	ctx.compiledFile.partials.set(partialName, partialRoot);

	st.root = partialRoot;
	st.name = partialName;

	if (el.tagName === 'b-unwrap') {
		// Don't emit a wrapping element; body content flows directly into partialRoot.tnodes.
		st.curTnode = null;
		st.curParent = partialRoot;
		if (!el.selfClosing) {
			lowerChildren(el.children, st, sc, depth + 1, ctx);
			closeElement(el, st, depth, ctx);
		}
		// Self-closing: the partial stays "open" (following top-level content
		// flows into it) and meta.endOffset keeps its initial value — the old
		// code only updated it in the non-b-unwrap branch.
	} else {
		const elem = buildElement(el, ['b-name', 'b-export'], st, ctx);
		partialRoot.tnodes.push(elem);
		st.curTnode = elem;
		st.curParent = elem;
		if (isContainer(el)) {
			lowerChildren(el.children, st, null, depth + 1, ctx);
			closeElement(el, st, depth, ctx, { tnode: elem, parent: partialRoot });
		} else {
			// Self-closing or void element: end offset is end of this tag. The
			// cursor stays inside `elem` (pre-existing quirk: following top-level
			// content nests inside the void root element).
			partialRoot.meta!.endOffset = (openLoc?.startOffset ?? 0) + el.rawOpenTag.length;
		}
	}
}

function lowerCustomElementDefinition(el: SourceElement, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	// Pre-conditions: top level (depth === 0), no partial open, no b-name attr,
	// and isCustomElementTagName(el.tagName) — the dispatcher guarantees these.

	for (const flow of ['b-if', 'b-for', 'b-else-if', 'b-else'] as const) {
		if (findAttr(el, flow)) {
			ctx.errors.push(new BackflipError(`${flow} is not allowed on a partial definition`, attrErrLoc(el, flow, ctx)));
		}
	}

	const partialName = el.tagName;
	const openLoc = el.openLoc;
	const partialRoot: CustomElementPartialRoot = { type: 'root', kind: 'custom-element', tnodes: [], meta: {
		startOffset: openLoc?.startOffset ?? 0,
		endOffset: openLoc?.startOffset ?? 0, // updated on close
		startLine: openLoc?.startLine ?? 1,
		startCol: openLoc?.startCol ?? 1,
		isDocumentLevel: false,
	} };
	if (openLoc) partialRoot.loc = openLoc;
	partialRoot.exported = el.attrs.some(a => a.name === 'b-export');

	// Parse b-attr:* declarations on the custom element definition tag.
	const bAttrs: { name: string; isBool: boolean; loc?: SourceLoc }[] = [];
	for (const attr of el.attrs) {
		if (!attr.name.startsWith('b-attr:')) continue;
		// HTML lowercases attribute names, so a b-attr name written with
		// uppercase letters won't match when referenced inside the partial body.
		// parse-tree.ts preserves the original-case name as `rawName`.
		if (attr.rawName) {
			const afterPrefix = attr.rawName.slice('b-attr:'.length);
			const dotIdx = afterPrefix.indexOf('.');
			const namePart = dotIdx === -1 ? afterPrefix : afterPrefix.slice(0, dotIdx);
			if (/[A-Z]/.test(namePart)) {
				const errLoc = attrErrLoc(el, attr.name, ctx) ?? { filename: ctx.filename };
				ctx.errors.push(new BackflipError(
					`b-attr name "${namePart}" contains uppercase letters; HTML attribute names are lowercased, so this declares "${namePart.toLowerCase()}". Use a lowercase name to avoid confusion.`,
					{ ...errLoc, severity: 'warning' }
				));
			}
		}
		const rest = attr.name.slice('b-attr:'.length);
		const m = rest.match(/^([^.]+)(?:\.(.+))?$/);
		if (!m || !m[1]) {
			ctx.errors.push(new BackflipError(
				`invalid b-attr directive "${attr.name}"`,
				attrErrLoc(el, attr.name, ctx)
			));
			continue;
		}
		const declName = m[1];
		const modifier = m[2];
		if (modifier !== undefined && modifier !== 'bool') {
			ctx.errors.push(new BackflipError(
				`unknown b-attr modifier '${modifier}' (only '.bool' is supported)`,
				attrErrLoc(el, attr.name, ctx)
			));
			continue;
		}
		if (attr.value !== '') {
			ctx.errors.push(new BackflipError(
				`b-attr does not accept a value (reserved for future use)`,
				attrErrLoc(el, attr.name, ctx)
			));
			continue;
		}
		const entry: { name: string; isBool: boolean; loc?: SourceLoc } = { name: declName, isBool: modifier === 'bool' };
		if (attr.loc) entry.loc = attr.loc;
		bAttrs.push(entry);
	}

	// Validate: a declared b-attr name must not also appear as a plain/bind attribute
	// on the same definition tag. Use effectiveAttrNames over all attrs (which already
	// strips the b-attr:* declarations themselves).
	if (bAttrs.length > 0) {
		const allEffective = effectiveAttrNames(el.attrs);
		for (const ba of bAttrs) {
			if (allEffective.includes(ba.name)) {
				ctx.errors.push(new BackflipError(
					`attribute '${ba.name}' on the custom element definition tag conflicts with b-attr:${ba.name}; remove the plain attribute`,
					attrErrLoc(el, ba.name, ctx) ?? tagErrLoc(el, ctx)
				));
			}
		}
	}

	// definitionAttrNames excludes b-attr-declared names so that the call-site-vs-definition
	// conflict check (compiler/partials.ts) doesn't false-positive when the caller passes the same name.
	const bAttrNameSet = new Set(bAttrs.map(b => b.name));
	partialRoot.definitionAttrNames = effectiveAttrNames(el.attrs).filter(n => !bAttrNameSet.has(n));
	if (bAttrs.length > 0) partialRoot.bAttrs = bAttrs;

	// Parse b-script: the hand-coded web-component module to auto-include. Its
	// value is an @name/... asset path, validated and stored unresolved (an
	// 'entry' script) — resolveAssetRefs rewrites the @prefix later, exactly as
	// for asset attributes. Only one b-script is allowed per definition.
	const bScriptAttrs = el.attrs.filter(a => a.name === 'b-script');
	if (bScriptAttrs.length > 1) {
		ctx.errors.push(new BackflipError(
			`more than one b-script on a custom element definition`,
			attrErrLoc(el, 'b-script', ctx) ?? tagErrLoc(el, ctx)
		));
	}
	if (bScriptAttrs.length > 0) {
		const { refs, originalValue, error } = validateStaticAssetAttr('b-script', bScriptAttrs[0], el.openLoc, ctx.assetCtx);
		if (error) {
			ctx.errors.push(error);
		} else if (refs.length > 0) {
			(partialRoot.scripts ??= []).push({ url: originalValue, kind: 'entry' });
		}
	}

	ctx.compiledFile.partials.set(partialName, partialRoot);

	st.root = partialRoot;
	st.name = partialName;

	// For custom element partials, the open tag is rendered by the call site (merged
	// with caller-side attrs into one tag), so no wrapping ElementTNode is constructed.
	// The definition-side attrs are stored as a flat AttrPart[] for the call-site renderer
	// to emit in childCtx.
	partialRoot.definitionAttrs = buildAttrPartsFromTag(el, ['b-export', 'b-script'], st, ctx);
	st.curTnode = null;
	st.curParent = partialRoot;
	if (isContainer(el)) {
		lowerChildren(el.children, st, sc, depth + 1, ctx);
		closeElement(el, st, depth, ctx);
	} else {
		partialRoot.meta!.endOffset = (openLoc?.startOffset ?? 0) + el.rawOpenTag.length;
	}
}

// Build the wrapping ForTNode / IfTNode (or just append a new IfBranch for
// b-else / b-else-if) for a flow directive. Returns:
//   - `container`: where the directive's body content (open tag, partial-ref, etc.)
//     should be pushed (the for_node itself, or the new IfBranch).
//   - `outer`: the outer structural node, i.e. the ForTNode or IfTNode. Equal to
//     `container` for b-for; the enclosing IfTNode for b-if / b-else-if / b-else.
// On error (bad b-for syntax, dangling b-else, etc.), pushes the error and
// returns null — the caller falls back to lowerFallbackTag.
// Shared between the regular flow handler and the custom-element-call-with-flow handler.
function setupFlowContainer(el: SourceElement, flowAttr: SourceAttr, st: St, sc: SlotCollection | null, ctx: Ctx): { container: ParentTNode, outer: TNode, outerParent: ParentTNode } | null {
	const flowParent: ParentTNode = sc
		? sc.partialRefParent
		: (st.curParent ?? st.root!);

	if (flowAttr.name === 'b-for') {
		const parsed = parseBForValue(flowAttr.value);
		if ('error' in parsed) {
			ctx.errors.push(new BackflipError(parsed.error, attrErrLoc(el, 'b-for', ctx)));
			return null;
		}
		for (const err of parsed.iterable.errs) {
			ctx.errors.push(new BackflipError(err, attrErrLoc(el, 'b-for', ctx)));
		}
		const for_node: ForTNode = { type: 'for', iterable: parsed.iterable, valName: parsed.valName, tnodes: [] };
		for_node.loc = findAttrLoc(el, 'b-for');
		if (sc) pushNodeHere(for_node, st, sc);
		else flowParent.tnodes!.push(for_node);
		return { container: for_node, outer: for_node, outerParent: flowParent };
	}

	if (flowAttr.name === 'b-if') {
		const if_node: IfTNode = { type: 'if', branches: [] };
		const branch: IfBranch = { condition: interpretBackcodeAt(flowAttr.value, attrErrLoc(el, 'b-if', ctx), ctx), tnodes: [] };
		branch.loc = findAttrLoc(el, 'b-if');
		if_node.branches.push(branch);
		if (sc) pushNodeHere(if_node, st, sc);
		else flowParent.tnodes!.push(if_node);
		return { container: branch, outer: if_node, outerParent: flowParent };
	}

	// b-else-if / b-else: chain onto a preceding b-if among current siblings.
	if (!st.curTnode) {
		ctx.errors.push(new BackflipError("b-else-if/b-else must follow a b-if block", attrErrLoc(el, flowAttr.name, ctx)));
		return null;
	}
	let if_node: IfTNode | null;
	if (sc) {
		const arr = sc.partialRef.slots[sc.currentSlot] || [];
		if_node = findPrecedingIf(arr);
	} else {
		// The cursor itself may be the if node (right after the flow element
		// closed); otherwise scan the current container's siblings backwards,
		// skipping whitespace-only raws.
		if_node = st.curTnode.type === 'if'
			? st.curTnode
			: (st.curParent ? findPrecedingIf(st.curParent.tnodes!) : null);
	}
	if (!if_node) {
		ctx.errors.push(new BackflipError("b-else-if/b-else must follow a b-if block", attrErrLoc(el, flowAttr.name, ctx)));
		return null;
	}
	if (flowAttr.name === 'b-else' && flowAttr.value) {
		ctx.errors.push(new BackflipError("b-else should not have a value", attrErrLoc(el, 'b-else', ctx)));
		// fall through — branch is still added so the structure stays correct
	}
	const condition = flowAttr.name === 'b-else-if' ? interpretBackcodeAt(flowAttr.value, attrErrLoc(el, 'b-else-if', ctx), ctx) : undefined;
	const branch: IfBranch = { condition, tnodes: [] };
	branch.loc = findAttrLoc(el, flowAttr.name);
	if_node.branches.push(branch);
	return { container: branch, outer: if_node, outerParent: flowParent };
}

// Scan a sibling list backwards for the IfTNode a b-else / b-else-if chains to,
// skipping whitespace-only raws. Returns null when the nearest non-whitespace
// sibling isn't an if (or the list is empty).
function findPrecedingIf(siblings: TNode[]): IfTNode | null {
	for (let i = siblings.length - 1; i >= 0; i--) {
		const n = siblings[i];
		if (n.type === 'if') return n;
		if (n.type === 'raw' && n.raw.trim() === '') continue;
		break;
	}
	return null;
}

// Build the PartialRefTNode for a custom element call site. Does NOT push it
// into a parent — the caller decides where it lives (directly under the
// current parent for plain calls, inside a flow node's container for
// `<my-elem b-for|if|...>` calls).
function buildCustomElementPartialRef(el: SourceElement, st: St, ctx: Ctx): CustomElementCallTNode {
	const bindings = collectBDataBindings(el, ctx);

	// Flow directives on the call site are consumed by the wrapping ForTNode /
	// IfTNode (built in lowerCustomElementCallWithFlow) and must never appear in
	// the rendered tag. They're excluded here so the AttrPart[] doesn't contain them.
	// In the non-flow call path they're absent anyway, so the extra excludes are no-ops.
	const callerAttrs = buildAttrPartsFromTag(el, ['b-export', 'b-if', 'b-for', 'b-else', 'b-else-if'], st, ctx);

	const callerAttrInfos: NonNullable<CustomElementCallTNode['callerAttrInfos']> = [];
	for (const attr of el.attrs) {
		const n = attr.name;
		if (n === 'b-name' || n === 'b-export') continue;
		if (n === 'b-if' || n === 'b-for' || n === 'b-else' || n === 'b-else-if') continue;
		if (n === 'b-part' || n === 'b-slot' || n === 'b-in') continue;
		if (n.startsWith('b-data:')) continue;
		if (n.startsWith('b-attr:')) continue;
		const aLoc = attr.loc;
		if (n.startsWith('b-bind:') || n.startsWith(':')) {
			const stripped = n.startsWith('b-bind:') ? n.slice('b-bind:'.length) : n.slice(1);
			const effName = stripped.replace(/~$/, '');
			const info: { name: string; kind: 'plain' | 'expr'; value: string; expr?: Parsed; loc?: SourceLoc } = {
				name: effName,
				kind: 'expr',
				value: attr.value,
				expr: interpretBackcode(attr.value),
			};
			if (aLoc) info.loc = aLoc;
			callerAttrInfos.push(info);
		} else {
			const effName = n.endsWith('~') ? n.slice(0, -1) : n;
			const info: { name: string; kind: 'plain' | 'expr'; value: string; expr?: Parsed; loc?: SourceLoc } = {
				name: effName,
				kind: 'plain',
				value: attr.value,
			};
			if (aLoc) info.loc = aLoc;
			callerAttrInfos.push(info);
		}
	}

	const partialRef: CustomElementCallTNode = {
		type: 'partial-ref',
		kind: 'custom-element',
		file: null,                        // resolved post-parse via global registry
		partialName: el.tagName,
		slots: { 'default': [] },
		slotLocs: {},
		bindings,
		callerAttrs,
		callerTagName: el.tagName,
		callerAttrNames: effectiveAttrNames(el.attrs),
		callerAttrInfos,
		unresolvedRaw: el.rawOpenTag,
	};
	if (el.openLoc) partialRef.loc = el.openLoc;
	return partialRef;
}

function lowerCustomElementCall(el: SourceElement, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	// Pre-conditions: not a top-level definition, isCustomElementTagName, no
	// b-name / b-part / flow directive (see lowerCustomElementCallWithFlow for
	// flow). Inside a partial (the dispatcher's "skip outside partial" path
	// runs before this).
	const oldParent: ParentTNode | null = st.curParent;
	const containerParent: ParentTNode = st.curParent ?? st.root!;
	const partialRef = buildCustomElementPartialRef(el, st, ctx);
	pushNodeHere(partialRef, st, sc);

	if (isContainer(el)) {
		// Switch to slot mode: curParent = null so body content routes into the
		// partial-ref's default slot (until a child opens a new container which
		// sets its own curParent).
		st.curParent = null;
		st.curTnode = null;
		const childSc: SlotCollection = { partialRef, partialRefParent: containerParent, currentSlot: 'default' };
		lowerChildren(el.children, st, childSc, depth + 1, ctx);
		closeElement(el, st, depth, ctx, { tnode: partialRef, parent: oldParent });
	}
	// Self-closing: the cursor is deliberately NOT advanced (pre-existing
	// quirk: following text merges into the raw before the call).
}

// `<my-elem b-for|if|else-if|else>` — the call site is wrapped in a ForTNode
// or IfTNode (semantically identical to <b-unwrap b-for=...><my-elem>...</my-elem></b-unwrap>).
function lowerCustomElementCallWithFlow(el: SourceElement, flowAttr: SourceAttr, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	const oldParent: ParentTNode | null = st.curParent;
	const fc = setupFlowContainer(el, flowAttr, st, sc, ctx);
	if (!fc) return lowerFallbackTag(el, st, sc, depth, ctx);
	const partialRef = buildCustomElementPartialRef(el, st, ctx);
	fc.container.tnodes!.push(partialRef);
	if (isContainer(el)) {
		// Slot mode for body content (routes into partial-ref.slots.default).
		// On close, the cursor is repositioned at fc.outer so that a following
		// b-else can chain to this if_node among siblings of fc.outerParent.
		st.curParent = null;
		st.curTnode = null;
		const childSc: SlotCollection = { partialRef, partialRefParent: fc.container, currentSlot: 'default' };
		lowerChildren(el.children, st, childSc, depth + 1, ctx);
		closeElement(el, st, depth, ctx, { tnode: fc.outer, parent: fc.outerParent });
	} else {
		// Self-closing call: restore curParent (no body to process).
		st.curParent = oldParent;
		st.curTnode = fc.outer;
	}
}

function lowerBPart(el: SourceElement, bPartAttr: SourceAttr, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	// b-part outside any partial is ignored
	if (st.root === null) {
		if (isContainer(el)) {
			lowerChildren(el.children, st, sc, depth + 1, ctx);
			closeElement(el, st, depth, ctx);
		}
		return;
	}
	const { file, partialName } = parseBPartValue(bPartAttr.value);

	const bindings = collectBDataBindings(el, ctx);

	const partialRef: BPartCallTNode = {
		type: 'partial-ref',
		kind: 'b-part',
		file,
		partialName,
		slots: { 'default': [] },
		slotLocs: {},
		bindings,
	};
	partialRef.loc = findAttrLoc(el, 'b-part');

	const oldParent: ParentTNode | null = st.curParent;
	const containerParent: ParentTNode = st.curParent ?? st.root!;

	let outerNode: TNode;
	if (el.tagName === 'b-unwrap') {
		// No wrapping element; the partial-ref is emitted directly into the parent.
		pushNodeHere(partialRef, st, sc);
		outerNode = partialRef;
	} else {
		// Build a wrapping ElementTNode whose single child is the partial-ref.
		// The wrapping element's attrs come from the source tag (excluding b-part / b-data:*).
		const elem = buildElement(el, ['b-part'], st, ctx);
		elem.tnodes.push(partialRef);
		pushNodeHere(elem, st, sc);
		outerNode = elem;
	}

	if (isContainer(el)) {
		// Slot mode: curParent = null routes body content into partialRef.slots.default.
		st.curParent = null;
		st.curTnode = null;
		const childSc: SlotCollection = { partialRef, partialRefParent: containerParent, currentSlot: 'default' };
		lowerChildren(el.children, st, childSc, depth + 1, ctx);
		closeElement(el, st, depth, ctx, { tnode: outerNode, parent: oldParent });
	}
	// Self-closing: cursor not advanced (same quirk as self-closing calls).
}

function lowerBSlot(el: SourceElement, bSlotAttr: SourceAttr, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	// b-slot outside any partial is ignored
	if (st.root === null) {
		if (isContainer(el)) {
			lowerChildren(el.children, st, sc, depth + 1, ctx);
			closeElement(el, st, depth, ctx);
		}
		return;
	}
	const slotName = bSlotAttr.value !== '' ? bSlotAttr.value : undefined;
	const slot_node: SlotTNode = { type: 'slot', name: slotName };
	slot_node.loc = findAttrLoc(el, 'b-slot');

	if (el.tagName === 'b-unwrap') {
		// No wrapping element; the slot insertion point is emitted directly.
		// Body content (default content of the slot tag) follows as siblings of slot_node.
		pushNodeHere(slot_node, st, sc);
		st.curTnode = slot_node;
		// curParent unchanged.
		if (!el.selfClosing) {
			lowerChildren(el.children, st, sc, depth + 1, ctx);
			closeElement(el, st, depth, ctx);
		}
	} else {
		// Build wrapping ElementTNode with the slot insertion point as its first child;
		// any body content of the b-slot tag follows as later children of the element.
		const elem = buildElement(el, ['b-slot'], st, ctx);
		elem.tnodes.push(slot_node);
		const oldParent: ParentTNode | null = st.curParent;
		pushNodeHere(elem, st, sc);
		st.curParent = elem;
		st.curTnode = slot_node;
		if (isContainer(el)) {
			lowerChildren(el.children, st, null, depth + 1, ctx);
			closeElement(el, st, depth, ctx, { tnode: elem, parent: oldParent });
		}
		// Self-closing/void: curParent deliberately stays on `elem`
		// (pre-existing quirk: following siblings nest inside the element).
	}
}

function lowerBIn(el: SourceElement, bInAttr: SourceAttr, st: St, sc: SlotCollection, depth: number, ctx: Ctx): void {
	const slotName = bInAttr.value || 'default';
	if (!sc.partialRef.slots[slotName]) {
		sc.partialRef.slots[slotName] = [];
	}
	const bInLoc = findAttrLoc(el, 'b-in');
	if (bInLoc) {
		if (!sc.partialRef.slotLocs) sc.partialRef.slotLocs = {};
		sc.partialRef.slotLocs[slotName] = bInLoc;
	}

	if (el.tagName === 'b-unwrap') {
		// Switch slot context only; no wrapping element. Body content routes into the new slot.
		// (A self-closing <b-unwrap b-in/> simply has no body; the old streaming
		// compiler instead poisoned its tag stack here — see parse-tree.ts.)
		const childSc: SlotCollection = { partialRef: sc.partialRef, partialRefParent: sc.partialRefParent, currentSlot: slotName };
		lowerChildren(el.children, st, childSc, depth + 1, ctx);
		closeElement(el, st, depth, ctx);
	} else {
		// Build wrapping ElementTNode for the carrying tag, pushed directly into the target
		// slot array. Body content nests inside that element.
		const elem = buildElement(el, ['b-in'], st, ctx);
		sc.partialRef.slots[slotName].push(elem);
		const oldParent: ParentTNode | null = st.curParent;
		st.curParent = elem;
		st.curTnode = elem;
		if (isContainer(el)) {
			lowerChildren(el.children, st, null, depth + 1, ctx);
			closeElement(el, st, depth, ctx, { tnode: elem, parent: oldParent });
		} else {
			st.curParent = oldParent;
			st.curTnode = elem;
		}
	}
}

// Handle a flow directive (b-for, b-if, b-else-if, b-else) on a regular
// (non-custom-element) tag. The wrapping ForTNode/IfTNode/IfBranch comes
// from setupFlowContainer; if the carrying tag isn't b-unwrap, we then nest
// an ElementTNode inside that container so the tag is rendered inside each
// iteration / branch.
function lowerFlowOnRegularTag(el: SourceElement, flowAttr: SourceAttr, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	const oldParent: ParentTNode | null = st.curParent;
	const fc = setupFlowContainer(el, flowAttr, st, sc, ctx);
	if (!fc) return lowerFallbackTag(el, st, sc, depth, ctx);
	if (el.tagName === 'b-unwrap') {
		// Body flows directly into fc.container (no wrapping element).
		st.curParent = fc.container;
		st.curTnode = null;
		if (!el.selfClosing) {
			lowerChildren(el.children, st, null, depth + 1, ctx);
			// On close, resume at fc.outer (the wrapping if_node/for_node) so that
			// b-else-if/b-else can chain to it among siblings of fc.outerParent.
			closeElement(el, st, depth, ctx, { tnode: fc.outer, parent: fc.outerParent });
		} else {
			st.curParent = oldParent;
			st.curTnode = fc.outer;
		}
	} else {
		const elem = buildElement(el, [flowAttr.name], st, ctx);
		fc.container.tnodes!.push(elem);
		st.curParent = elem;
		st.curTnode = elem;
		if (isContainer(el)) {
			lowerChildren(el.children, st, null, depth + 1, ctx);
			// The close entry holds fc.outer (not the element) for b-else
			// chaining, which is also why flow-wrapped elements never get a
			// closeTagLoc.
			closeElement(el, st, depth, ctx, { tnode: fc.outer, parent: fc.outerParent });
		} else {
			st.curParent = oldParent;
			st.curTnode = fc.outer;
		}
	}
}

function lowerRegularTag(el: SourceElement, st: St, sc: SlotCollection | null, depth: number, ctx: Ctx): void {
	const elem = buildElement(el, [], st, ctx);
	const oldParent: ParentTNode | null = st.curParent;
	pushNodeHere(elem, st, sc);
	st.curParent = elem;
	st.curTnode = elem;
	if (isContainer(el)) {
		lowerChildren(el.children, st, null, depth + 1, ctx);
		closeElement(el, st, depth, ctx, { tnode: elem, parent: oldParent });
	} else {
		// Self-closing or void: no body to process; restore.
		st.curParent = oldParent;
		st.curTnode = elem;
	}
}
