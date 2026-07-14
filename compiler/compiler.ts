import {RewritingStream} from 'parse5-html-rewriting-stream';
import stream from 'node:stream';

import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
import { BackflipError } from './errors.js';
import { appendCoalesced } from './walk.js';
import type {
	SourceLoc, TNode, RawTNode, PrintTNode, ForTNode, IfTNode, IfBranch,
	SlotTNode, PartialRefTNode, BPartCallTNode, CustomElementCallTNode, ParentTNode,
	RootTNode, NamedPartialRoot, CustomElementPartialRoot, CompiledFile, CompileOptions, PartialDef, PartialBinding,
	ElementTNode, AttrPart,
} from './types.js';
import {
	attrLoc, tagLoc, errorLoc, attrErrorLoc, bDataNameLoc, interpolationLoc,
	tagSrcLoc, LineMap,
	isCustomElementTagName, effectiveAttrNames, parseBPartValue, parseBForValue,
	dataLocAttr as dataLocAttrPure,
	getSlotCollection as getSlotCollectionPure,
	classifyOpenTagAttrs, buildAttrParts, validateStaticAssetAttr,
	findPrecedingIfInFile, findPrecedingIfInSlot,
	pushRaw, onText,
	DOCUMENT_LEVEL_TAGS, VOID_ELEMENTS, INTERPOLATION_RE,
	type TagMatcher, type AssetAttrCtx,
} from './helpers.js';
export { BackflipError };

/**
 * Compile a single partial.
 *
 * `htmlSlice` is the source for exactly one top-level partial (matching
 * `partialDef`), typically obtained by slicing complete lines `[from..to]` of
 * the source file. The very first start tag in the slice must match
 * `partialDef` (name + customElement flag); a mismatch rejects the promise.
 *
 * All `SourceLoc` values in the returned tree, all error locations, and any
 * `data-loc` strings baked into raw HTML are SLICE-RELATIVE. Callers translate
 * to file coordinates by adding `partialDef.loc.from - 1` to line numbers when
 * needed.
 */
