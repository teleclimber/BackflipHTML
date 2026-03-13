import {RewritingStream} from 'npm:parse5-html-rewriting-stream';
import stream from 'node:stream';

import { interpretBackcode } from './backcode.ts';
import type { Parsed } from './backcode.ts';

export interface ChildTNode {
	parent: ParentTNode
}
export interface RootTNode {
	type: 'root',
	tnodes: TNode[]
}
export interface RawTNode extends ChildTNode {
	type: 'raw',
	raw: string
}
export interface PrintTNode extends ChildTNode {	// for outputing {{ foo }} into HTML (do escaping)
	type: 'print',
	data: Parsed,
}
export interface ForTNode extends ChildTNode {
	type: 'for',
	iterable: Parsed,
	valName: string,
	tnodes: TNode[]
}
export interface IfBranch {
	condition?: Parsed,
	tnodes: TNode[],
	ifNode: IfTNode
}
export interface IfTNode extends ChildTNode {
	type: 'if',
	branches: IfBranch[]
}

export interface SlotTNode extends ChildTNode {
	type: 'slot',
	name: string | undefined   // undefined = default slot
}
export interface PartialBinding {
	name: string,
	data: Parsed
}
export interface PartialRefTNode extends ChildTNode {
	type: 'partial-ref',
	file: string | null,        // null = same-file reference (b-part="#name")
	partialName: string,
	wrapper: { open: string, close: string } | null,  // null if <b-unwrap b-part>
	slots: { [slotName: string]: TNode[] },            // 'default' for unnamed
	bindings: PartialBinding[]
}

export interface CompiledFile {
	partials: Map<string, RootTNode>  // partialName → compiled tree
}

export type PartialRegistry = Map<string, Set<string>>
// key: relative file path e.g. "graphics/charts.html"
// value: set of exported partial names in that file

export type TNode = RawTNode | PrintTNode | ForTNode | IfTNode | SlotTNode | PartialRefTNode;
export type ParentTNode = RootTNode | ForTNode | IfBranch;

type TagMatcher = {
	tag: string,
	tnode?: TNode,
	slotCollection?: {
		partialRef: PartialRefTNode,
		currentSlot: string   // 'default' or named
	}
}

