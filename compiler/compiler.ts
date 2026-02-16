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

export type TNode = RawTNode | PrintTNode | ForTNode;
export type ParentTNode = RootTNode | ForTNode;

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

		rewriteStream.on('startTag', (tag, raw) => { try {
			const b_as = tag.attrs.filter((attr) => b_attrs.includes(attr.name));
			if( b_as.length >1 ) throw new Error("more than one b-attr");
			if( b_as.length === 1 ) {
				const b_a = b_as[0];
				if( b_a.name === 'b-for' ) {
					// close current tnode.
					// create a for node.
					// create a raw node as part of child with rendered tag without b-for.
					// make that the current node.

					// make a node from the tag
					let tag_str = `<${tag.tagName}`;
					const other_attrs = tag.attrs.filter( (attr) => attr.name !== 'b-for').map( attr => `${attr.name}="${attr.value}"` ).join(' ');
					if( other_attrs ) tag_str += ' ' + other_attrs;
					tag_str += '>';
					// TODO figure ot how to deal with variable attributes! :abc="" and abc="{{}}" or whatever
					
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

					if( !tag.selfClosing && !void_elements.has(tag.tagName) ) {	// if self-closing or void we skip
						tag_stack.push({
							tag: tag.tagName,
							tnode: inner_tag
						});	// actually push the directive node we create.
					}
				}
				else {
					throw new Error("not implemented yet: " + b_a.name);
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
				cur_tnode = matchTag.tnode.parent as TNode;
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