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

export type TNode = RawTNode | PrintTNode | ForTNode | IfTNode;
export type ParentTNode = RootTNode | ForTNode | IfBranch;

type TagMatcher = {
	tag: string,
	tnode?: TNode
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