export function generateStringStack(in_str:string) :Promise<RootTNode> {

	return new Promise( (resolve, reject) => {

		const s = new stream.Readable({encoding: 'utf8'});
		s.push(in_str);
		s.push(null);

		const tag_stack :TagMatcher[] = [];	// stack of tags so we can find matching close tag.
	// to knwow when we reach the matching closing element
	// ..we have to stack every element we encounter

		const root_node :RootTNode = { type: 'root', tnodes: [] };
		let cur_tnode :TNode = { type: 'raw', raw: '', parent: root_node };
		root_node.tnodes.push(cur_tnode);

		const rewriteStream = new RewritingStream();

		const void_elements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

		const b_attrs = ['b-for', 'b-if', 'b-else-if', 'b-else'];

		function reconstructTag(tag: {tagName:string, attrs:{name:string,value:string}[]}, excludeAttr: string) :string {
			let tag_str = `<${tag.tagName}`;
			const other_attrs = tag.attrs.filter( (attr) => attr.name !== excludeAttr).map( attr => `${attr.name}="${attr.value}"` ).join(' ');
			if( other_attrs ) tag_str += ' ' + other_attrs;
			tag_str += '>';
			return tag_str;
		}

		function findPrecedingIf(cur: TNode) :IfTNode {
			if( cur.type === 'if' ) return cur;
			// Check if the preceding sibling in the parent's tnodes is an IfTNode
			if( cur.parent && 'tnodes' in cur.parent ) {
				const siblings = cur.parent.tnodes;
				for( let i = siblings.length - 1; i >= 0; i-- ) {
					if( siblings[i].type === 'if' ) return siblings[i] as IfTNode;
					// Only skip past whitespace-only raw nodes
					if( siblings[i].type === 'raw' && (siblings[i] as RawTNode).raw.trim() === '' ) continue;
					break;
				}
			}
			throw new Error("b-else-if/b-else must follow a b-if block");
		}

		rewriteStream.on('startTag', (tag, raw) => { try {
			const b_as = tag.attrs.filter((attr) => b_attrs.includes(attr.name));
			if( b_as.length >1 ) throw new Error("more than one b-attr");
			if( b_as.length === 1 ) {
				const b_a = b_as[0];
				if( b_a.name === 'b-for' ) {
					const tag_str = reconstructTag(tag, 'b-for');

					const pieces = b_a.value.split(" in ");
					if( pieces.length !== 2 ) throw new Error(`b-for value must be in the form "item in items", got: "${b_a.value}"`);
					const iterable_str = pieces[1].trim();
					const iterable_parsed = interpretBackcode(iterable_str);
					const value_name = pieces[0].trim();
					if( !value_name ) throw new Error(`got bad iter value name: ${value_name}`);

					const for_node :ForTNode = {
						type:'for',
						iterable: iterable_parsed,
						valName: value_name,
						tnodes: [],
						parent: cur_tnode.parent
					};
					const inner_tag:RawTNode = {
						type: 'raw',
						raw: tag_str,
						parent: for_node
					}
					for_node.tnodes.push(inner_tag);

					if( !cur_tnode.parent?.tnodes ) throw new Error("expected tnodes here");
					cur_tnode.parent.tnodes.push(for_node);
					cur_tnode = inner_tag;

					if( !tag.selfClosing && !void_elements.has(tag.tagName) ) {
						tag_stack.push({
							tag: tag.tagName,
							tnode: inner_tag
						});
					}
				}
				else if( b_a.name === 'b-if' ) {
					const tag_str = reconstructTag(tag, 'b-if');
					const condition = interpretBackcode(b_a.value);

					const if_node :IfTNode = {
						type: 'if',
						branches: [],
						parent: cur_tnode.parent
					};
					const branch :IfBranch = {
						condition,
						tnodes: [],
						ifNode: if_node
					};
					if_node.branches.push(branch);

					const inner_tag :RawTNode = {
						type: 'raw',
						raw: tag_str,
						parent: branch
					};
					branch.tnodes.push(inner_tag);

					if( !cur_tnode.parent?.tnodes ) throw new Error("expected tnodes here");
					cur_tnode.parent.tnodes.push(if_node);
					cur_tnode = inner_tag;

					if( !tag.selfClosing && !void_elements.has(tag.tagName) ) {
						tag_stack.push({
							tag: tag.tagName,
							tnode: inner_tag
						});
					}
				}
				else if( b_a.name === 'b-else-if' || b_a.name === 'b-else' ) {
					const if_node = findPrecedingIf(cur_tnode);

					if( b_a.name === 'b-else' && b_a.value ) throw new Error("b-else should not have a value");

					const condition = b_a.name === 'b-else-if' ? interpretBackcode(b_a.value) : undefined;
					const tag_str = reconstructTag(tag, b_a.name);

					const branch :IfBranch = {
						condition,
						tnodes: [],
						ifNode: if_node
					};
					if_node.branches.push(branch);

					const inner_tag :RawTNode = {
						type: 'raw',
						raw: tag_str,
						parent: branch
					};
					branch.tnodes.push(inner_tag);

					cur_tnode = inner_tag;

					if( !tag.selfClosing && !void_elements.has(tag.tagName) ) {
						tag_stack.push({
							tag: tag.tagName,
							tnode: inner_tag
						});
					}
				}
			}
			else {
				// TODO also check if there are variable attributes
				// append raw onto current node.
				// OR check if current node is raw first
				// if not close then create new raw node.
				cur_tnode = pushRaw(cur_tnode, raw);
				if( !tag.selfClosing && !void_elements.has(tag.tagName) ) {
					tag_stack.push({tag: tag.tagName});
				}
			}
		} catch(e) { reject(e); } });
		rewriteStream.on('endTag', (tag, raw) => { try {
			const matchTag = tag_stack.pop();
			if( !matchTag ) throw new Error("popped the last tagMatcher prematurely");
			if( matchTag.tag !== tag.tagName ) throw new Error(`mismatched start/end tags: ${matchTag.tag} ${tag.tagName} `);

			cur_tnode = pushRaw(cur_tnode, raw);

			// if there is a TNode, that means we are at the end of this subtree.
			if( matchTag.tnode ) {
				if( !matchTag.tnode.parent ) throw new Error("expected a parent");
				const parent = matchTag.tnode.parent;
				if( 'ifNode' in parent ) {
					cur_tnode = (parent as IfBranch).ifNode;  // IfBranch → IfTNode
				} else {
					cur_tnode = parent as TNode;
				}
			}
		} catch(e) { reject(e); } });

		rewriteStream.on('text', (_, raw:string) => { try {
			cur_tnode = onText(cur_tnode, raw);
		} catch(e) { reject(e); } } );

		s.pipe(rewriteStream);

		s.on('error', (err) => {
			reject(err);
		});
		rewriteStream.on('error', (err) => {
			reject(err);
		});
		rewriteStream.on('end', () => {
			resolve(root_node);
		});
	});
}


