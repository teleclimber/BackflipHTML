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
 * The lowering is recursive and bottom-up: every `lower*` function *returns*
 * the TNodes it produced, and its caller decides where they land. The container
 * an output belongs to is therefore a pure function of the position in the
 * source tree — there is no cursor, and no handler reaches into a sibling's
 * output.
 *
 * Two things are threaded down the recursion:
 *
 * - `PartialCtx` — the definition currently being lowered (its root and name)
 *   plus the per-run services. Immutable per partial; `errors` is a shared
 *   append-only sink, so errors come out in document order simply because the
 *   recursion visits nodes in document order.
 * - `siblings` — the output list being built at this level. Only b-else /
 *   b-else-if reads it, to find the b-if it chains onto (`findPrecedingIf`).
 *
 * Slot routing lives in exactly one place: `lowerCallBody`, which fills a
 * partial-ref's slots. Being "in a call body" is not a state — it is simply
 * being a direct child of that loop, which is the only caller that passes a
 * `callBody` partial-ref down. Everything deeper recurses through the ordinary
 * `lowerChildren`.
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

// Ctx plus the partial definition being lowered. Created when a definition
// starts lowering and never mutated; `name` feeds the data-loc attribute.
interface PartialCtx extends Ctx {
	root: RootTNode;
	name: string;
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
	for (const node of nodes) {
		lowerTopLevelNode(node, ctx);
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

// The end of a definition's source extent: through its close tag when it has
// one, else through its own open tag for a self-closing / void root (which has
// no body). Undefined for a root left unclosed at EOF — meta.endOffset then
// keeps its initial value (== startOffset).
function definitionEndOffset(el: SourceElement): number | undefined {
	if (el.rawCloseTag !== undefined) return (el.closeLoc?.startOffset ?? 0) + el.rawCloseTag.length;
	if (!isContainer(el)) return (el.openLoc?.startOffset ?? 0) + el.rawOpenTag.length;
	return undefined;
}

// --- attr assembly ---

// Walk an element's attrs through the shared classifier and forward any
// validation errors into the run's accumulator.
function classifyAttrs(el: SourceElement, excludeAttrs: string[], ctx: Ctx) {
	const { segments, hasBind, errors: errs } = classifyOpenTagAttrs(el, excludeAttrs, ctx.assetCtx);
	if (errs.length) ctx.errors.push(...errs);
	return { segments, hasBind };
}

function dataLocAttr(el: SourceElement, pctx: PartialCtx): string {
	return dataLocAttrPure(el.openLoc, { includeLocs: pctx.includeLocs, currentPartialName: pctx.name, filename: pctx.filename });
}

// Build an ElementTNode for a regular HTML element. Attrs are produced via
// classifyOpenTagAttrs (which already filters b-data:* / b-attr:* and validates
// static assets) and converted to AttrPart[]; `excludeAttrs` strips any additional
// directives that belong to a wrapping construct (e.g. `b-part`, `b-slot`, `b-if`).
// The `data-loc=...` string (when enabled) is appended as a synthesized trailing
// static AttrPart so it renders after the source attrs.
//
// `loc` spans the open tag through the close tag (Pass A already recorded both);
// `tnodes` starts empty — the caller fills it with the lowered children.
function buildElement(el: SourceElement, excludeAttrs: string[], pctx: PartialCtx): ElementTNode {
	const { segments } = classifyAttrs(el, excludeAttrs, pctx);
	const locStr = dataLocAttr(el, pctx);
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
		elem.loc = el.openLoc;
	}
	// No closeLoc: void, self-closed, or unclosed at EOF — loc stays the open tag.
	if (el.closeLoc) {
		elem.closeTagLoc = el.closeLoc;
		if (elem.openTagLoc) {
			elem.loc = {
				startLine: elem.openTagLoc.startLine,
				startCol: elem.openTagLoc.startCol,
				startOffset: elem.openTagLoc.startOffset,
				endLine: el.closeLoc.endLine,
				endCol: el.closeLoc.endCol,
				endOffset: el.closeLoc.endOffset,
			};
		}
	}
	return elem;
}

// Like buildElement but returns just the AttrPart[]. Used for custom element
// definitions and call sites, where the wrapping tag is merged at render time
// (no ElementTNode is constructed for it).
function buildAttrPartsFromTag(el: SourceElement, excludeAttrs: string[], pctx: PartialCtx): AttrPart[] {
	const { segments } = classifyAttrs(el, excludeAttrs, pctx);
	const locStr = dataLocAttr(el, pctx);
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

// b-attr:* / b-script are only meaningful on a custom element partial definition.
// Reported for every other element, inside a partial or not.
function reportDirectiveMisplacement(el: SourceElement, ctx: Ctx): void {
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
}

function reportFlowOnDefinition(el: SourceElement, ctx: Ctx): void {
	for (const flow of ['b-if', 'b-for', 'b-else-if', 'b-else'] as const) {
		if (findAttr(el, flow)) {
			ctx.errors.push(new BackflipError(`${flow} is not allowed on a partial definition`, attrErrLoc(el, flow, ctx)));
		}
	}
}

// --- text lowering (the single {{ }} splitter) ---

type TextPiece = { kind: 'raw', text: string } | { kind: 'print', node: PrintTNode };

/**
 * Split a raw text run on `{{ expr }}` interpolations. Empty `{{ }}` stays
 * raw. Expression errors are forwarded into ctx.errors as pieces are produced,
 * so error order matches document order.
 */
function splitInterpolations(raw: string, textLoc: TextLoc | undefined, ctx: Ctx): TextPiece[] {
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
			ctx.errors.push(new BackflipError(err, printLoc ? toErrLoc(printLoc, ctx.filename) : undefined));
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

function lowerText(node: SourceText, ctx: Ctx): TNode[] {
	// Recovery errors ride on the text node so they surface in document order.
	if (node.error) ctx.errors.push(node.error);

	if (node.verbatim) {
		// Error-recovery text (a demoted close tag): kept as-is, never split for
		// `{{ }}`.
		return [{ type: 'raw', raw: node.raw }];
	}

	const out: TNode[] = [];
	for (const piece of splitInterpolations(node.raw, node.loc, ctx)) {
		if (piece.kind === 'raw') appendCoalesced(out, { type: 'raw', raw: piece.text });
		else out.push(piece.node);
	}
	return out;
}

// --- recursion core ---

/**
 * Lower one source node. `siblings` is the output list being built at this
 * level — read only by b-else/b-else-if, to chain onto a preceding b-if.
 * `callBody` is the partial-ref whose body this node sits directly in (only
 * lowerCallBody passes it), which is what makes `b-in` meaningful here.
 */
function lowerNode(node: SourceNode, pctx: PartialCtx, siblings: TNode[], callBody: PartialRefTNode | null): TNode[] {
	if (node.kind === 'text') return lowerText(node, pctx);
	return lowerElement(node, pctx, siblings, callBody);
}

// Lower `children` and append them onto `out`, merging adjacent raws.
function lowerInto(out: TNode[], children: SourceNode[], pctx: PartialCtx): void {
	for (const child of children) {
		for (const n of lowerNode(child, pctx, out, null)) appendCoalesced(out, n);
	}
}

function lowerChildren(children: SourceNode[], pctx: PartialCtx): TNode[] {
	const out: TNode[] = [];
	lowerInto(out, children, pctx);
	return out;
}

// --- top level ---

/**
 * Top-level source nodes are either a partial definition or content outside any
 * partial. Nothing carries over between them: each definition is lowered in its
 * own PartialCtx, and non-definition content is skipped (but still walked, so
 * misplaced directives inside it still report).
 */
function lowerTopLevelNode(node: SourceNode, ctx: Ctx): void {
	if (node.kind === 'text') {
		// Outside any partial: no content, but recovery errors still report.
		if (node.error) ctx.errors.push(node.error);
		return;
	}
	const bNameAttr = findAttr(node, 'b-name');
	if (bNameAttr) return lowerNamedDefinition(node, bNameAttr, ctx);
	// A top-level custom element tag defines the partial of the same name.
	if (isCustomElementTagName(node.tagName)) return lowerCustomElementDefinition(node, ctx);
	walkOutsidePartial([node], ctx);
}

/**
 * Content outside any partial produces no output, but is still walked so the
 * misplacement diagnostics the dispatcher reports inside a partial are also
 * reported here (a nested b-name, a stray b-attr:/b-script), along with the
 * recovery errors riding on text nodes.
 */
function walkOutsidePartial(nodes: SourceNode[], ctx: Ctx): void {
	for (const node of nodes) {
		if (node.kind === 'text') {
			if (node.error) ctx.errors.push(node.error);
			continue;
		}
		// Only the entry nodes are top-level (and those never carry b-name — the
		// caller routed those to a definition), so any b-name found here is nested.
		if (findAttr(node, 'b-name')) {
			ctx.errors.push(new BackflipError("b-name is only allowed on top-level elements", attrErrLoc(node, 'b-name', ctx)));
		} else {
			reportDirectiveMisplacement(node, ctx);
		}
		walkOutsidePartial(node.children, ctx);
	}
}

// --- the dispatcher ---

/**
 * Precedence: b-name (nested → error) → b-attr/b-script errors → b-part →
 * b-slot → b-in → document-level tracking → multi-flow error → custom element
 * call → flow → regular tag.
 */
function lowerElement(el: SourceElement, pctx: PartialCtx, siblings: TNode[], callBody: PartialRefTNode | null): TNode[] {
	// Every element reached here is inside a partial, i.e. nested: a top-level
	// b-name is a definition and never reaches the dispatcher.
	if (findAttr(el, 'b-name')) {
		ctx_error(pctx, "b-name is only allowed on top-level elements", attrErrLoc(el, 'b-name', pctx));
		return lowerFallbackTag(el, pctx);
	}

	reportDirectiveMisplacement(el, pctx);

	const bPartAttr = findAttr(el, 'b-part');
	if (bPartAttr) return lowerBPart(el, bPartAttr, pctx);

	// b-in is only meaningful directly inside a call body — elsewhere it stays a
	// literal attribute. Inside one it outranks b-slot on the same tag: b-in says
	// where the tag goes, b-slot says what fills it (slot forwarding).
	const bInAttr = findAttr(el, 'b-in');
	if (bInAttr && callBody) return lowerBIn(el, bInAttr, callBody, pctx);

	const bSlotAttr = findAttr(el, 'b-slot');
	if (bSlotAttr) return lowerBSlot(el, bSlotAttr, pctx);

	// Track document-level tags inside partials
	if (DOCUMENT_LEVEL_TAGS.has(el.tagName)) {
		pctx.root.meta!.isDocumentLevel = true;
	}

	// --- b-for / b-if / b-else-if / b-else ---
	const b_as = el.attrs.filter(attr => ['b-for', 'b-if', 'b-else-if', 'b-else'].includes(attr.name));
	if (b_as.length > 1) {
		ctx_error(pctx, "more than one b-attr", tagErrLoc(el, pctx));
		return lowerFallbackTag(el, pctx);
	}

	// Custom element call site. With a single flow directive, the call is
	// wrapped in the matching ForTNode / IfTNode (equivalent to wrapping in
	// <b-unwrap b-for|if|...>). Without a flow directive, it's a plain call.
	// b-part precedence already won above; this only runs for plain custom element tags.
	if (isCustomElementTagName(el.tagName)) {
		if (b_as.length === 1) return lowerCustomElementCallWithFlow(el, b_as[0], pctx, siblings);
		return lowerCustomElementCall(el, pctx);
	}

	if (b_as.length === 1) return lowerFlowOnRegularTag(el, b_as[0], pctx, siblings);

	return lowerRegularTag(el, pctx);
}

function ctx_error(ctx: Ctx, message: string, loc: ErrLoc | undefined): void {
	ctx.errors.push(new BackflipError(message, loc));
}

// Error-recovery: drop the tag back to a raw string and keep lowering going.
// Used when a handler can't construct its structured node (bad b-for value,
// dangling b-else, multiple flow attrs, misplaced b-name). The children still
// lower (as siblings of the raw open tag) and the close tag is dropped.
function lowerFallbackTag(el: SourceElement, pctx: PartialCtx): TNode[] {
	const out: TNode[] = [{ type: 'raw', raw: el.rawOpenTag }];
	if (isContainer(el)) lowerInto(out, el.children, pctx);
	return out;
}

// --- partial definitions ---

function lowerNamedDefinition(el: SourceElement, bNameAttr: SourceAttr, ctx: Ctx): void {
	reportFlowOnDefinition(el, ctx);

	// b-attr is only allowed on custom element partial definitions (a hyphenated tag).
	// b-name partials are NOT custom element partials — flag b-attr:* as an error here.
	reportDirectiveMisplacement(el, ctx);

	const partialName = bNameAttr.value;
	const openLoc = el.openLoc;
	const partialRoot: NamedPartialRoot = { type: 'root', kind: 'named', tnodes: [], meta: {
		startOffset: openLoc?.startOffset ?? 0,
		endOffset: openLoc?.startOffset ?? 0, // updated below once the extent is known
		startLine: openLoc?.startLine ?? 1,
		startCol: openLoc?.startCol ?? 1,
		isDocumentLevel: DOCUMENT_LEVEL_TAGS.has(el.tagName),
	} };
	partialRoot.loc = findAttrLoc(el, 'b-name');
	partialRoot.exported = el.attrs.some(a => a.name === 'b-export');
	ctx.compiledFile.partials.set(partialName, partialRoot);

	const pctx: PartialCtx = { ...ctx, root: partialRoot, name: partialName };

	if (el.tagName === 'b-unwrap') {
		// Don't emit a wrapping element; body content is the partial's tnodes.
		if (isContainer(el)) lowerInto(partialRoot.tnodes, el.children, pctx);
	} else {
		const elem = buildElement(el, ['b-name', 'b-export'], pctx);
		if (isContainer(el)) lowerInto(elem.tnodes, el.children, pctx);
		partialRoot.tnodes.push(elem);
	}

	const endOffset = definitionEndOffset(el);
	if (endOffset !== undefined) partialRoot.meta!.endOffset = endOffset;
}

function lowerCustomElementDefinition(el: SourceElement, ctx: Ctx): void {
	// Pre-conditions: top level, no b-name attr, and isCustomElementTagName —
	// lowerTopLevelNode guarantees these.

	reportFlowOnDefinition(el, ctx);

	const partialName = el.tagName;
	const openLoc = el.openLoc;
	const partialRoot: CustomElementPartialRoot = { type: 'root', kind: 'custom-element', tnodes: [], meta: {
		startOffset: openLoc?.startOffset ?? 0,
		endOffset: openLoc?.startOffset ?? 0, // updated below once the extent is known
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

	const pctx: PartialCtx = { ...ctx, root: partialRoot, name: partialName };

	// For custom element partials, the open tag is rendered by the call site (merged
	// with caller-side attrs into one tag), so no wrapping ElementTNode is constructed.
	// The definition-side attrs are stored as a flat AttrPart[] for the call-site renderer
	// to emit in childCtx.
	partialRoot.definitionAttrs = buildAttrPartsFromTag(el, ['b-export', 'b-script'], pctx);
	if (isContainer(el)) lowerInto(partialRoot.tnodes, el.children, pctx);

	const endOffset = definitionEndOffset(el);
	if (endOffset !== undefined) partialRoot.meta!.endOffset = endOffset;
}

// --- flow directives ---

/**
 * Build the wrapping ForTNode / IfTNode for a flow directive, or append a new
 * IfBranch to the b-if among `siblings` for b-else / b-else-if. Returns:
 *   - `container`: where the directive's body (the element, partial-ref, or
 *     b-unwrap body) goes — the for_node itself, or the new IfBranch.
 *   - `emit`: the node(s) the caller must append to `siblings`. Empty for
 *     b-else / b-else-if, whose branch joins an if node already emitted.
 * On error (bad b-for syntax, dangling b-else, etc.), pushes the error and
 * returns null — the caller falls back to lowerFallbackTag.
 */
function setupFlow(el: SourceElement, flowAttr: SourceAttr, pctx: PartialCtx, siblings: TNode[]): { container: ParentTNode, emit: TNode[] } | null {
	if (flowAttr.name === 'b-for') {
		const parsed = parseBForValue(flowAttr.value);
		if ('error' in parsed) {
			ctx_error(pctx, parsed.error, attrErrLoc(el, 'b-for', pctx));
			return null;
		}
		for (const err of parsed.iterable.errs) {
			ctx_error(pctx, err, attrErrLoc(el, 'b-for', pctx));
		}
		const for_node: ForTNode = { type: 'for', iterable: parsed.iterable, valName: parsed.valName, tnodes: [] };
		for_node.loc = findAttrLoc(el, 'b-for');
		return { container: for_node, emit: [for_node] };
	}

	if (flowAttr.name === 'b-if') {
		const if_node: IfTNode = { type: 'if', branches: [] };
		const branch: IfBranch = { condition: interpretBackcodeAt(flowAttr.value, attrErrLoc(el, 'b-if', pctx), pctx), tnodes: [] };
		branch.loc = findAttrLoc(el, 'b-if');
		if_node.branches.push(branch);
		return { container: branch, emit: [if_node] };
	}

	// b-else-if / b-else: chain onto the b-if immediately preceding among the
	// siblings built so far.
	const if_node = findPrecedingIf(siblings);
	if (!if_node) {
		ctx_error(pctx, "b-else-if/b-else must follow a b-if block", attrErrLoc(el, flowAttr.name, pctx));
		return null;
	}
	if (flowAttr.name === 'b-else' && flowAttr.value) {
		ctx_error(pctx, "b-else should not have a value", attrErrLoc(el, 'b-else', pctx));
		// fall through — branch is still added so the structure stays correct
	}
	const condition = flowAttr.name === 'b-else-if' ? interpretBackcodeAt(flowAttr.value, attrErrLoc(el, 'b-else-if', pctx), pctx) : undefined;
	const branch: IfBranch = { condition, tnodes: [] };
	branch.loc = findAttrLoc(el, flowAttr.name);
	if_node.branches.push(branch);
	return { container: branch, emit: [] };
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

// Handle a flow directive (b-for, b-if, b-else-if, b-else) on a regular
// (non-custom-element) tag. If the carrying tag isn't b-unwrap, an ElementTNode
// nests inside the flow container so the tag renders inside each iteration /
// branch.
function lowerFlowOnRegularTag(el: SourceElement, flowAttr: SourceAttr, pctx: PartialCtx, siblings: TNode[]): TNode[] {
	const fc = setupFlow(el, flowAttr, pctx, siblings);
	if (!fc) return lowerFallbackTag(el, pctx);
	if (el.tagName === 'b-unwrap') {
		// Body flows directly into the flow container (no wrapping element).
		if (isContainer(el)) lowerInto(fc.container.tnodes!, el.children, pctx);
	} else {
		const elem = buildElement(el, [flowAttr.name], pctx);
		if (isContainer(el)) lowerInto(elem.tnodes, el.children, pctx);
		fc.container.tnodes!.push(elem);
	}
	return fc.emit;
}

// --- call sites ---

// Build the PartialRefTNode for a custom element call site.
function buildCustomElementPartialRef(el: SourceElement, pctx: PartialCtx): CustomElementCallTNode {
	const bindings = collectBDataBindings(el, pctx);

	// Flow directives on the call site are consumed by the wrapping ForTNode /
	// IfTNode (built in lowerCustomElementCallWithFlow) and must never appear in
	// the rendered tag. They're excluded here so the AttrPart[] doesn't contain them.
	// In the non-flow call path they're absent anyway, so the extra excludes are no-ops.
	const callerAttrs = buildAttrPartsFromTag(el, ['b-export', 'b-if', 'b-for', 'b-else', 'b-else-if'], pctx);

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
			const info: { name: string; kind: 'plain' | 'expr'; value: string; bare?: boolean; expr?: Parsed; loc?: SourceLoc } = {
				name: effName,
				kind: 'plain',
				value: attr.value,
			};
			if (attr.bare) info.bare = true;
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

/**
 * Lower the body of a call site into `partialRef`'s slots. This is the only
 * place slot routing exists: `slotName` is the slot the body's own children
 * land in, and a `b-in` child (which only the `callBody` argument below makes
 * meaningful) diverts itself or its children elsewhere.
 */
function lowerCallBody(children: SourceNode[], partialRef: PartialRefTNode, slotName: string, pctx: PartialCtx): void {
	const arr = (partialRef.slots[slotName] ??= []);
	for (const child of children) {
		for (const n of lowerNode(child, pctx, arr, partialRef)) appendCoalesced(arr, n);
	}
}

function lowerCustomElementCall(el: SourceElement, pctx: PartialCtx): TNode[] {
	// Pre-conditions: isCustomElementTagName, no b-name / b-part / flow directive
	// (see lowerCustomElementCallWithFlow for flow), inside a partial.
	const partialRef = buildCustomElementPartialRef(el, pctx);
	if (isContainer(el)) lowerCallBody(el.children, partialRef, 'default', pctx);
	return [partialRef];
}

// `<my-elem b-for|if|else-if|else>` — the call site is wrapped in a ForTNode
// or IfTNode (semantically identical to <b-unwrap b-for=...><my-elem>...</my-elem></b-unwrap>).
function lowerCustomElementCallWithFlow(el: SourceElement, flowAttr: SourceAttr, pctx: PartialCtx, siblings: TNode[]): TNode[] {
	const fc = setupFlow(el, flowAttr, pctx, siblings);
	if (!fc) return lowerFallbackTag(el, pctx);
	const partialRef = buildCustomElementPartialRef(el, pctx);
	fc.container.tnodes!.push(partialRef);
	if (isContainer(el)) lowerCallBody(el.children, partialRef, 'default', pctx);
	return fc.emit;
}

function lowerBPart(el: SourceElement, bPartAttr: SourceAttr, pctx: PartialCtx): TNode[] {
	const { file, partialName } = parseBPartValue(bPartAttr.value);

	const bindings = collectBDataBindings(el, pctx);

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

	let out: TNode[];
	if (el.tagName === 'b-unwrap') {
		// No wrapping element; the partial-ref is emitted directly.
		out = [partialRef];
	} else {
		// A wrapping ElementTNode whose single child is the partial-ref. Its attrs
		// come from the source tag (excluding b-part / b-data:*).
		const elem = buildElement(el, ['b-part'], pctx);
		elem.tnodes.push(partialRef);
		out = [elem];
	}

	if (isContainer(el)) lowerCallBody(el.children, partialRef, 'default', pctx);
	return out;
}

// --- slots ---

function lowerBSlot(el: SourceElement, bSlotAttr: SourceAttr, pctx: PartialCtx, alsoExclude: string[] = []): TNode[] {
	const slotName = bSlotAttr.value !== '' ? bSlotAttr.value : undefined;
	const slot_node: SlotTNode = { type: 'slot', name: slotName };
	slot_node.loc = findAttrLoc(el, 'b-slot');

	if (el.tagName === 'b-unwrap') {
		// No wrapping element; the slot insertion point is emitted directly, and
		// the tag's body follows as its siblings. The body is NOT fallback content:
		// it renders whether or not the caller fills the slot.
		const out: TNode[] = [slot_node];
		if (isContainer(el)) lowerInto(out, el.children, pctx);
		return out;
	}
	// Wrapping ElementTNode with the slot insertion point as its first child; any
	// body content follows as later children of the element.
	const elem = buildElement(el, ['b-slot', ...alsoExclude], pctx);
	elem.tnodes.push(slot_node);
	if (isContainer(el)) lowerInto(elem.tnodes, el.children, pctx);
	return [elem];
}

/**
 * `b-in` on a direct child of a call body: route content into a named slot.
 * Produces no output of its own — it fills the target slot itself.
 */
function lowerBIn(el: SourceElement, bInAttr: SourceAttr, partialRef: PartialRefTNode, pctx: PartialCtx): TNode[] {
	const slotName = bInAttr.value || 'default';
	if (!partialRef.slots[slotName]) {
		partialRef.slots[slotName] = [];
	}
	const bInLoc = findAttrLoc(el, 'b-in');
	if (bInLoc) {
		if (!partialRef.slotLocs) partialRef.slotLocs = {};
		partialRef.slotLocs[slotName] = bInLoc;
	}

	const bSlotAttr = findAttr(el, 'b-slot');
	if (bSlotAttr) {
		// Slot forwarding: b-in routes this tag into the target slot, b-slot turns
		// its content into an insertion point for the *enclosing* partial's slot.
		const arr = partialRef.slots[slotName];
		for (const n of lowerBSlot(el, bSlotAttr, pctx, ['b-in'])) appendCoalesced(arr, n);
	} else if (el.tagName === 'b-unwrap') {
		// Switch the target slot for this tag's own children; no wrapping element.
		// (A self-closing <b-unwrap b-in/> simply has no body — the named slot is
		// created and stays empty.)
		lowerCallBody(el.children, partialRef, slotName, pctx);
	} else {
		// The carrying tag becomes an element pushed into the target slot; its body
		// nests inside it.
		const elem = buildElement(el, ['b-in'], pctx);
		if (isContainer(el)) lowerInto(elem.tnodes, el.children, pctx);
		partialRef.slots[slotName].push(elem);
	}
	return [];
}

function lowerRegularTag(el: SourceElement, pctx: PartialCtx): TNode[] {
	const elem = buildElement(el, [], pctx);
	if (isContainer(el)) lowerInto(elem.tnodes, el.children, pctx);
	return [elem];
}
