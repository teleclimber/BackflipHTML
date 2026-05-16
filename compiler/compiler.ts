import {RewritingStream} from 'parse5-html-rewriting-stream';
import stream from 'node:stream';

import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
import { BackflipError } from './errors.js';
import type {
	SourceLoc, TNode, RawTNode, PrintTNode, ForTNode, IfTNode, IfBranch,
	SlotTNode, PartialRefTNode, BPartCallTNode, CustomElementCallTNode, ParentTNode,
	RootTNode, NamedPartialRoot, CustomElementPartialRoot, CompiledFile, CompileOptions, PartialDef, PartialBinding,
} from './types.js';
import {
	attrLoc, tagLoc, errorLoc, attrErrorLoc, bDataNameLoc, interpolationLoc,
	isBindAttr, isAssetAttr,
	buildTagPrefix, LineMap,
	isCustomElementTagName, effectiveAttrNames, parseBPartValue, parseBForValue,
	dataLocAttr as dataLocAttrPure,
	getSlotCollection as getSlotCollectionPure,
	classifyOpenTagAttrs, buildRawAttrSequence, buildAttrBindNode,
	findPrecedingIfInFile, findPrecedingIfInSlot,
	pushRaw, onText,
	DOCUMENT_LEVEL_TAGS,
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

		// Helper: push a raw string into the right place (slot or normal)
		function pushRawHere(raw: string): TNode | null {
			const sc = getSlotCollection();
			if (sc) {
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				const arr = sc.partialRef.slots[slotName];
				const lastNode = arr.length > 0 ? arr[arr.length - 1] : null;
				if (lastNode && lastNode.type === 'raw') {
					(lastNode as RawTNode).raw += raw;
					return lastNode;
				} else {
					const raw_node: RawTNode = { type: 'raw', raw };
					arr.push(raw_node);
					return raw_node;
				}
			} else {
				if (cur_tnode === null) {
					if (currentPartialRoot === null) return null;
					const raw_node: RawTNode = { type: 'raw', raw };
					currentPartialRoot.tnodes.push(raw_node);
					cur_tnode = raw_node;
					cur_parent = currentPartialRoot;
					return raw_node;
				}
				if (cur_parent === null) throw new BackflipError("pushRawHere: cur_parent unset");
				return pushRaw(cur_tnode, cur_parent, raw);
			}
		}

		// Helper: push a TNode into the current parent or slot
		function pushNodeHere(node: TNode) {
			const sc = getSlotCollection();
			if (sc) {
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				sc.partialRef.slots[slotName].push(node);
			} else {
				if (cur_parent !== null) {
					cur_parent.tnodes!.push(node);
				} else if (currentPartialRoot !== null) {
					currentPartialRoot.tnodes.push(node);
				}
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

		// Helper: make TNode(s) for a tag's open element.
		// Returns an array because tags with static asset attrs produce interleaved RawTNode + AssetRefTNode nodes.
		function makeOpenTagNode(tag: {tagName:string, attrs:{name:string,value:string}[], selfClosing:boolean, sourceCodeLocation?: unknown}, excludeAttrs: string[]): TNode[] {
			if (tag.tagName === 'b-unwrap') {
				return [{ type: 'raw', raw: '' } as RawTNode];
			}
			const closeBracket = tag.selfClosing ? ' />' : '>';
			const { segments, hasBind } = classifyAttrs(tag, excludeAttrs);
			const locStr = dataLocAttr(tag);
			if (!hasBind) {
				return buildRawAttrSequence(segments, `<${tag.tagName}`, locStr + closeBracket);
			}
			return [buildAttrBindNode(segments, `<${tag.tagName}`, locStr, tag.selfClosing, false)];
		}

		// Like makeOpenTagNode but without the leading `<tagName` and trailing
		// `>` / ` />`. Used for custom element partials, where the call site
		// and definition merge into a single rendered tag and neither side
		// emits the brackets.
		function makeAttrsOnlyNodes(tag: {tagName:string, attrs:{name:string,value:string}[], selfClosing:boolean, sourceCodeLocation?: unknown}, excludeAttrs: string[]): TNode[] {
			if (tag.tagName === 'b-unwrap') {
				return [{ type: 'raw', raw: '' } as RawTNode];
			}
			const { segments, hasBind } = classifyAttrs(tag, excludeAttrs);
			const locStr = dataLocAttr(tag);
			if (!hasBind) {
				return buildRawAttrSequence(segments, '', locStr);
			}
			return [buildAttrBindNode(segments, '', locStr, false, true)];
		}

		const void_elements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

		// Error-recovery: drop the tag back to a raw string and keep the parser balanced.
		// Used by flow-directive handlers when they can't construct their structured node.
		function fallbackToRawTag(tag: StartTag, raw: string): void {
			const new_cur = pushRawHere(raw);
			if (cur_tnode !== null) {
				cur_tnode = new_cur;
				// cur_parent unchanged: pushRawHere appends a sibling within the same container.
			}
			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
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
				const for_node: ForTNode = { type: 'for', iterable: parsed.iterable, valName: parsed.valName, tnodes: [] };
				for_node.loc = attrLoc(tag, 'b-for');
				if (sc) pushNodeHere(for_node);
				else flowParent.tnodes!.push(for_node);
				return { container: for_node, outer: for_node, outerParent: flowParent };
			}

			if (flowAttr.name === 'b-if') {
				const if_node: IfTNode = { type: 'if', branches: [] };
				const branch: IfBranch = { condition: interpretBackcode(flowAttr.value), tnodes: [] };
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
			const condition = flowAttr.name === 'b-else-if' ? interpretBackcode(flowAttr.value) : undefined;
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
					const binding: PartialBinding = { kind: 'expr', name: bindingName, data: interpretBackcode(attr.value) };
					const nameLoc = bDataNameLoc(tag, attr.name, bindingName);
					if (nameLoc) binding.nameLoc = nameLoc;
					bindings.push(binding);
				}
			}

			// Flow directives on the call site are consumed by the wrapping ForTNode /
			// IfTNode (built in handleCustomElementCallWithFlow) and must never appear in
			// the rendered tag. They're excluded here so makeAttrsOnlyNodes drops them.
			// In the non-flow call path they're absent anyway, so the extra excludes are no-ops.
			const callerOpenTag = makeAttrsOnlyNodes(tag, ['b-export', 'b-if', 'b-for', 'b-else', 'b-else-if']);

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
				callerOpenTag,
				callerTagName: tag.tagName,
				callerAttrNames: effectiveAttrNames(tag.attrs),
				callerAttrInfos,
				unresolvedRaw: raw,
			};
			const tagSrcLoc = tag.sourceCodeLocation as { startLine?: number; startCol?: number; startOffset?: number; endLine?: number; endCol?: number; endOffset?: number } | null | undefined;
			if (tagSrcLoc?.startLine != null) {
				partialRef.loc = {
					startLine: tagSrcLoc.startLine,
					startCol: tagSrcLoc.startCol ?? 1,
					startOffset: tagSrcLoc.startOffset ?? 0,
					endLine: tagSrcLoc.endLine ?? tagSrcLoc.startLine,
					endCol: tagSrcLoc.endCol ?? (tagSrcLoc.startCol ?? 1),
					endOffset: tagSrcLoc.endOffset ?? (tagSrcLoc.startOffset ?? 0) + raw.length,
				};
			}
			return partialRef;
		}

		const rewriteStream = new RewritingStream();

		// --- startTag directive handlers ---
		// Each handler is an inner function closing over compiler state (cur_tnode, currentPartialRoot, tag_stack, etc.)

		type StartTag = { tagName: string, attrs: { name: string, value: string }[], selfClosing: boolean, sourceCodeLocation?: unknown };
		type Attr = { name: string, value: string };

		function handleBName(tag: StartTag, raw: string, bNameAttr: Attr) {
			if (tag_stack.length > 0) {
				errors.push(new BackflipError("b-name is only allowed on top-level elements", attrErrorLoc(tag, 'b-name', filename)));
				// Treat as raw tag within current partial
				const new_cur = pushRawHere(raw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
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
			}

			const partialName = bNameAttr.value;
			const tagSrcLoc = tag.sourceCodeLocation as { startOffset?: number; startLine?: number; startCol?: number } | null | undefined;
			const partialRoot: NamedPartialRoot = { type: 'root', kind: 'named', tnodes: [], meta: {
				startOffset: tagSrcLoc?.startOffset ?? 0,
				endOffset: tagSrcLoc?.startOffset ?? 0, // updated on close
				startLine: tagSrcLoc?.startLine ?? 1,
				startCol: tagSrcLoc?.startCol ?? 1,
				isDocumentLevel: DOCUMENT_LEVEL_TAGS.has(tag.tagName),
			} };
			partialRoot.loc = attrLoc(tag, 'b-name');
			partialRoot.exported = tag.attrs.some(a => a.name === 'b-export');
			compiledFile.partials.set(partialName, partialRoot);

			currentPartialRoot = partialRoot;
			currentPartialName = partialName;

			if (tag.tagName === 'b-unwrap') {
				// Don't emit opening tag; just track for closing
				const init_raw: RawTNode = { type: 'raw', raw: '' };
				partialRoot.tnodes.push(init_raw);
				cur_tnode = init_raw;
				cur_parent = partialRoot;
				if (!tag.selfClosing) {
					tag_stack.push({ tag: tag.tagName });
				}
			} else {
				const openNodes = makeOpenTagNode(tag, ['b-name', 'b-export']);
				for (const n of openNodes) partialRoot.tnodes.push(n);
				const lastOpen = openNodes[openNodes.length - 1];
				cur_tnode = lastOpen?.type === 'raw' ? lastOpen as RawTNode : null;
				cur_parent = partialRoot;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				} else {
					// Self-closing or void element: end offset is end of this tag
					partialRoot.meta!.endOffset = (tagSrcLoc?.startOffset ?? 0) + raw.length;
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
			const tagSrcLoc = tag.sourceCodeLocation as { startOffset?: number; endOffset?: number; startLine?: number; startCol?: number; endLine?: number; endCol?: number } | null | undefined;
			const partialRoot: CustomElementPartialRoot = { type: 'root', kind: 'custom-element', tnodes: [], meta: {
				startOffset: tagSrcLoc?.startOffset ?? 0,
				endOffset: tagSrcLoc?.startOffset ?? 0, // updated on close
				startLine: tagSrcLoc?.startLine ?? 1,
				startCol: tagSrcLoc?.startCol ?? 1,
				isDocumentLevel: false,
			} };
			if (tagSrcLoc?.startLine != null) {
				partialRoot.loc = {
					startLine: tagSrcLoc.startLine,
					startCol: tagSrcLoc.startCol ?? 1,
					startOffset: tagSrcLoc.startOffset ?? 0,
					endLine: tagSrcLoc.endLine ?? tagSrcLoc.startLine,
					endCol: tagSrcLoc.endCol ?? (tagSrcLoc.startCol ?? 1),
					endOffset: tagSrcLoc.endOffset ?? (tagSrcLoc.startOffset ?? 0) + raw.length,
				};
			}
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
			compiledFile.partials.set(partialName, partialRoot);

			currentPartialRoot = partialRoot;
			currentPartialName = partialName;

			// For custom element partials, the open tag is rendered by the call site (merged
			// with caller-side attrs into one tag), so we keep it OFF of partialRoot.tnodes.
			// We do still need to compile the open tag's attrs (in attrs-only form) and store
			// them so the call-site renderer can emit them in childCtx.
			partialRoot.definitionAttrNodes = makeAttrsOnlyNodes(tag, ['b-export']);
			// Seed the body with an empty raw sentinel so subsequent text/tags get appended here.
			const sentinel: RawTNode = { type: 'raw', raw: '' };
			partialRoot.tnodes.push(sentinel);
			cur_tnode = sentinel;
			cur_parent = partialRoot;
			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				tag_stack.push({ tag: tag.tagName });
			} else {
				partialRoot.meta!.endOffset = (tagSrcLoc?.startOffset ?? 0) + raw.length;
			}
		}

		function handleCustomElementCall(tag: StartTag, raw: string) {
			// Pre-conditions: not top-level, isCustomElementTagName(tag.tagName), no b-name, no b-part,
			// no flow directive on the same tag (see handleCustomElementCallWithFlow for that case).
			// Inside a partial (cur_tnode or currentPartialRoot must be set; the dispatcher's "skip
			// outside partial" path runs before this).
			const parent: ParentTNode = cur_parent ?? currentPartialRoot!;
			const partialRef = buildCustomElementPartialRef(tag, raw);
			pushNodeHere(partialRef);

			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				tag_stack.push({
					tag: tag.tagName,
					tnode: partialRef,
					parent,
					slotCollection: {
						partialRef,
						partialRefParent: parent,
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
			const fc = setupFlowContainer(tag, raw, flowAttr);
			if (!fc) return;
			const partialRef = buildCustomElementPartialRef(tag, raw);
			fc.container.tnodes!.push(partialRef);
			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				// tag_stack entry combines two roles:
				//   - slotCollection: children of the call site go into the partial-ref's default slot
				//   - tnode = fc.outer: on endTag, cur_tnode is repositioned as a sibling of the
				//     outer flow node (so a following b-else can chain to this if_node).
				tag_stack.push({
					tag: tag.tagName,
					tnode: fc.outer,
					parent: fc.outerParent,
					slotCollection: { partialRef, partialRefParent: fc.container, currentSlot: 'default' },
				});
			}
		}

		function handleBPart(tag: StartTag, raw: string, bPartAttr: Attr) {
			// b-part outside any b-name partial is ignored
			if (cur_tnode === null && currentPartialRoot === null) {
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}
			const { file, partialName } = parseBPartValue(bPartAttr.value);

			const bindings: PartialBinding[] = [];
			for (const attr of tag.attrs) {
				if (attr.name.startsWith('b-data:')) {
					const bindingName = attr.name.slice('b-data:'.length);
					const binding: PartialBinding = { kind: 'expr', name: bindingName, data: interpretBackcode(attr.value) };
					const nameLoc = bDataNameLoc(tag, attr.name, bindingName);
					if (nameLoc) binding.nameLoc = nameLoc;
					bindings.push(binding);
				}
			}

			let wrapper: { open: string, close: string } | null;
			if (tag.tagName === 'b-unwrap') {
				wrapper = null;
			} else {
				const open = buildTagPrefix(tag, ['b-part']) + dataLocAttr(tag) + (tag.selfClosing ? ' />' : '>');
				wrapper = { open, close: `</${tag.tagName}>` };
			}

			const parent: ParentTNode = cur_parent ?? currentPartialRoot!;

			const partialRef: BPartCallTNode = {
				type: 'partial-ref',
				kind: 'b-part',
				file,
				partialName,
				wrapper,
				slots: { 'default': [] },
				slotLocs: {},
				bindings,
			};
			partialRef.loc = attrLoc(tag, 'b-part');

			pushNodeHere(partialRef);

			if (!tag.selfClosing && tag.tagName !== 'b-unwrap' || tag.tagName === 'b-unwrap' && !tag.selfClosing) {
				tag_stack.push({
					tag: tag.tagName,
					tnode: partialRef,
					parent,
					slotCollection: {
						partialRef,
						partialRefParent: parent,
						currentSlot: 'default'
					}
				});
			}
		}

		function handleBSlot(tag: StartTag, _raw: string, bSlotAttr: Attr) {
			// b-slot outside any b-name partial is ignored
			if (cur_tnode === null && currentPartialRoot === null) {
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}
			const slotName = bSlotAttr.value !== '' ? bSlotAttr.value : undefined;
			const parent: ParentTNode = cur_parent ?? currentPartialRoot!;

			// For non-b-unwrap tags, the carrying element wraps the slot in the output:
			// emit the open tag before the slot node; the close tag is added after
			// through the regular endTag path (matched via tnode = slot_node).
			if (tag.tagName !== 'b-unwrap') {
				const openNodes = makeOpenTagNode(tag, ['b-slot']);
				for (const n of openNodes) {
					parent.tnodes!.push(n);
				}
			}

			const slot_node: SlotTNode = { type: 'slot', name: slotName };
			slot_node.loc = attrLoc(tag, 'b-slot');

			parent.tnodes!.push(slot_node);
			cur_tnode = slot_node as unknown as TNode;
			cur_parent = parent;

			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				// Push to tag_stack so endTag is consumed correctly.
				// For b-unwrap b-slot, don't store tnode so endTag has no special effect.
				if (tag.tagName === 'b-unwrap') {
					tag_stack.push({ tag: tag.tagName });
				} else {
					tag_stack.push({ tag: tag.tagName, tnode: slot_node as unknown as TNode, parent });
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
			tag_stack.push({
				tag: tag.tagName,
				slotCollection: {
					partialRef: innermost.partialRef,
					partialRefParent: innermost.partialRefParent,
					currentSlot: slotName
				}
			});
			// For non-b-unwrap elements, emit the opening tag into the slot
			if (tag.tagName !== 'b-unwrap') {
				pushRawHere(buildTagPrefix(tag, ['b-in']) + dataLocAttr(tag) + '>');
			}
			return true;
		}

		// Handle a flow directive (b-for, b-if, b-else-if, b-else) on a regular
		// (non-custom-element) tag. The wrapping ForTNode/IfTNode/IfBranch comes
		// from setupFlowContainer; then we drop the tag's own open-tag TNodes into
		// the container so the tag is rendered inside each iteration / branch.
		function handleFlowOnRegularTag(tag: StartTag, raw: string, flowAttr: Attr) {
			const fc = setupFlowContainer(tag, raw, flowAttr);
			if (!fc) return;
			const inner = makeOpenTagNode(tag, [flowAttr.name]);
			for (const n of inner) fc.container.tnodes!.push(n);
			const last = inner[inner.length - 1];
			cur_tnode = last ?? null;
			cur_parent = fc.container;
			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				// On close, resume at fc.outer (the wrapping if_node/for_node) so that
				// b-else-if/b-else can chain to it among siblings of fc.outerParent.
				tag_stack.push({ tag: tag.tagName, tnode: fc.outer, parent: fc.outerParent });
			}
		}

		function handleRegularTag(tag: StartTag, raw: string) {
			const hasBindAttrs = tag.attrs.some(attr => isBindAttr(attr.name));
			const hasAssetAttrs = tag.attrs.some(attr => isAssetAttr(attr.name));
			if (hasBindAttrs || hasAssetAttrs) {
				const nodes = makeOpenTagNode(tag, []);
				for (const n of nodes) pushNodeHere(n);
				const lastNode = nodes[nodes.length - 1];
				cur_tnode = lastNode ?? null;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
			} else {
				const loc = dataLocAttr(tag);
				const tagRaw = loc ? raw.replace(/(\s*\/?)>$/, loc + '$1>') : raw;  // preserves self-closing />
				const new_cur = pushRawHere(tagRaw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
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
			}

			const bPartAttr = tag.attrs.find(a => a.name === 'b-part');
			if (bPartAttr) return handleBPart(tag, raw, bPartAttr);

			const bSlotAttr = tag.attrs.find(a => a.name === 'b-slot');
			if (bSlotAttr) return handleBSlot(tag, raw, bSlotAttr);

			const bInAttr = tag.attrs.find(a => a.name === 'b-in');
			if (bInAttr && handleBIn(tag, raw, bInAttr)) return;

			// Skip everything outside a partial
			if (cur_tnode === null && currentPartialRoot === null) {
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
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

			// If we just closed the partial's top-level element
			if (tag_stack.length === 0 && currentPartialRoot !== null) {
				// Custom element partials don't include the wrapping tag in the body —
				// the open and close tags are reconstructed at the call site.
				if (tag.tagName !== 'b-unwrap' && currentPartialRoot.kind !== 'custom-element') {
					pushRawHere(raw);
				}
				// Record end offset of the partial
				const endTagLoc = tag.sourceCodeLocation as { startOffset?: number } | null | undefined;
				currentPartialRoot.meta!.endOffset = (endTagLoc?.startOffset ?? 0) + raw.length;
				// End of this partial
				currentPartialRoot = null;
				currentPartialName = null;
				cur_tnode = null;
				cur_parent = null;
				return;
			}

			// If this was a slotCollection entry
			if (matchTag.slotCollection) {
				const tnode = matchTag.tnode;
				// Three shapes land here:
				//   - tnode.type === 'partial-ref' — plain b-part / custom element call.
				//   - tnode.type === 'for' | 'if'  — custom element call with a flow directive;
				//     resume as a SIBLING of the flow node, not inside it.
				// In all three, the next emit point is a fresh raw node in matchTag.parent.
				if (tnode && (tnode.type === 'partial-ref' || tnode.type === 'for' || tnode.type === 'if')) {
					const parent = matchTag.parent!;
					const new_raw: RawTNode = { type: 'raw', raw: '' };
					parent.tnodes!.push(new_raw);
					cur_tnode = new_raw;
					cur_parent = parent;
				}
				// b-in closing - emit closing tag for non-b-unwrap elements
				else if (matchTag.tag !== 'b-unwrap') {
					const sc = matchTag.slotCollection!;
					const slotName = sc.currentSlot;
					const arr = sc.partialRef.slots[slotName];
					const lastNode = arr.length > 0 ? arr[arr.length - 1] : null;
					if (lastNode && lastNode.type === 'raw') {
						(lastNode as RawTNode).raw += raw;
					} else {
						const raw_node: RawTNode = { type: 'raw', raw };
						arr.push(raw_node);
					}
				}
				return;
			}

			// Regular closing
			if (matchTag.tnode) {
				// Close tag belongs to the structured node (b-for/b-if/b-slot), not the slot
				if (cur_tnode !== null && cur_parent !== null && tag.tagName !== 'b-unwrap') {
					cur_tnode = pushRaw(cur_tnode, cur_parent, raw);
				}
			} else {
				const sc = getSlotCollection();
				if (sc) {
					pushRawHere(raw);
				} else if (cur_tnode !== null && cur_parent !== null) {
					cur_tnode = pushRaw(cur_tnode, cur_parent, raw);
				}
			}

			if (matchTag.tnode) {
				// Resume the cursor at the structural node and its container so that:
				//   - subsequent pushRaw appends a sibling after the closed node,
				//   - b-else-if/b-else can chain to a preceding b-if among siblings.
				cur_tnode = matchTag.tnode;
				cur_parent = matchTag.parent ?? currentPartialRoot;
			}
		} catch(e) { if (e instanceof BackflipError) { errors.push(e); } else { reject(e); } } });

		rewriteStream.on('text', (textToken: {sourceCodeLocation?: {startLine:number;startCol:number;startOffset:number}|null}, raw: string) => { try {
			if (cur_tnode === null && currentPartialRoot === null) return; // outside any partial

			const textLoc = textToken.sourceCodeLocation ?? undefined;

			const sc = getSlotCollection();
			if (sc) {
				// Insert text (with {{ }} support) into current slot
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				const arr = sc.partialRef.slots[slotName];

				const matches = raw.matchAll(cf_text_regex);
				let raw_it = 0;
				for (const m of matches) {
					if (m.index > raw_it) {
						const sub = raw.substring(raw_it, m.index);
						const last = arr.length > 0 ? arr[arr.length - 1] : null;
						if (last && last.type === 'raw') { (last as RawTNode).raw += sub; }
						else { arr.push({ type: 'raw', raw: sub }); }
					}
					const code_str = m[0].substring(2, m[0].length - 2).trim();
					if (!code_str) {
						const last = arr.length > 0 ? arr[arr.length - 1] : null;
						if (last && last.type === 'raw') { (last as RawTNode).raw += m[0]; }
						else { arr.push({ type: 'raw', raw: m[0] }); }
						raw_it = m.index + m[0].length;
						continue;
					}
					const print_node: PrintTNode = { type: 'print', data: interpretBackcode(code_str) };
					if (textLoc) print_node.loc = interpolationLoc(textLoc, raw.substring(0, m.index), m[0]);
					arr.push(print_node);
					raw_it = m.index + m[0].length;
				}
				if (raw_it < raw.length) {
					const sub = raw.substring(raw_it);
					const last = arr.length > 0 ? arr[arr.length - 1] : null;
					if (last && last.type === 'raw') { (last as RawTNode).raw += sub; }
					else { arr.push({ type: 'raw', raw: sub }); }
				}
			} else if (cur_tnode !== null && cur_parent !== null) {
				cur_tnode = onText(cur_tnode, cur_parent, raw, textLoc);
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

const cf_text_regex = new RegExp("({{[^{}]*}})", 'g');