export function compileFile(html: string, _registry?: PartialRegistry): Promise<CompiledFile> {

	return new Promise((resolve, reject) => {

		const s = new stream.Readable({encoding: 'utf8'});
		s.push(html);
		s.push(null);

		const tag_stack: TagMatcher[] = [];

		const compiledFile: CompiledFile = { partials: new Map() };

		// current partial being compiled (null = top-level, outside any b-name partial)
		let currentPartialRoot: RootTNode | null = null;
		let cur_tnode: TNode | null = null;

		// Helper: get current slot-collection context from innermost tag_stack entry
		function getSlotCollection(): { partialRef: PartialRefTNode, currentSlot: string } | null {
			for (let i = tag_stack.length - 1; i >= 0; i--) {
				if (tag_stack[i].slotCollection) {
					return tag_stack[i].slotCollection!;
				}
				break;
			}
			return null;
		}

		// Helper: push a raw string into the right place (slot or normal)
		function pushRawHere(raw: string): TNode {
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
					const raw_node: RawTNode = { type: 'raw', raw, parent: currentPartialRoot! };
					currentPartialRoot!.tnodes.push(raw_node);
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

		// Helper: reconstruct tag string excluding certain attrs and all b-data: attrs
		function reconstructTagExcluding(tag: {tagName:string, attrs:{name:string,value:string}[]}, excludeAttrs: string[]): string {
			let tag_str = `<${tag.tagName}`;
			const other_attrs = tag.attrs
				.filter(attr => !excludeAttrs.includes(attr.name) && !attr.name.startsWith('b-data:'))
				.map(attr => `${attr.name}="${attr.value}"`)
				.join(' ');
			if (other_attrs) tag_str += ' ' + other_attrs;
			tag_str += '>';
			return tag_str;
		}

		function findPrecedingIfInFile(cur: TNode): IfTNode {
			if (cur.type === 'if') return cur;
			if (cur.parent && 'tnodes' in cur.parent) {
				const siblings = cur.parent.tnodes;
				for (let i = siblings.length - 1; i >= 0; i--) {
					if (siblings[i].type === 'if') return siblings[i] as IfTNode;
					if (siblings[i].type === 'raw' && (siblings[i] as RawTNode).raw.trim() === '') continue;
					break;
				}
			}
			throw new Error("b-else-if/b-else must follow a b-if block");
		}

		const void_elements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

		const rewriteStream = new RewritingStream();

		rewriteStream.on('startTag', (tag, raw) => { try {

			// --- b-name ---
			const bNameAttr = tag.attrs.find(a => a.name === 'b-name');
			if (bNameAttr !== undefined) {
				if (tag_stack.length > 0) throw new Error("b-name is only allowed on top-level elements");

				const partialName = bNameAttr.value;
				const partialRoot: RootTNode = { type: 'root', tnodes: [] };
				compiledFile.partials.set(partialName, partialRoot);

				currentPartialRoot = partialRoot;

				if (tag.tagName === 'b-unwrap') {
					// Don't emit opening tag; just track for closing
					const init_raw: RawTNode = { type: 'raw', raw: '', parent: partialRoot };
					partialRoot.tnodes.push(init_raw);
					cur_tnode = init_raw;
					if (!tag.selfClosing) {
						tag_stack.push({ tag: tag.tagName });
					}
				} else {
					const tag_str = reconstructTagExcluding(tag, ['b-name', 'b-export']);
					const init_raw: RawTNode = { type: 'raw', raw: tag_str, parent: partialRoot };
					partialRoot.tnodes.push(init_raw);
					cur_tnode = init_raw;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName });
					}
				}
				return;
			}

			// --- b-part ---
			const bPartAttr = tag.attrs.find(a => a.name === 'b-part');
			if (bPartAttr !== undefined) {
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
						bindings.push({ name: bindingName, data: interpretBackcode(attr.value) });
					}
				}

				let wrapper: { open: string, close: string } | null;
				if (tag.tagName === 'b-unwrap') {
					wrapper = null;
				} else {
					const open = reconstructTagExcluding(tag, ['b-part']);
					wrapper = { open, close: `</${tag.tagName}>` };
				}

				const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;

				const partialRef: PartialRefTNode = {
					type: 'partial-ref',
					file,
					partialName,
					wrapper,
					slots: { 'default': [] },
					bindings,
					parent
				};

				pushNodeHere(partialRef);
				// After pushing, update cur_tnode so subsequent siblings work
				// We use a placeholder raw node in the same parent for after the partial-ref closes
				// But during slot collection, cur_tnode isn't used

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
				return;
			}

			// --- b-slot ---
			const bSlotAttr = tag.attrs.find(a => a.name === 'b-slot');
			if (bSlotAttr !== undefined) {
				const slotName = bSlotAttr.value !== '' ? bSlotAttr.value : undefined;
				const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;

				const slot_node: SlotTNode = { type: 'slot', name: slotName, parent };

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
				return;
			}

			// --- b-in inside slot-collection context ---
			const bInAttr = tag.attrs.find(a => a.name === 'b-in');
			if (bInAttr !== undefined && tag.tagName === 'b-unwrap') {
				const innermost = getSlotCollection();
				if (innermost) {
					const slotName = bInAttr.value || 'default';
					if (!innermost.partialRef.slots[slotName]) {
						innermost.partialRef.slots[slotName] = [];
					}
					tag_stack.push({
						tag: tag.tagName,
						slotCollection: {
							partialRef: innermost.partialRef,
							currentSlot: slotName
						}
					});
					return;
				}
			}

			// Skip everything outside a partial
			if (cur_tnode === null && currentPartialRoot === null) {
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}

			// --- standard b-for / b-if / b-else-if / b-else ---
			const b_as = tag.attrs.filter(attr => ['b-for', 'b-if', 'b-else-if', 'b-else'].includes(attr.name));
			if (b_as.length > 1) throw new Error("more than one b-attr");

			if (b_as.length === 1) {
				const b_a = b_as[0];
				if (b_a.name === 'b-for') {
					const tag_str = reconstructTagExcluding(tag, ['b-for']);
					const pieces = b_a.value.split(" in ");
					if (pieces.length !== 2) throw new Error(`b-for value must be in the form "item in items", got: "${b_a.value}"`);
					const iterable_parsed = interpretBackcode(pieces[1].trim());
					const value_name = pieces[0].trim();
					if (!value_name) throw new Error(`got bad iter value name: ${value_name}`);

					const parent = cur_tnode ? cur_tnode.parent : currentPartialRoot!;
					const for_node: ForTNode = { type: 'for', iterable: iterable_parsed, valName: value_name, tnodes: [], parent };
					const inner_tag: RawTNode = { type: 'raw', raw: tag_str, parent: for_node };
					for_node.tnodes.push(inner_tag);
					parent.tnodes!.push(for_node);
					cur_tnode = inner_tag;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName, tnode: inner_tag });
					}
				}
				else if (b_a.name === 'b-if') {
					const tag_str = reconstructTagExcluding(tag, ['b-if']);
					const parent = cur_tnode ? cur_tnode.parent : currentPartialRoot!;
					const if_node: IfTNode = { type: 'if', branches: [], parent };
					const branch: IfBranch = { condition: interpretBackcode(b_a.value), tnodes: [], ifNode: if_node };
					if_node.branches.push(branch);
					const inner_tag: RawTNode = { type: 'raw', raw: tag_str, parent: branch };
					branch.tnodes.push(inner_tag);
					parent.tnodes!.push(if_node);
					cur_tnode = inner_tag;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName, tnode: inner_tag });
					}
				}
				else if (b_a.name === 'b-else-if' || b_a.name === 'b-else') {
					if (!cur_tnode) throw new Error("b-else-if/b-else must follow a b-if block");
					const if_node = findPrecedingIfInFile(cur_tnode);
					if (b_a.name === 'b-else' && b_a.value) throw new Error("b-else should not have a value");
					const condition = b_a.name === 'b-else-if' ? interpretBackcode(b_a.value) : undefined;
					const tag_str = reconstructTagExcluding(tag, [b_a.name]);
					const branch: IfBranch = { condition, tnodes: [], ifNode: if_node };
					if_node.branches.push(branch);
					const inner_tag: RawTNode = { type: 'raw', raw: tag_str, parent: branch };
					branch.tnodes.push(inner_tag);
					cur_tnode = inner_tag;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName, tnode: inner_tag });
					}
				}
			}
			else {
				// Regular tag
				const new_cur = pushRawHere(raw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
			}
		} catch(e) { reject(e); } });

		rewriteStream.on('endTag', (tag, raw) => { try {
			const matchTag = tag_stack.pop();
			if (!matchTag) throw new Error("popped the last tagMatcher prematurely");
			if (matchTag.tag !== tag.tagName) throw new Error(`mismatched start/end tags: ${matchTag.tag} ${tag.tagName}`);

			// If we just closed the partial's top-level element
			if (tag_stack.length === 0 && currentPartialRoot !== null) {
				if (tag.tagName !== 'b-unwrap') {
					pushRawHere(raw);
				}
				// End of this partial
				currentPartialRoot = null;
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
				// b-in closing - outer slotCollection is still in tag_stack, nothing to do
				return;
			}

			// Regular closing
			const sc = getSlotCollection();
			if (sc) {
				pushRawHere(raw);
			} else if (cur_tnode !== null) {
				cur_tnode = pushRaw(cur_tnode, raw);
			}

			if (matchTag.tnode) {
				if (!matchTag.tnode.parent) throw new Error("expected a parent");
				const parent = matchTag.tnode.parent;
				if ('ifNode' in parent) {
					cur_tnode = (parent as IfBranch).ifNode as unknown as TNode;
				} else {
					cur_tnode = parent as TNode;
				}
			}
		} catch(e) { reject(e); } });

		rewriteStream.on('text', (_, raw: string) => { try {
			if (cur_tnode === null && currentPartialRoot === null) return; // outside any partial

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
					arr.push({ type: 'print', data: interpretBackcode(code_str), parent: dummyParent });
					raw_it = m.index + m[0].length;
				}
				if (raw_it < raw.length) {
					const sub = raw.substring(raw_it);
					const last = arr.length > 0 ? arr[arr.length - 1] : null;
					if (last && last.type === 'raw') { (last as RawTNode).raw += sub; }
					else { arr.push({ type: 'raw', raw: sub, parent: dummyParent }); }
				}
			} else if (cur_tnode !== null) {
				cur_tnode = onText(cur_tnode, raw);
			}
		} catch(e) { reject(e); } });

		s.pipe(rewriteStream);
		s.on('error', (err) => { reject(err); });
		rewriteStream.on('error', (err) => { reject(err); });
		rewriteStream.on('end', () => { resolve(compiledFile); });
	});
}

