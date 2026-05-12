import {RewritingStream} from 'parse5-html-rewriting-stream';
import stream from 'node:stream';

import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
import { BackflipError } from './errors.js';
import type {
	SourceLoc, TNode, RawTNode, PrintTNode, ForTNode, IfTNode, IfBranch,
	SlotTNode, PartialRefTNode, AttrBindTNode, AssetRefTNode, AttrPart, ParentTNode,
	RootTNode, CompiledFile, CompileOptions, PartialDef, PartialBinding,
} from './types.js';
import {
	attrLoc, tagLoc, errorLoc, attrErrorLoc, bDataNameLoc, interpolationLoc,
	isBindAttr, getBindAttrName, isAssetAttr, stripAssetSuffix,
	buildTagPrefix, convertToAttrsOnly, LineMap,
	isCustomElementTagName, effectiveAttrNames,
	dataLocAttr as dataLocAttrPure,
	getSlotCollection as getSlotCollectionPure,
	validateStaticAssetAttr as validateStaticAssetAttrPure,
	findPrecedingIfInFile, findPrecedingIfInSlot,
	pushRaw, onText,
	DOCUMENT_LEVEL_TAGS, BOOLEAN_ATTRS,
	type TagMatcher,
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
					const raw_node: RawTNode = { type: 'raw', raw, parent: sc.partialRef.parent };
					arr.push(raw_node);
					return raw_node;
				}
			} else {
				if (cur_tnode === null) {
					if (currentPartialRoot === null) return null;
					const raw_node: RawTNode = { type: 'raw', raw, parent: currentPartialRoot };
					currentPartialRoot.tnodes.push(raw_node);
					cur_tnode = raw_node;
					return raw_node;
				}
				return pushRaw(cur_tnode, raw);
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
				if (cur_tnode !== null) {
					cur_tnode.parent.tnodes!.push(node);
				} else if (currentPartialRoot !== null) {
					currentPartialRoot.tnodes.push(node);
				}
			}
		}

		const assetMap = options?.assetMap;
		const assetDirs = options?.assetDirs;

		const validateStaticAssetAttr = (attrName: string, value: string, tag: { sourceCodeLocation?: unknown }, origAttrName: string) =>
			validateStaticAssetAttrPure(attrName, value, tag, origAttrName, { html, lineMap, assetMap, assetDirs, filename });

		// Helper: make TNode(s) for a tag's open element.
		// Returns an array because tags with static asset attrs produce interleaved RawTNode + AssetRefTNode nodes.
		function makeOpenTagNode(tag: {tagName:string, attrs:{name:string,value:string}[], selfClosing:boolean, sourceCodeLocation?: unknown}, excludeAttrs: string[], parent: ParentTNode): TNode[] {
			if (tag.tagName === 'b-unwrap') {
				return [{ type: 'raw', raw: '', parent } as RawTNode];
			}
			const closeBracket = tag.selfClosing ? ' />' : '>';
			const hasBind = tag.attrs.some(attr => isBindAttr(attr.name));
			const hasAsset = tag.attrs.some(attr => !excludeAttrs.includes(attr.name) && isAssetAttr(attr.name));

			// Case A: no binds, no assets — single RawTNode
			if (!hasBind && !hasAsset) {
				return [{ type: 'raw', raw: buildTagPrefix(tag, excludeAttrs) + dataLocAttr(tag) + closeBracket, parent } as RawTNode];
			}

			// Case B: no binds, has static asset attrs — interleaved RawTNode + AssetRefTNode
			if (!hasBind) {
				const nodes: TNode[] = [];
				let buf = `<${tag.tagName}`;
				for (const attr of tag.attrs) {
					if (excludeAttrs.includes(attr.name) || attr.name.startsWith('b-data:') || attr.name.startsWith('b-attr:')) continue;
					if (isAssetAttr(attr.name)) {
						const realName = stripAssetSuffix(attr.name);
						const { refs, originalValue, error } = validateStaticAssetAttr(realName, attr.value, tag, attr.name);
						if (error) {
							errors.push(error);
							continue;
						}
						// Flush buffer as RawTNode before the asset ref
						if (buf) { nodes.push({ type: 'raw', raw: buf, parent } as RawTNode); buf = ''; }
						nodes.push({ type: 'asset-ref', attrName: realName, originalValue, refs, parent, loc: attrLoc(tag, attr.name) } as AssetRefTNode);
					} else {
						buf += ` ${attr.name}="${attr.value}"`;
					}
				}
				buf += dataLocAttr(tag) + closeBracket;
				nodes.push({ type: 'raw', raw: buf, parent } as RawTNode);
				return nodes;
			}

			// Case C/D: has binds (possibly with static asset attrs and/or dynamic asset binds)
			const tagOpen = `<${tag.tagName}`;
			const parts: AttrPart[] = [];
			let staticBuf = '';
			for (const attr of tag.attrs) {
				if (excludeAttrs.includes(attr.name) || attr.name.startsWith('b-data:') || attr.name.startsWith('b-attr:')) continue;
				if (isBindAttr(attr.name)) {
					if (staticBuf) { parts.push({ type: 'static', raw: staticBuf }); staticBuf = ''; }
					let bindName = getBindAttrName(attr.name);
					let isAssetBind = false;
					if (isAssetAttr(bindName)) {
						bindName = stripAssetSuffix(bindName);
						if (!assetMap) {
							errors.push(new BackflipError(`${bindName}~ used but no asset directories are configured`, attrErrorLoc(tag, attr.name, filename)));
							continue;
						}
						if (bindName === 'style') {
							errors.push(new BackflipError(`style~ is not supported`, attrErrorLoc(tag, attr.name, filename)));
							continue;
						}
						isAssetBind = true;
					}
					const part: AttrPart = { type: 'dynamic', name: bindName, expr: interpretBackcode(attr.value), isBoolean: BOOLEAN_ATTRS.has(bindName), loc: attrLoc(tag, attr.name) };
					if (isAssetBind) part.isAsset = true;
					parts.push(part);
				} else if (isAssetAttr(attr.name)) {
					const realName = stripAssetSuffix(attr.name);
					const { refs, originalValue, error } = validateStaticAssetAttr(realName, attr.value, tag, attr.name);
					if (error) {
						errors.push(error);
						continue;
					}
					// Flush staticBuf before pushing asset part
					if (staticBuf) { parts.push({ type: 'static', raw: staticBuf }); staticBuf = ''; }
					parts.push({ type: 'asset', attrName: realName, originalValue, refs, loc: attrLoc(tag, attr.name) });
				} else {
					staticBuf += ` ${attr.name}="${attr.value}"`;
				}
			}
			staticBuf += dataLocAttr(tag);
			if (staticBuf) parts.push({ type: 'static', raw: staticBuf });
			const node: AttrBindTNode = { type: 'attr-bind', tagOpen, parts, parent };
			if (tag.selfClosing) node.selfClosing = true;
			return [node];
		}

		const void_elements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

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
			const partialRoot: RootTNode = { type: 'root', tnodes: [], meta: {
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
				const init_raw: RawTNode = { type: 'raw', raw: '', parent: partialRoot };
				partialRoot.tnodes.push(init_raw);
				cur_tnode = init_raw;
				if (!tag.selfClosing) {
					tag_stack.push({ tag: tag.tagName });
				}
			} else {
				const openNodes = makeOpenTagNode(tag, ['b-name', 'b-export'], partialRoot);
				for (const n of openNodes) partialRoot.tnodes.push(n);
				const lastOpen = openNodes[openNodes.length - 1];
				cur_tnode = lastOpen?.type === 'raw' ? lastOpen as RawTNode : null;
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
			const partialRoot: RootTNode = { type: 'root', tnodes: [], meta: {
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
			partialRoot.customElement = true;

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
			const openNodes = makeOpenTagNode(tag, ['b-export'], partialRoot);
			partialRoot.definitionAttrNodes = convertToAttrsOnly(openNodes, tag.tagName, partialRoot);
			// Seed the body with an empty raw sentinel so subsequent text/tags get appended here.
			const sentinel: RawTNode = { type: 'raw', raw: '', parent: partialRoot };
			partialRoot.tnodes.push(sentinel);
			cur_tnode = sentinel;
			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				tag_stack.push({ tag: tag.tagName });
			} else {
				partialRoot.meta!.endOffset = (tagSrcLoc?.startOffset ?? 0) + raw.length;
			}
		}

		function handleCustomElementCall(tag: StartTag, raw: string) {
			// Pre-conditions: not top-level, isCustomElementTagName(tag.tagName), no b-name, no b-part.
			// Inside a partial (cur_tnode or currentPartialRoot must be set; the dispatcher's "skip
			// outside partial" path runs before this).

			const bindings: PartialBinding[] = [];
			for (const attr of tag.attrs) {
				if (attr.name.startsWith('b-data:')) {
					const bindingName = attr.name.slice('b-data:'.length);
					const binding: PartialBinding = { name: bindingName, data: interpretBackcode(attr.value) };
					const nameLoc = bDataNameLoc(tag, attr.name, bindingName);
					if (nameLoc) binding.nameLoc = nameLoc;
					bindings.push(binding);
				}
			}

			const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;

			// Build call-site open-tag TNodes, then convert to attrs-only form. These will
			// be evaluated in the caller's context and merged with the definition's attrs
			// inside a single rendered tag at the call site.
			const fullOpenTag = makeOpenTagNode(tag, ['b-export'], parent);
			const callerOpenTag = convertToAttrsOnly(fullOpenTag, tag.tagName, parent);

			// Build rich per-attribute info from the call-site tag for downstream
			// stages (b-attr resolution, conflict checks, codegen). Skip everything
			// effectiveAttrNames already skips, plus b-attr:* (which shouldn't appear
			// on a call site anyway — the dispatcher already errors on those).
			const callerAttrInfos: NonNullable<PartialRefTNode['callerAttrInfos']> = [];
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

			const partialRef: PartialRefTNode = {
				type: 'partial-ref',
				file: null,                        // resolved post-parse via global registry
				partialName: tag.tagName,
				wrapper: null,                     // built at codegen time from callerOpenTag + definition's open tag
				slots: { 'default': [] },
				slotLocs: {},
				bindings,
				parent,
				customElement: true,
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

			pushNodeHere(partialRef);

			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				tag_stack.push({
					tag: tag.tagName,
					tnode: partialRef,
					slotCollection: {
						partialRef,
						currentSlot: 'default'
					}
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
			const partValue = bPartAttr.value;
			let file: string | null;
			let partialName: string;
			if (partValue.startsWith('#')) {
				file = null;
				partialName = partValue.slice(1);
			} else {
				const hashIdx = partValue.indexOf('#');
				if (hashIdx === -1) {
					file = null;
					partialName = partValue;
				} else {
					file = partValue.slice(0, hashIdx);
					partialName = partValue.slice(hashIdx + 1);
				}
			}

			const bindings: PartialBinding[] = [];
			for (const attr of tag.attrs) {
				if (attr.name.startsWith('b-data:')) {
					const bindingName = attr.name.slice('b-data:'.length);
					const binding: PartialBinding = { name: bindingName, data: interpretBackcode(attr.value) };
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

			const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;

			const partialRef: PartialRefTNode = {
				type: 'partial-ref',
				file,
				partialName,
				wrapper,
				slots: { 'default': [] },
				slotLocs: {},
				bindings,
				parent
			};
			partialRef.loc = attrLoc(tag, 'b-part');

			pushNodeHere(partialRef);

			if (!tag.selfClosing && tag.tagName !== 'b-unwrap' || tag.tagName === 'b-unwrap' && !tag.selfClosing) {
				tag_stack.push({
					tag: tag.tagName,
					tnode: partialRef,
					slotCollection: {
						partialRef,
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
			const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;

			// For non-b-unwrap tags, the carrying element wraps the slot in the output:
			// emit the open tag before the slot node; the close tag is added after
			// through the regular endTag path (matched via tnode = slot_node).
			if (tag.tagName !== 'b-unwrap') {
				const openNodes = makeOpenTagNode(tag, ['b-slot'], parent);
				for (const n of openNodes) {
					if (cur_tnode !== null) {
						cur_tnode.parent.tnodes!.push(n);
					} else if (currentPartialRoot !== null) {
						currentPartialRoot.tnodes.push(n);
					}
				}
			}

			const slot_node: SlotTNode = { type: 'slot', name: slotName, parent };
			slot_node.loc = attrLoc(tag, 'b-slot');

			if (cur_tnode !== null) {
				cur_tnode.parent.tnodes!.push(slot_node);
			} else if (currentPartialRoot !== null) {
				currentPartialRoot.tnodes.push(slot_node);
			}
			cur_tnode = slot_node as unknown as TNode;

			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				// Push to tag_stack so endTag is consumed correctly.
				// For b-unwrap b-slot, don't store tnode so endTag has no special effect.
				if (tag.tagName === 'b-unwrap') {
					tag_stack.push({ tag: tag.tagName });
				} else {
					tag_stack.push({ tag: tag.tagName, tnode: slot_node as unknown as TNode });
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
					currentSlot: slotName
				}
			});
			// For non-b-unwrap elements, emit the opening tag into the slot
			if (tag.tagName !== 'b-unwrap') {
				pushRawHere(buildTagPrefix(tag, ['b-in']) + dataLocAttr(tag) + '>');
			}
			return true;
		}

		function handleBFor(tag: StartTag, raw: string, b_a: Attr) {
			const pieces = b_a.value.split(" in ");
			if (pieces.length !== 2) {
				errors.push(new BackflipError(`b-for value must be in the form "item in items", got: "${b_a.value}"`, attrErrorLoc(tag, 'b-for', filename)));
				const new_cur = pushRawHere(raw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}
			const iterable_parsed = interpretBackcode(pieces[1].trim());
			const value_name = pieces[0].trim();
			if (!value_name) {
				errors.push(new BackflipError(`got bad iter value name: ${value_name}`, attrErrorLoc(tag, 'b-for', filename)));
				const new_cur = pushRawHere(raw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}

			const sc_for = getSlotCollection();
			const parent: ParentTNode = sc_for ? sc_for.partialRef.parent : (cur_tnode ? cur_tnode.parent : currentPartialRoot!);
			const for_node: ForTNode = { type: 'for', iterable: iterable_parsed, valName: value_name, tnodes: [], parent };
			for_node.loc = attrLoc(tag, 'b-for');
			const inner_tags = makeOpenTagNode(tag, ['b-for'], for_node);
			for (const n of inner_tags) for_node.tnodes.push(n);
			if (sc_for) {
				pushNodeHere(for_node);
			} else {
				parent.tnodes!.push(for_node);
			}
			const lastFor = inner_tags[inner_tags.length - 1];
			cur_tnode = lastFor ?? null;
			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				tag_stack.push({ tag: tag.tagName, tnode: lastFor });
			}
		}

		function handleBIf(tag: StartTag, _raw: string, b_a: Attr) {
			const sc_if = getSlotCollection();
			const parent: ParentTNode = sc_if ? sc_if.partialRef.parent : (cur_tnode ? cur_tnode.parent : currentPartialRoot!);
			const if_node: IfTNode = { type: 'if', branches: [], parent };
			const branch: IfBranch = { condition: interpretBackcode(b_a.value), tnodes: [], ifNode: if_node };
			branch.loc = attrLoc(tag, 'b-if');
			if_node.branches.push(branch);
			const inner_tags_if = makeOpenTagNode(tag, ['b-if'], branch);
			for (const n of inner_tags_if) branch.tnodes.push(n);
			if (sc_if) {
				pushNodeHere(if_node);
			} else {
				parent.tnodes!.push(if_node);
			}
			const lastIf = inner_tags_if[inner_tags_if.length - 1];
			cur_tnode = lastIf ?? null;
			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				tag_stack.push({ tag: tag.tagName, tnode: lastIf });
			}
		}

		function handleBElse(tag: StartTag, raw: string, b_a: Attr) {
			if (!cur_tnode) {
				errors.push(new BackflipError("b-else-if/b-else must follow a b-if block", attrErrorLoc(tag, b_a.name, filename)));
				const new_cur = pushRawHere(raw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}
			let if_node: IfTNode;
			const sc_else = getSlotCollection();
			try {
				if (sc_else) {
					const slotName = sc_else.currentSlot;
					const arr = sc_else.partialRef.slots[slotName] || [];
					if_node = findPrecedingIfInSlot(arr, attrErrorLoc(tag, b_a.name, filename));
				} else {
					if_node = findPrecedingIfInFile(cur_tnode, attrErrorLoc(tag, b_a.name, filename));
				}
			} catch (e) {
				if (e instanceof BackflipError) {
					errors.push(e);
					const new_cur = pushRawHere(raw);
					if (cur_tnode !== null) cur_tnode = new_cur;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName });
					}
					return;
				}
				throw e;
			}
			if (b_a.name === 'b-else' && b_a.value) {
				errors.push(new BackflipError("b-else should not have a value", attrErrorLoc(tag, 'b-else', filename)));
				// Still process as b-else (parsing state stays correct)
			}
			const condition = b_a.name === 'b-else-if' ? interpretBackcode(b_a.value) : undefined;
			const branch: IfBranch = { condition, tnodes: [], ifNode: if_node };
			branch.loc = attrLoc(tag, b_a.name);
			if_node.branches.push(branch);
			const inner_tags_else = makeOpenTagNode(tag, [b_a.name], branch);
			for (const n of inner_tags_else) branch.tnodes.push(n);
			const lastElse = inner_tags_else[inner_tags_else.length - 1];
			cur_tnode = lastElse ?? null;
			if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
				tag_stack.push({ tag: tag.tagName, tnode: lastElse });
			}
		}

		function handleRegularTag(tag: StartTag, raw: string) {
			const hasBindAttrs = tag.attrs.some(attr => isBindAttr(attr.name));
			const hasAssetAttrs = tag.attrs.some(attr => isAssetAttr(attr.name));
			if (hasBindAttrs || hasAssetAttrs) {
				const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;
				const nodes = makeOpenTagNode(tag, [], parent);
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

			// Custom element call site (no b-for/b-if on the same tag — wrap with <b-unwrap b-for=...> instead).
			// b-part precedence already won above; this slot only runs for plain custom element tags.
			if (isCustomElementTagName(tag.tagName)) {
				const hasFlowAttr = tag.attrs.some(a => a.name === 'b-for' || a.name === 'b-if' || a.name === 'b-else-if' || a.name === 'b-else');
				if (!hasFlowAttr) return handleCustomElementCall(tag, raw);
			}

			// --- b-for / b-if / b-else-if / b-else ---
			const b_as = tag.attrs.filter(attr => ['b-for', 'b-if', 'b-else-if', 'b-else'].includes(attr.name));
			if (b_as.length > 1) {
				errors.push(new BackflipError("more than one b-attr", errorLoc(filename, tagLoc(tag))));
				const new_cur = pushRawHere(raw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}

			if (b_as.length === 1) {
				const b_a = b_as[0];
				if (b_a.name === 'b-for') return handleBFor(tag, raw, b_a);
				if (b_a.name === 'b-if') return handleBIf(tag, raw, b_a);
				return handleBElse(tag, raw, b_a);
			}

			handleRegularTag(tag, raw);
		} catch(e) { if (e instanceof BackflipError) { errors.push(e); } else { reject(e); } } });

		rewriteStream.on('endTag', (tag, raw) => { try {
			const matchTag = tag_stack.pop();
			if (!matchTag) {
				errors.push(new BackflipError("popped the last tagMatcher prematurely", errorLoc(filename, tagLoc(tag))));
				if (cur_tnode !== null) cur_tnode = pushRaw(cur_tnode, raw);
				else if (currentPartialRoot !== null) pushRawHere(raw);
				return;
			}
			if (matchTag.tag !== tag.tagName) {
				errors.push(new BackflipError(`mismatched start/end tags: ${matchTag.tag} ${tag.tagName}`, errorLoc(filename, tagLoc(tag))));
				tag_stack.push(matchTag);
				if (cur_tnode !== null) cur_tnode = pushRaw(cur_tnode, raw);
				else if (currentPartialRoot !== null) pushRawHere(raw);
				return;
			}

			// If we just closed the partial's top-level element
			if (tag_stack.length === 0 && currentPartialRoot !== null) {
				// Custom element partials don't include the wrapping tag in the body —
				// the open and close tags are reconstructed at the call site.
				if (tag.tagName !== 'b-unwrap' && !currentPartialRoot.customElement) {
					pushRawHere(raw);
				}
				// Record end offset of the partial
				const endTagLoc = tag.sourceCodeLocation as { startOffset?: number } | null | undefined;
				currentPartialRoot.meta!.endOffset = (endTagLoc?.startOffset ?? 0) + raw.length;
				// End of this partial
				currentPartialRoot = null;
				currentPartialName = null;
				cur_tnode = null;
				return;
			}

			// If this was a slotCollection entry
			if (matchTag.slotCollection) {
				const tnode = matchTag.tnode;
				if (tnode && tnode.type === 'partial-ref') {
					// b-part closing - create a new raw node in partialRef's parent for subsequent content
					const parent = tnode.parent;
					const new_raw: RawTNode = { type: 'raw', raw: '', parent };
					parent.tnodes!.push(new_raw);
					cur_tnode = new_raw;
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
						const raw_node: RawTNode = { type: 'raw', raw, parent: sc.partialRef.parent };
						arr.push(raw_node);
					}
				}
				return;
			}

			// Regular closing
			if (matchTag.tnode) {
				// Close tag belongs to the structured node (b-for/b-if/b-slot), not the slot
				if (cur_tnode !== null && tag.tagName !== 'b-unwrap') {
					cur_tnode = pushRaw(cur_tnode, raw);
				}
			} else {
				const sc = getSlotCollection();
				if (sc) {
					pushRawHere(raw);
				} else if (cur_tnode !== null) {
					cur_tnode = pushRaw(cur_tnode, raw);
				}
			}

			if (matchTag.tnode) {
				if (!matchTag.tnode.parent) throw new BackflipError("expected a parent");
				const parent = matchTag.tnode.parent;
				if ('ifNode' in parent) {
					cur_tnode = (parent as IfBranch).ifNode as unknown as TNode;
				} else if (parent.type === 'root') {
					// RootTNode has no `.parent`, so cur_tnode can't point at it directly —
					// pushRaw on cur_tnode walks up via cur_tnode.parent. Anchor on the
					// just-closed node instead; subsequent pushRaw creates siblings inside
					// the root (since the closed node already lives in root.tnodes).
					cur_tnode = matchTag.tnode;
				} else {
					cur_tnode = parent as TNode;
				}
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
				const dummyParent = sc.partialRef.parent;

				const matches = raw.matchAll(cf_text_regex);
				let raw_it = 0;
				for (const m of matches) {
					if (m.index > raw_it) {
						const sub = raw.substring(raw_it, m.index);
						const last = arr.length > 0 ? arr[arr.length - 1] : null;
						if (last && last.type === 'raw') { (last as RawTNode).raw += sub; }
						else { arr.push({ type: 'raw', raw: sub, parent: dummyParent }); }
					}
					const code_str = m[0].substring(2, m[0].length - 2).trim();
					if (!code_str) {
						const last = arr.length > 0 ? arr[arr.length - 1] : null;
						if (last && last.type === 'raw') { (last as RawTNode).raw += m[0]; }
						else { arr.push({ type: 'raw', raw: m[0], parent: dummyParent }); }
						raw_it = m.index + m[0].length;
						continue;
					}
					const print_node: PrintTNode = { type: 'print', data: interpretBackcode(code_str), parent: dummyParent };
					if (textLoc) print_node.loc = interpolationLoc(textLoc, raw.substring(0, m.index), m[0]);
					arr.push(print_node);
					raw_it = m.index + m[0].length;
				}
				if (raw_it < raw.length) {
					const sub = raw.substring(raw_it);
					const last = arr.length > 0 ? arr[arr.length - 1] : null;
					if (last && last.type === 'raw') { (last as RawTNode).raw += sub; }
					else { arr.push({ type: 'raw', raw: sub, parent: dummyParent }); }
				}
			} else if (cur_tnode !== null) {
				cur_tnode = onText(cur_tnode, raw, textLoc);
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
			const isCustom = found.customElement === true;
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