export function compilePartial(htmlSlice: string, partialDef: PartialDef, options?: CompileOptions): Promise<{ compiled: RootTNode, errors: BackflipError[] }> {

	return new Promise((resolve, reject) => {

		const html = htmlSlice;
		const filename = partialDef.loc.filename;
		const lineMap = new LineMap(html);
		const errors: BackflipError[] = [];

		const s = new stream.Readable({encoding: 'utf8'});
		s.push(html);
		s.push(null);

		const tag_stack: TagMatcher[] = [];

		// Single-partial output. handleBName / handleCustomElementDefinition will
		// populate this; we validate at end against partialDef.
		const compiledFile: CompiledFile = { partials: new Map() };

		// current partial being compiled (null = top-level, outside any b-name partial)
		let currentPartialRoot: RootTNode | null = null;
		let currentPartialName: string | null = null;
		let cur_tnode: TNode | null = null;
		// cur_parent tracks the container we're currently pushing into (replaces
		// the dropped `node.parent` field on TNodes). Maintained in lockstep with
		// cur_tnode: any place that assigns cur_tnode also assigns cur_parent.
		let cur_parent: ParentTNode | null = null;

		const includeLocs = options?.includeLocs ?? false;

		// Thin wrappers that bind the pure helpers to this run's mutable state.
		const dataLocAttr = (tag: { sourceCodeLocation?: unknown }) =>
			dataLocAttrPure(tag, { includeLocs, currentPartialName, filename });
		const getSlotCollection = () => getSlotCollectionPure(tag_stack);

		// Parse an expression and forward any interpretBackcode errors (e.g. unsupported
		// operator, syntax error) into the run's error accumulator. Without this the
		// parsed AST would still be embedded into the output and surface at runtime as
		// a ReferenceError or similar.
		type ErrLoc = { filename?: string, line?: number, col?: number, endLine?: number, endCol?: number };
		function interpretBackcodeAt(code: string, loc?: ErrLoc | SourceLoc): Parsed {
			const parsed = interpretBackcode(code);
			for (const err of parsed.errs) {
				errors.push(new BackflipError(err, loc ? toErrLoc(loc) : undefined));
			}
			return parsed;
		}
		function toErrLoc(loc: ErrLoc | SourceLoc): ErrLoc {
			if ('startLine' in loc) {
				return { filename, line: loc.startLine, col: loc.startCol, endLine: loc.endLine, endCol: loc.endCol };
			}
			return loc;
		}

		// Routing rule: when cur_parent is null OR is the currentPartialRoot, the
		// parser is at a "slot-routable" boundary — content goes into the innermost
		// slot collection if one exists. Once the parser has descended into an
		// explicit container (ElementTNode / ForTNode / IfBranch), cur_parent points
		// to it and content nests inside that container regardless of slot context.
		function isAtSlotBoundary(): boolean {
			return cur_parent === null || cur_parent === currentPartialRoot;
		}

		// Helper: push a raw string into the right place (slot or normal).
		function pushRawHere(raw: string): TNode | null {
			const sc = getSlotCollection();
			if (sc && isAtSlotBoundary()) {
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				const arr = sc.partialRef.slots[slotName];
				appendCoalesced(arr, { type: 'raw', raw });
				return arr[arr.length - 1];
			}
			const container: ParentTNode | null = cur_parent ?? currentPartialRoot;
			if (container === null) return null;
			if (cur_tnode === null) {
				const raw_node: RawTNode = { type: 'raw', raw };
				container.tnodes!.push(raw_node);
				cur_tnode = raw_node;
				if (cur_parent === null) cur_parent = container;
				return raw_node;
			}
			return pushRaw(cur_tnode, container, raw);
		}

		// Helper: push a TNode into the current parent or slot
		function pushNodeHere(node: TNode) {
			const sc = getSlotCollection();
			if (sc && isAtSlotBoundary()) {
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				sc.partialRef.slots[slotName].push(node);
				return;
			}
			const container: ParentTNode | null = cur_parent ?? currentPartialRoot;
			if (container !== null) {
				container.tnodes!.push(node);
				if (cur_parent === null) cur_parent = container;
			}
		}

		const assetCtx: AssetAttrCtx = { html, lineMap, assetMap: options?.assetMap, assetDirs: options?.assetDirs, filename };

		// Walk a tag's attrs through the shared classifier and forward any
		// validation errors into this run's accumulator.
		function classifyAttrs(
			tag: {attrs:{name:string,value:string}[], sourceCodeLocation?: unknown},
			excludeAttrs: string[],
		) {
			const { segments, hasBind, errors: errs } = classifyOpenTagAttrs(tag, excludeAttrs, assetCtx);
			if (errs.length) errors.push(...errs);
			return { segments, hasBind };
		}

		type StartTag = { tagName: string, attrs: { name: string, value: string }[], selfClosing: boolean, sourceCodeLocation?: unknown };
		type Attr = { name: string, value: string };

		// Build an ElementTNode for a regular HTML element. Attrs are produced via
		// classifyOpenTagAttrs (which already filters b-data:* / b-attr:* and validates
		// static assets) and converted to AttrPart[]; `excludeAttrs` strips any additional
		// directives that belong to a wrapping construct (e.g. `b-part`, `b-slot`, `b-if`).
		// The `data-loc=...` string (when enabled) is appended as a synthesized trailing
		// static AttrPart so it renders after the source attrs.
		function buildElement(tag: StartTag, excludeAttrs: string[]): ElementTNode {
			const { segments } = classifyAttrs(tag, excludeAttrs);
			const locStr = dataLocAttr(tag);
			const attrs = buildAttrParts(segments, locStr);
			const elem: ElementTNode = {
				type: 'element',
				tagName: tag.tagName,
				attrs,
				tnodes: [],
			};
			if (VOID_ELEMENTS.has(tag.tagName)) elem.isVoid = true;
			if (tag.selfClosing) elem.selfClosing = true;
			const openLoc = tagSrcLoc(tag);
			if (openLoc) {
				elem.openTagLoc = openLoc;
				elem.loc = openLoc;  // updated to span through closeTagLoc when close is matched
			}
			return elem;
		}

		// Like buildElement but returns just the AttrPart[]. Used for custom element
		// definitions and call sites, where the wrapping tag is merged at render time
		// (no ElementTNode is constructed for it).
		function buildAttrPartsFromTag(tag: StartTag, excludeAttrs: string[]): AttrPart[] {
			const { segments } = classifyAttrs(tag, excludeAttrs);
			const locStr = dataLocAttr(tag);
			return buildAttrParts(segments, locStr);
		}

		// Error-recovery: drop the tag back to a raw string and keep the parser balanced.
		// Used by flow-directive handlers when they can't construct their structured node.
		function fallbackToRawTag(tag: StartTag, raw: string): void {
			const new_cur = pushRawHere(raw);
			if (cur_tnode !== null) {
				cur_tnode = new_cur;
				// cur_parent unchanged: pushRawHere appends a sibling within the same container.
			}
			if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
				tag_stack.push({ tag: tag.tagName });
			}
		}

		// Build the wrapping ForTNode / IfTNode (or just append a new IfBranch for
		// b-else / b-else-if) for a flow directive. Returns:
		//   - `container`: where the directive's body content (open tag, partial-ref, etc.)
		//     should be pushed (the for_node itself, or the new IfBranch).
		//   - `outer`: the outer structural node, i.e. the ForTNode or IfTNode. Equal to
		//     `container` for b-for; the enclosing IfTNode for b-if / b-else-if / b-else.
		// On error (bad b-for syntax, dangling b-else, etc.), pushes the error,
		// runs `fallbackToRawTag`, and returns null — caller should just return.
		// Shared between the regular flow handler and the custom-element-call-with-flow handler.
		function setupFlowContainer(tag: StartTag, raw: string, flowAttr: Attr): { container: ParentTNode, outer: TNode, outerParent: ParentTNode } | null {
			const sc = getSlotCollection();
			const flowParent: ParentTNode = sc
				? sc.partialRefParent
				: (cur_parent ?? currentPartialRoot!);

			if (flowAttr.name === 'b-for') {
				const parsed = parseBForValue(flowAttr.value);
				if ('error' in parsed) {
					errors.push(new BackflipError(parsed.error, attrErrorLoc(tag, 'b-for', filename)));
					fallbackToRawTag(tag, raw);
					return null;
				}
				for (const err of parsed.iterable.errs) {
					errors.push(new BackflipError(err, attrErrorLoc(tag, 'b-for', filename)));
				}
				const for_node: ForTNode = { type: 'for', iterable: parsed.iterable, valName: parsed.valName, tnodes: [] };
				for_node.loc = attrLoc(tag, 'b-for');
				if (sc) pushNodeHere(for_node);
				else flowParent.tnodes!.push(for_node);
				return { container: for_node, outer: for_node, outerParent: flowParent };
			}

			if (flowAttr.name === 'b-if') {
				const if_node: IfTNode = { type: 'if', branches: [] };
				const branch: IfBranch = { condition: interpretBackcodeAt(flowAttr.value, attrErrorLoc(tag, 'b-if', filename)), tnodes: [] };
				branch.loc = attrLoc(tag, 'b-if');
				if_node.branches.push(branch);
				if (sc) pushNodeHere(if_node);
				else flowParent.tnodes!.push(if_node);
				return { container: branch, outer: if_node, outerParent: flowParent };
			}

			// b-else-if / b-else: chain onto a preceding b-if among current siblings.
			if (!cur_tnode) {
				errors.push(new BackflipError("b-else-if/b-else must follow a b-if block", attrErrorLoc(tag, flowAttr.name, filename)));
				fallbackToRawTag(tag, raw);
				return null;
			}
			let if_node: IfTNode;
			try {
				if (sc) {
					const slotName = sc.currentSlot;
					const arr = sc.partialRef.slots[slotName] || [];
					if_node = findPrecedingIfInSlot(arr, attrErrorLoc(tag, flowAttr.name, filename));
				} else {
					if_node = findPrecedingIfInFile(cur_tnode, cur_parent, attrErrorLoc(tag, flowAttr.name, filename));
				}
			} catch (e) {
				if (e instanceof BackflipError) {
					errors.push(e);
					fallbackToRawTag(tag, raw);
					return null;
				}
				throw e;
			}
			if (flowAttr.name === 'b-else' && flowAttr.value) {
				errors.push(new BackflipError("b-else should not have a value", attrErrorLoc(tag, 'b-else', filename)));
				// fall through — branch is still added so parsing state stays correct
			}
			const condition = flowAttr.name === 'b-else-if' ? interpretBackcodeAt(flowAttr.value, attrErrorLoc(tag, 'b-else-if', filename)) : undefined;
			const branch: IfBranch = { condition, tnodes: [] };
			branch.loc = attrLoc(tag, flowAttr.name);
			if_node.branches.push(branch);
			return { container: branch, outer: if_node, outerParent: flowParent };
		}

		// Build the PartialRefTNode for a custom element call site. Does NOT push it
		// into a parent or onto the tag_stack — the caller decides where it lives
		// (directly under the current parent for plain calls, inside a flow node's
		// container for `<my-elem b-for|if|...>` calls).
		function buildCustomElementPartialRef(tag: StartTag, raw: string): CustomElementCallTNode {
			const bindings: PartialBinding[] = [];
			for (const attr of tag.attrs) {
				if (attr.name.startsWith('b-data:')) {
					const bindingName = attr.name.slice('b-data:'.length);
					const binding: PartialBinding = { kind: 'expr', name: bindingName, data: interpretBackcodeAt(attr.value, attrErrorLoc(tag, attr.name, filename)) };
					const nameLoc = bDataNameLoc(tag, attr.name, bindingName);
					if (nameLoc) binding.nameLoc = nameLoc;
					bindings.push(binding);
				}
			}

			// Flow directives on the call site are consumed by the wrapping ForTNode /
			// IfTNode (built in handleCustomElementCallWithFlow) and must never appear in
			// the rendered tag. They're excluded here so the AttrPart[] doesn't contain them.
			// In the non-flow call path they're absent anyway, so the extra excludes are no-ops.
			const callerAttrs = buildAttrPartsFromTag(tag, ['b-export', 'b-if', 'b-for', 'b-else', 'b-else-if']);

			const callerAttrInfos: NonNullable<CustomElementCallTNode['callerAttrInfos']> = [];
			for (const attr of tag.attrs) {
				const n = attr.name;
				if (n === 'b-name' || n === 'b-export') continue;
				if (n === 'b-if' || n === 'b-for' || n === 'b-else' || n === 'b-else-if') continue;
				if (n === 'b-part' || n === 'b-slot' || n === 'b-in') continue;
				if (n.startsWith('b-data:')) continue;
				if (n.startsWith('b-attr:')) continue;
				const aLoc = attrLoc(tag, n);
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
				partialName: tag.tagName,
				slots: { 'default': [] },
				slotLocs: {},
				bindings,
				callerAttrs,
				callerTagName: tag.tagName,
				callerAttrNames: effectiveAttrNames(tag.attrs),
				callerAttrInfos,
				unresolvedRaw: raw,
			};
			const loc = tagSrcLoc(tag, raw.length);
			if (loc) partialRef.loc = loc;
			return partialRef;
		}

		const rewriteStream = new RewritingStream();

		// --- startTag directive handlers ---
		// Each handler is an inner function closing over compiler state (cur_tnode, currentPartialRoot, tag_stack, etc.)

		function handleBName(tag: StartTag, raw: string, bNameAttr: Attr) {
			if (tag_stack.length > 0) {
				errors.push(new BackflipError("b-name is only allowed on top-level elements", attrErrorLoc(tag, 'b-name', filename)));
				// Treat as raw tag within current partial
				const new_cur = pushRawHere(raw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}

			for (const flow of ['b-if', 'b-for', 'b-else-if', 'b-else'] as const) {
				const a = tag.attrs.find(a => a.name === flow);
				if (a) {
					errors.push(new BackflipError(`${flow} is not allowed on a partial definition`, attrErrorLoc(tag, flow, filename)));
				}
			}

			// b-attr is only allowed on custom element partial definitions (a hyphenated tag).
			// b-name partials are NOT custom element partials — flag b-attr:* as an error here.
			for (const attr of tag.attrs) {
				if (attr.name.startsWith('b-attr:')) {
					errors.push(new BackflipError(
						`b-attr is only allowed on custom element partial definitions`,
						attrErrorLoc(tag, attr.name, filename)
					));
				}
				if (attr.name === 'b-script') {
					errors.push(new BackflipError(
						`b-script is only allowed on custom element partial definitions`,
						attrErrorLoc(tag, attr.name, filename)
					));
				}
			}

			const partialName = bNameAttr.value;
			const srcLoc = tag.sourceCodeLocation as { startOffset?: number; startLine?: number; startCol?: number } | null | undefined;
			const partialRoot: NamedPartialRoot = { type: 'root', kind: 'named', tnodes: [], meta: {
				startOffset: srcLoc?.startOffset ?? 0,
				endOffset: srcLoc?.startOffset ?? 0, // updated on close
				startLine: srcLoc?.startLine ?? 1,
				startCol: srcLoc?.startCol ?? 1,
				isDocumentLevel: DOCUMENT_LEVEL_TAGS.has(tag.tagName),
			} };
			partialRoot.loc = attrLoc(tag, 'b-name');
			partialRoot.exported = tag.attrs.some(a => a.name === 'b-export');
			compiledFile.partials.set(partialName, partialRoot);

			currentPartialRoot = partialRoot;
			currentPartialName = partialName;

			if (tag.tagName === 'b-unwrap') {
				// Don't emit a wrapping element; body content flows directly into partialRoot.tnodes.
				cur_tnode = null;
				cur_parent = partialRoot;
				if (!tag.selfClosing) {
					tag_stack.push({ tag: tag.tagName });
				}
			} else {
				const elem = buildElement(tag, ['b-name', 'b-export']);
				partialRoot.tnodes.push(elem);
				cur_tnode = elem;
				cur_parent = elem;
				if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName, tnode: elem, parent: partialRoot, hasParent: true });
				} else {
					// Self-closing or void element: end offset is end of this tag
					partialRoot.meta!.endOffset = (srcLoc?.startOffset ?? 0) + raw.length;
				}
			}
		}

		function handleCustomElementDefinition(tag: StartTag, raw: string) {
			// Pre-conditions: top level (tag_stack.length === 0), no b-name attr,
			// and isCustomElementTagName(tag.tagName) — the dispatcher guarantees these.

			for (const flow of ['b-if', 'b-for', 'b-else-if', 'b-else'] as const) {
				const a = tag.attrs.find(a => a.name === flow);
				if (a) {
					errors.push(new BackflipError(`${flow} is not allowed on a partial definition`, attrErrorLoc(tag, flow, filename)));
				}
			}

			const partialName = tag.tagName;
			const srcLoc = tag.sourceCodeLocation as { startOffset?: number; endOffset?: number; startLine?: number; startCol?: number; endLine?: number; endCol?: number } | null | undefined;
			const partialRoot: CustomElementPartialRoot = { type: 'root', kind: 'custom-element', tnodes: [], meta: {
				startOffset: srcLoc?.startOffset ?? 0,
				endOffset: srcLoc?.startOffset ?? 0, // updated on close
				startLine: srcLoc?.startLine ?? 1,
				startCol: srcLoc?.startCol ?? 1,
				isDocumentLevel: false,
			} };
			const loc = tagSrcLoc(tag, raw.length);
			if (loc) partialRoot.loc = loc;
			partialRoot.exported = tag.attrs.some(a => a.name === 'b-export');

			// Parse b-attr:* declarations on the custom element definition tag.
			const bAttrs: { name: string; isBool: boolean; loc?: SourceLoc }[] = [];
			for (const attr of tag.attrs) {
				if (!attr.name.startsWith('b-attr:')) continue;
				// HTML lowercases attribute names, so a b-attr name written with
				// uppercase letters won't match when referenced inside the partial body.
				// Recover the original-case name from the source via the parser's
				// attribute offset (lowercasing preserves length).
				const srcLoc = attrLoc(tag, attr.name);
				if (srcLoc) {
					const rawAttrName = html.slice(srcLoc.startOffset, srcLoc.startOffset + attr.name.length);
					const afterPrefix = rawAttrName.slice('b-attr:'.length);
					const dotIdx = afterPrefix.indexOf('.');
					const namePart = dotIdx === -1 ? afterPrefix : afterPrefix.slice(0, dotIdx);
					if (/[A-Z]/.test(namePart)) {
						const errLoc = attrErrorLoc(tag, attr.name, filename) ?? { filename };
						errors.push(new BackflipError(
							`b-attr name "${namePart}" contains uppercase letters; HTML attribute names are lowercased, so this declares "${namePart.toLowerCase()}". Use a lowercase name to avoid confusion.`,
							{ ...errLoc, severity: 'warning' }
						));
					}
				}
				const rest = attr.name.slice('b-attr:'.length);
				const m = rest.match(/^([^.]+)(?:\.(.+))?$/);
				if (!m || !m[1]) {
					errors.push(new BackflipError(
						`invalid b-attr directive "${attr.name}"`,
						attrErrorLoc(tag, attr.name, filename)
					));
					continue;
				}
				const declName = m[1];
				const modifier = m[2];
				if (modifier !== undefined && modifier !== 'bool') {
					errors.push(new BackflipError(
						`unknown b-attr modifier '${modifier}' (only '.bool' is supported)`,
						attrErrorLoc(tag, attr.name, filename)
					));
					continue;
				}
				if (attr.value !== '') {
					errors.push(new BackflipError(
						`b-attr does not accept a value (reserved for future use)`,
						attrErrorLoc(tag, attr.name, filename)
					));
					continue;
				}
				const entry: { name: string; isBool: boolean; loc?: SourceLoc } = { name: declName, isBool: modifier === 'bool' };
				const aLoc = attrLoc(tag, attr.name);
				if (aLoc) entry.loc = aLoc;
				bAttrs.push(entry);
			}

			// Validate: a declared b-attr name must not also appear as a plain/bind attribute
			// on the same definition tag. Use effectiveAttrNames over all attrs (which already
			// strips the b-attr:* declarations themselves).
			if (bAttrs.length > 0) {
				const allEffective = effectiveAttrNames(tag.attrs);
				for (const ba of bAttrs) {
					if (allEffective.includes(ba.name)) {
						errors.push(new BackflipError(
							`attribute '${ba.name}' on the custom element definition tag conflicts with b-attr:${ba.name}; remove the plain attribute`,
							attrErrorLoc(tag, ba.name, filename) ?? errorLoc(filename, tagLoc(tag))
						));
					}
				}
			}

			// definitionAttrNames excludes b-attr-declared names so that the call-site-vs-definition
			// conflict check (compiler/partials.ts) doesn't false-positive when the caller passes the same name.
			const bAttrNameSet = new Set(bAttrs.map(b => b.name));
			partialRoot.definitionAttrNames = effectiveAttrNames(tag.attrs).filter(n => !bAttrNameSet.has(n));
			if (bAttrs.length > 0) partialRoot.bAttrs = bAttrs;

			// Parse b-script: the hand-coded web-component module to auto-include. Its
			// value is an @name/... asset path, validated and stored unresolved (an
			// 'entry' script) — resolveAssetRefs rewrites the @prefix later, exactly as
			// for asset attributes. Only one b-script is allowed per definition.
			const bScriptAttrs = tag.attrs.filter(a => a.name === 'b-script');
			if (bScriptAttrs.length > 1) {
				errors.push(new BackflipError(
					`more than one b-script on a custom element definition`,
					attrErrorLoc(tag, 'b-script', filename) ?? errorLoc(filename, tagLoc(tag))
				));
			}
			if (bScriptAttrs.length > 0) {
				const { refs, originalValue, error } = validateStaticAssetAttr('b-script', bScriptAttrs[0].value, tag, 'b-script', assetCtx);
				if (error) {
					errors.push(error);
				} else if (refs.length > 0) {
					(partialRoot.scripts ??= []).push({ url: originalValue, kind: 'entry' });
				}
			}

			compiledFile.partials.set(partialName, partialRoot);

			currentPartialRoot = partialRoot;
			currentPartialName = partialName;

			// For custom element partials, the open tag is rendered by the call site (merged
			// with caller-side attrs into one tag), so no wrapping ElementTNode is constructed.
			// The definition-side attrs are stored as a flat AttrPart[] for the call-site renderer
			// to emit in childCtx.
			partialRoot.definitionAttrs = buildAttrPartsFromTag(tag, ['b-export', 'b-script']);
			cur_tnode = null;
			cur_parent = partialRoot;
			if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
				tag_stack.push({ tag: tag.tagName });
			} else {
				partialRoot.meta!.endOffset = (srcLoc?.startOffset ?? 0) + raw.length;
			}
		}

		function handleCustomElementCall(tag: StartTag, raw: string) {
			// Pre-conditions: not top-level, isCustomElementTagName(tag.tagName), no b-name, no b-part,
			// no flow directive on the same tag (see handleCustomElementCallWithFlow for that case).
			// Inside a partial (cur_tnode or currentPartialRoot must be set; the dispatcher's "skip
			// outside partial" path runs before this).
			const oldParent: ParentTNode | null = cur_parent;
			const containerParent: ParentTNode = cur_parent ?? currentPartialRoot!;
			const partialRef = buildCustomElementPartialRef(tag, raw);
			pushNodeHere(partialRef);

			if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
				// Switch to slot mode: cur_parent = null so body content routes into the
				// partial-ref's default slot via slot collection (until a child opens a new
				// container which sets its own cur_parent).
				cur_parent = null;
				cur_tnode = null;
				tag_stack.push({
					tag: tag.tagName,
					tnode: partialRef,
					parent: oldParent,
					hasParent: true,
					slotCollection: {
						partialRef,
						partialRefParent: containerParent,
						currentSlot: 'default'
					}
				});
			}
		}

		// `<my-elem b-for|if|else-if|else>` — the call site is wrapped in a ForTNode
		// or IfTNode (semantically identical to <b-unwrap b-for=...><my-elem>...</my-elem></b-unwrap>).
		// The wrapping flow node and the partial-ref are built by shared helpers; this
		// handler is the glue that sequences them and sets up tag_stack for the close tag.
		function handleCustomElementCallWithFlow(tag: StartTag, raw: string, flowAttr: Attr) {
			const oldParent: ParentTNode | null = cur_parent;
			const fc = setupFlowContainer(tag, raw, flowAttr);
			if (!fc) return;
			const partialRef = buildCustomElementPartialRef(tag, raw);
			fc.container.tnodes!.push(partialRef);
			if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
				// Slot mode for body content (routes into partial-ref.slots.default).
				// On endTag, cur_tnode is repositioned at fc.outer so that a following
				// b-else can chain to this if_node among siblings of fc.outerParent.
				cur_parent = null;
				cur_tnode = null;
				tag_stack.push({
					tag: tag.tagName,
					tnode: fc.outer,
					parent: fc.outerParent,
					hasParent: true,
					slotCollection: { partialRef, partialRefParent: fc.container, currentSlot: 'default' },
				});
			} else {
				// Self-closing call: restore cur_parent (no body to process).
				cur_parent = oldParent;
				cur_tnode = fc.outer;
			}
		}

		function handleBPart(tag: StartTag, raw: string, bPartAttr: Attr) {
			// b-part outside any b-name partial is ignored
			if (currentPartialRoot === null) {
				if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}
			const { file, partialName } = parseBPartValue(bPartAttr.value);

			const bindings: PartialBinding[] = [];
			for (const attr of tag.attrs) {
				if (attr.name.startsWith('b-data:')) {
					const bindingName = attr.name.slice('b-data:'.length);
					const binding: PartialBinding = { kind: 'expr', name: bindingName, data: interpretBackcodeAt(attr.value, attrErrorLoc(tag, attr.name, filename)) };
					const nameLoc = bDataNameLoc(tag, attr.name, bindingName);
					if (nameLoc) binding.nameLoc = nameLoc;
					bindings.push(binding);
				}
			}

			const partialRef: BPartCallTNode = {
				type: 'partial-ref',
				kind: 'b-part',
				file,
				partialName,
				slots: { 'default': [] },
				slotLocs: {},
				bindings,
			};
			partialRef.loc = attrLoc(tag, 'b-part');

			const oldParent: ParentTNode | null = cur_parent;
			const containerParent: ParentTNode = cur_parent ?? currentPartialRoot!;

			let outerNode: TNode;
			if (tag.tagName === 'b-unwrap') {
				// No wrapping element; the partial-ref is emitted directly into the parent.
				pushNodeHere(partialRef);
				outerNode = partialRef;
			} else {
				// Build a wrapping ElementTNode whose single child is the partial-ref.
				// The wrapping element's attrs come from the source tag (excluding b-part / b-data:*).
				const elem = buildElement(tag, ['b-part']);
				elem.tnodes.push(partialRef);
				pushNodeHere(elem);
				outerNode = elem;
			}

			if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
				// Slot mode: cur_parent = null routes body content into partialRef.slots.default.
				cur_parent = null;
				cur_tnode = null;
				tag_stack.push({
					tag: tag.tagName,
					tnode: outerNode,
					parent: oldParent,
					hasParent: true,
					slotCollection: {
						partialRef,
						partialRefParent: containerParent,
						currentSlot: 'default'
					}
				});
			}
		}

		function handleBSlot(tag: StartTag, _raw: string, bSlotAttr: Attr) {
			// b-slot outside any b-name partial is ignored
			if (currentPartialRoot === null) {
				if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}
			const slotName = bSlotAttr.value !== '' ? bSlotAttr.value : undefined;
			const slot_node: SlotTNode = { type: 'slot', name: slotName };
			slot_node.loc = attrLoc(tag, 'b-slot');

			if (tag.tagName === 'b-unwrap') {
				// No wrapping element; the slot insertion point is emitted directly.
				// Body content (default content of the slot tag) follows as siblings of slot_node.
				pushNodeHere(slot_node);
				cur_tnode = slot_node;
				// cur_parent unchanged.
				if (!tag.selfClosing) {
					tag_stack.push({ tag: tag.tagName });
				}
			} else {
				// Build wrapping ElementTNode with the slot insertion point as its first child;
				// any body content of the b-slot tag follows as later children of the element.
				const elem = buildElement(tag, ['b-slot']);
				elem.tnodes.push(slot_node);
				const oldParent: ParentTNode | null = cur_parent;
				pushNodeHere(elem);
				cur_parent = elem;
				cur_tnode = slot_node;
				if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName, tnode: elem, parent: oldParent, hasParent: true });
				}
			}
		}

		function handleBIn(tag: StartTag, _raw: string, bInAttr: Attr): boolean {
			const innermost = getSlotCollection();
			if (!innermost) return false;
			const slotName = bInAttr.value || 'default';
			if (!innermost.partialRef.slots[slotName]) {
				innermost.partialRef.slots[slotName] = [];
			}
			const bInLoc = attrLoc(tag, 'b-in');
			if (bInLoc) {
				if (!innermost.partialRef.slotLocs) innermost.partialRef.slotLocs = {};
				innermost.partialRef.slotLocs[slotName] = bInLoc;
			}

			if (tag.tagName === 'b-unwrap') {
				// Switch slot context only; no wrapping element. Body content routes into the new slot.
				tag_stack.push({
					tag: tag.tagName,
					slotCollection: {
						partialRef: innermost.partialRef,
						partialRefParent: innermost.partialRefParent,
						currentSlot: slotName
					}
				});
			} else {
				// Build wrapping ElementTNode for the carrying tag, pushed directly into the target
				// slot array (the new currentSlot). Body content nests inside that element.
				const elem = buildElement(tag, ['b-in']);
				innermost.partialRef.slots[slotName].push(elem);
				const oldParent: ParentTNode | null = cur_parent;
				cur_parent = elem;
				cur_tnode = elem;
				if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
					tag_stack.push({
						tag: tag.tagName,
						tnode: elem,
						parent: oldParent,
						hasParent: true,
						// No slotCollection entry — content nests inside elem (which is already in the slot).
					});
				} else {
					cur_parent = oldParent;
					cur_tnode = elem;
				}
			}
			return true;
		}

		// Handle a flow directive (b-for, b-if, b-else-if, b-else) on a regular
		// (non-custom-element) tag. The wrapping ForTNode/IfTNode/IfBranch comes
		// from setupFlowContainer; if the carrying tag isn't b-unwrap, we then nest
		// an ElementTNode inside that container so the tag is rendered inside each
		// iteration / branch.
		function handleFlowOnRegularTag(tag: StartTag, raw: string, flowAttr: Attr) {
			const oldParent: ParentTNode | null = cur_parent;
			const fc = setupFlowContainer(tag, raw, flowAttr);
			if (!fc) return;
			if (tag.tagName === 'b-unwrap') {
				// Body flows directly into fc.container (no wrapping element).
				cur_parent = fc.container;
				cur_tnode = null;
				if (!tag.selfClosing) {
					tag_stack.push({ tag: tag.tagName, tnode: fc.outer, parent: fc.outerParent, hasParent: true });
				} else {
					cur_parent = oldParent;
					cur_tnode = fc.outer;
				}
			} else {
				const elem = buildElement(tag, [flowAttr.name]);
				fc.container.tnodes!.push(elem);
				cur_parent = elem;
				cur_tnode = elem;
				if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
					// On close, resume at fc.outer (the wrapping if_node/for_node) so that
					// b-else-if/b-else can chain to it among siblings of fc.outerParent.
					tag_stack.push({ tag: tag.tagName, tnode: fc.outer, parent: fc.outerParent, hasParent: true });
				} else {
					cur_parent = oldParent;
					cur_tnode = fc.outer;
				}
			}
		}

		function handleRegularTag(tag: StartTag, _raw: string) {
			const elem = buildElement(tag, []);
			const oldParent: ParentTNode | null = cur_parent;
			pushNodeHere(elem);
			cur_parent = elem;
			cur_tnode = elem;
			if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
				tag_stack.push({ tag: tag.tagName, tnode: elem, parent: oldParent, hasParent: true });
			} else {
				// Self-closing or void: no body to process; restore.
				cur_parent = oldParent;
				cur_tnode = elem;
			}
		}

		// --- startTag dispatch ---
		rewriteStream.on('startTag', (tag, raw) => { try {
			const bNameAttr = tag.attrs.find(a => a.name === 'b-name');
			if (bNameAttr) return handleBName(tag, raw, bNameAttr);

			// Top-level custom element tag: treat as a partial definition
			if (tag_stack.length === 0 && currentPartialRoot === null && isCustomElementTagName(tag.tagName)) {
				return handleCustomElementDefinition(tag, raw);
			}

			// b-attr is only allowed on custom element definition tags. Anything that
			// reaches this point in the dispatcher is NOT a custom element definition
			// (those returned above), so any b-attr:* here is an error.
			for (const attr of tag.attrs) {
				if (attr.name.startsWith('b-attr:')) {
					errors.push(new BackflipError(
						`b-attr is only allowed on custom element partial definitions`,
						attrErrorLoc(tag, attr.name, filename)
					));
				}
				if (attr.name === 'b-script') {
					errors.push(new BackflipError(
						`b-script is only allowed on custom element partial definitions`,
						attrErrorLoc(tag, attr.name, filename)
					));
				}
			}

			const bPartAttr = tag.attrs.find(a => a.name === 'b-part');
			if (bPartAttr) return handleBPart(tag, raw, bPartAttr);

			const bSlotAttr = tag.attrs.find(a => a.name === 'b-slot');
			if (bSlotAttr) return handleBSlot(tag, raw, bSlotAttr);

			const bInAttr = tag.attrs.find(a => a.name === 'b-in');
			if (bInAttr && handleBIn(tag, raw, bInAttr)) return;

			// Skip everything outside a partial
			if (currentPartialRoot === null) {
				if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}

			// Track document-level tags inside partials
			if (currentPartialRoot !== null && DOCUMENT_LEVEL_TAGS.has(tag.tagName)) {
				currentPartialRoot.meta!.isDocumentLevel = true;
			}

			// --- b-for / b-if / b-else-if / b-else ---
			const b_as = tag.attrs.filter(attr => ['b-for', 'b-if', 'b-else-if', 'b-else'].includes(attr.name));
			if (b_as.length > 1) {
				errors.push(new BackflipError("more than one b-attr", errorLoc(filename, tagLoc(tag))));
				fallbackToRawTag(tag, raw);
				return;
			}

			// Custom element call site. With a single flow directive, the call is
			// wrapped in the matching ForTNode / IfTNode (equivalent to wrapping in
			// <b-unwrap b-for|if|...>). Without a flow directive, it's a plain call.
			// b-part precedence already won above; this only runs for plain custom element tags.
			if (isCustomElementTagName(tag.tagName)) {
				if (b_as.length === 1) return handleCustomElementCallWithFlow(tag, raw, b_as[0]);
				return handleCustomElementCall(tag, raw);
			}

			if (b_as.length === 1) return handleFlowOnRegularTag(tag, raw, b_as[0]);

			handleRegularTag(tag, raw);
		} catch(e) { if (e instanceof BackflipError) { errors.push(e); } else { reject(e); } } });

		rewriteStream.on('endTag', (tag, raw) => { try {
			const matchTag = tag_stack.pop();
			if (!matchTag) {
				errors.push(new BackflipError("popped the last tagMatcher prematurely", errorLoc(filename, tagLoc(tag))));
				if (cur_tnode !== null && cur_parent !== null) cur_tnode = pushRaw(cur_tnode, cur_parent, raw);
				else if (currentPartialRoot !== null) pushRawHere(raw);
				return;
			}
			if (matchTag.tag !== tag.tagName) {
				errors.push(new BackflipError(`mismatched start/end tags: ${matchTag.tag} ${tag.tagName}`, errorLoc(filename, tagLoc(tag))));
				tag_stack.push(matchTag);
				if (cur_tnode !== null && cur_parent !== null) cur_tnode = pushRaw(cur_tnode, cur_parent, raw);
				else if (currentPartialRoot !== null) pushRawHere(raw);
				return;
			}

			// Update closeTagLoc / extend element loc through the close tag bounds for
			// any matchTag.tnode that's an ElementTNode (lets LSP and Phase 5 see the full span).
			if (matchTag.tnode && matchTag.tnode.type === 'element') {
				const closeLoc = tagSrcLoc(tag);
				if (closeLoc) {
					(matchTag.tnode as ElementTNode).closeTagLoc = closeLoc;
					const openLoc = (matchTag.tnode as ElementTNode).openTagLoc;
					if (openLoc) {
						(matchTag.tnode as ElementTNode).loc = {
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

			// If we just closed the partial's top-level element
			if (tag_stack.length === 0 && currentPartialRoot !== null) {
				// In the new ElementTNode model the wrapping element (if any) emits its own close
				// tag at codegen — no need to push raw close-tag text into the partial body.
				const endTagLoc = tag.sourceCodeLocation as { startOffset?: number } | null | undefined;
				currentPartialRoot.meta!.endOffset = (endTagLoc?.startOffset ?? 0) + raw.length;
				currentPartialRoot = null;
				currentPartialName = null;
				cur_tnode = null;
				cur_parent = null;
				return;
			}

			// All other closes: restore cur_parent / cur_tnode from the saved tag-stack entry.
			// The wrapping element (if any) closes itself at codegen, so no raw close-tag text is pushed here.
			if (matchTag.hasParent) {
				cur_parent = matchTag.parent ?? null;
				cur_tnode = matchTag.tnode ?? null;
			} else if (matchTag.tnode) {
				// Legacy entry with tnode but no explicit hasParent (e.g. unhandled corner case): fall back to old behavior.
				cur_tnode = matchTag.tnode;
				cur_parent = matchTag.parent ?? currentPartialRoot;
			}
			// Entries without tnode or hasParent (e.g. b-unwrap b-in, b-unwrap b-slot, error-recovery
			// fallbacks): leave cur_parent / cur_tnode unchanged. The popped entry just balances the stack.
		} catch(e) { if (e instanceof BackflipError) { errors.push(e); } else { reject(e); } } });

		rewriteStream.on('text', (textToken: {sourceCodeLocation?: {startLine:number;startCol:number;startOffset:number}|null}, raw: string) => { try {
			if (currentPartialRoot === null) return; // outside any partial

			const textLoc = textToken.sourceCodeLocation ?? undefined;

			const sc = getSlotCollection();
			if (sc && isAtSlotBoundary()) {
				// Insert text (with {{ }} support) into current slot
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				const arr = sc.partialRef.slots[slotName];

				const matches = raw.matchAll(INTERPOLATION_RE);
				let raw_it = 0;
				for (const m of matches) {
					if (m.index > raw_it) {
						appendCoalesced(arr, { type: 'raw', raw: raw.substring(raw_it, m.index) });
					}
					const code_str = m[0].substring(2, m[0].length - 2).trim();
					if (!code_str) {
						appendCoalesced(arr, { type: 'raw', raw: m[0] });
						raw_it = m.index + m[0].length;
						continue;
					}
					const printLoc = textLoc ? interpolationLoc(textLoc, raw.substring(0, m.index), m[0]) : undefined;
					const print_node: PrintTNode = { type: 'print', data: interpretBackcodeAt(code_str, printLoc) };
					if (printLoc) print_node.loc = printLoc;
					arr.push(print_node);
					raw_it = m.index + m[0].length;
				}
				if (raw_it < raw.length) {
					appendCoalesced(arr, { type: 'raw', raw: raw.substring(raw_it) });
				}
			} else {
				const container: ParentTNode | null = cur_parent ?? currentPartialRoot;
				if (container === null) return;
				if (cur_tnode === null) {
					// First content in this container — seed with an empty raw so onText has an anchor.
					const init: RawTNode = { type: 'raw', raw: '' };
					container.tnodes!.push(init);
					cur_tnode = init;
					if (cur_parent === null) cur_parent = container;
				}
				cur_tnode = onText(cur_tnode, container, raw, textLoc, errors);
			}
		} catch(e) { if (e instanceof BackflipError) { errors.push(e); } else { reject(e); } } });

		s.pipe(rewriteStream);
		s.on('error', (err) => { reject(err); });
		rewriteStream.on('error', (err) => { reject(err); });
		rewriteStream.on('end', () => {
			// Validate that the slice produced exactly one partial matching partialDef.
			// A mismatch here means the caller sliced incorrectly or fed the wrong def —
			// reject so the bug surfaces loudly rather than producing garbage.
			const found = compiledFile.partials.get(partialDef.name);
			if (!found) {
				const names = Array.from(compiledFile.partials.keys());
				reject(new Error(
					`compilePartial: slice did not contain expected partial "${partialDef.name}" `
					+ `(found: ${names.length === 0 ? 'none' : names.join(', ')}) in ${filename}`
				));
				return;
			}
			const isCustom = found.kind === 'custom-element';
			if (isCustom !== partialDef.customElement) {
				reject(new Error(
					`compilePartial: partial "${partialDef.name}" customElement flag mismatch `
					+ `(slice: ${isCustom}, partialDef: ${partialDef.customElement}) in ${filename}`
				));
				return;
			}
			resolve({ compiled: found, errors });
		});
	});
}