const cf_text_regex = new RegExp("({{[^{}]*}})", 'g');

const text_regex = new RegExp("({{[^{}]*}})", 'g');
export function onText(cur:TNode, raw :string) :TNode {
	// later match string against {{ }}
	const matches = raw.matchAll(text_regex);
	
	let raw_it = 0;
	for( const m of matches ) {
		if( m.index > raw_it ) {
			cur = pushRaw(cur, raw.substring(raw_it, m.index));
		}
		const code_str = m[0].substring(2, m[0].length -2).trim();
		if( !code_str ) {
			// empty {{ }}, treat as raw text
			cur = pushRaw(cur, m[0]);
			raw_it = m.index + m[0].length;
			continue;
		}
		const code_parsed = interpretBackcode(code_str);

		const print_node :TNode = {
			type: 'print',
			data: code_parsed,
			//func: new Function(`return ${code_str};`),
			parent: cur.parent
		};
		if( !cur.parent?.tnodes ) throw new Error("expected tnodes here");
		cur.parent.tnodes.push(print_node);
		cur = print_node;
		
		raw_it = m.index + m[0].length;
	}

	if( raw_it < raw.length ) {
		cur = pushRaw(cur, raw.substring(raw_it, raw.length));
	}

	return cur;
}

export function pushRaw(cur_tnode: TNode, raw :string) :TNode {
	if( cur_tnode.type === 'raw' ) {
		cur_tnode.raw += raw
	}
	else {
		const raw_node :TNode = {
			type: 'raw',
			raw: raw,
			parent: cur_tnode.parent
		};
		if( !cur_tnode.parent?.tnodes ) throw new Error("expected tnodes here");
		cur_tnode.parent.tnodes.push(raw_node);
		cur_tnode = raw_node;
	}
	return cur_tnode;
}