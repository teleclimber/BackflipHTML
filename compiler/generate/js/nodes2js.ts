import * as path from 'node:path';
import type { TNode, ForTNode, RootTNode, PrintTNode, RawTNode, CommentTNode, IfTNode, IfBranch, SlotTNode, PartialRefTNode, CustomElementCallTNode, PartialBinding, ElementTNode, AttrBindTNode, AttrPart, CompiledFile } from '../../types.js';
import type { Parsed } from '../../backcode.js';
import { generateFunction } from './generatejs.js';

export function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_$]/g, '_');
}

export function nodeToJsExport(n :TNode|RootTNode) :string {
	return `export const nodes = ${nodeToJS(n)};`;
}

export function nodeToJS(n :TNode|RootTNode, assetMap?: Map<string, string>) :string {
	let out = '';

	switch(n.type) {
		case 'root':
			out = rootToJS(n, assetMap);
			break;
		case 'for':
			out = forToJS(n, assetMap);
			break;
		case 'if':
			out = ifToJS(n, assetMap);
			break;
		case 'print':
			out = printToJS(n);
			break;
		case 'raw':
			out = rawToJS(n);
			break;
		case 'comment':
			out = commentToJS(n);
			break;
		case 'slot':
			out = slotToJS(n);
			break;
		case 'partial-ref':
			out = partialRefToJS(n, assetMap);
			break;
		case 'element':
			out = elementToJS(n, assetMap);
			break;
		case 'attr-bind':
			out = attrPartsToAttrsOnlyRNodeJS(n.attrs, assetMap);
			break;
		default:
			throw new Error("unhandled node type");
	}

	return out;
}

function rootToJS(n: RootTNode, assetMap?: Map<string, string>): string {
	const body = n.tnodes!.map(nn => nodeToJS(nn, assetMap)).join(',\n');
	if (n.kind === 'custom-element' && n.definitionAttrs && n.definitionAttrs.length > 0) {
		const defAttrs = attrPartsToAttrsOnlyRNodeJS(n.definitionAttrs, assetMap);
		return `{ type:"root", customElement: true, definitionAttrNodes: [\n${defAttrs}\n], nodes: [\n${body}\n] }`;
	}
	if (n.kind === 'custom-element') {
		return `{ type:"root", customElement: true, definitionAttrNodes: [], nodes: [\n${body}\n] }`;
	}
	return `{ type:"root", nodes: [\n${body}\n] }`;
}

function forToJS(for_node: ForTNode, assetMap?: Map<string, string>) :string {
	return `{ type:'for',
	iterable: ${backcodeToJS(for_node.iterable)},
	valName: '${for_node.valName}',
	nodes: [\n ${for_node.tnodes?.map( n => nodeToJS(n, assetMap)).join(',\n')} ]
}`;
}

function ifToJS(if_node: IfTNode, assetMap?: Map<string, string>) :string {
	const branches = if_node.branches.map(b => branchToJS(b, assetMap)).join(',\n');
	return `{ type:'if',
	branches: [\n ${branches} ]
}`;
}

function branchToJS(branch: IfBranch, assetMap?: Map<string, string>) :string {
	const condition = branch.condition ? backcodeToJS(branch.condition) : 'undefined';
	return `{ condition: ${condition},
	nodes: [\n ${branch.tnodes.map(n => nodeToJS(n, assetMap)).join(',\n')} ]
}`;
}

function rawToJS(n :RawTNode) :string {
	const escaped = n.raw
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n');
	return `{ type: 'raw', raw: '${escaped}' }`;
}

function commentToJS(n: CommentTNode) :string {
	return `{ type: 'comment', text: '${escapeStr(n.text)}' }`;
}

function printToJS(print_node: PrintTNode) :string {
	return `{ type:'print', data: ${backcodeToJS(print_node.data)} }`;
}

function slotToJS(n: SlotTNode) :string {
	const name = n.name === undefined ? 'undefined' : `'${n.name}'`;
	return `{ type: 'slot', name: ${name} }`;
}

function bindingToJS(b: PartialBinding): string {
	const parts: string[] = [`name: '${escapeStr(b.name)}'`];
	if (b.kind === 'expr') {
		parts.push(`data: ${backcodeToJS(b.data)}`);
		if (b.cast !== undefined) parts.push(`cast: '${b.cast}'`);
	} else {
		if (typeof b.value === 'boolean') {
			parts.push(`literal: ${b.value ? 'true' : 'false'}`);
		} else {
			parts.push(`literal: '${escapeStr(b.value)}'`);
		}
	}
	return `{ ${parts.join(', ')} }`;
}

function partialRefToJS(n: PartialRefTNode, assetMap?: Map<string, string>) :string {
	if (n.kind === 'custom-element') {
		return customElementRefToJS(n, assetMap);
	}

	const partialIdent = n.file === null
		? sanitizeName(n.partialName)
		: importAliasFor(n.file, n.partialName);

	const slots = Object.entries(n.slots)
		.map(([name, tnodes]) => `'${name}': [\n${tnodes.map(t => nodeToJS(t, assetMap)).join(',\n')}\n]`)
		.join(',\n');

	const bindings = n.bindings.map(bindingToJS).join(',\n');

	return `{ type: 'partial-ref',
	partial: ${partialIdent},
	slots: { ${slots} },
	bindings: [ ${bindings} ]
}`;
}

function customElementRefToJS(n: CustomElementCallTNode, assetMap?: Map<string, string>): string {
	const tagName = n.callerTagName ?? n.partialName;
	const callerAttrsExpr = (n.callerAttrs && n.callerAttrs.length > 0)
		? attrPartsToAttrsOnlyRNodeJS(n.callerAttrs, assetMap)
		: '';
	const slots = Object.entries(n.slots)
		.map(([name, tnodes]) => `'${name}': [\n${tnodes.map(t => nodeToJS(t, assetMap)).join(',\n')}\n]`)
		.join(',\n');
	const bindings = n.bindings.map(bindingToJS).join(',\n');

	if (n.file === '__unresolved_custom_element__') {
		// Fallback: render as raw HTML — no partial reference, slots in caller ctx.
		return `{ type: 'partial-ref',
	customElement: true,
	unresolved: true,
	callerTagName: '${escapeStr(tagName)}',
	callerOpenTag: [${callerAttrsExpr}],
	slots: { ${slots} },
	bindings: [ ${bindings} ]
}`;
	}

	const partialIdent = n.file === null
		? sanitizeName(n.partialName)
		: importAliasFor(n.file, n.partialName);

	return `{ type: 'partial-ref',
	customElement: true,
	partial: ${partialIdent},
	callerTagName: '${escapeStr(tagName)}',
	callerOpenTag: [${callerAttrsExpr}],
	slots: { ${slots} },
	bindings: [ ${bindings} ]
}`;
}

// Emit an ElementTNode as a comma-separated sequence of RNode expressions that the
// caller splices into its parent array literal. The element renders as:
//   <openTag>[body RNodes]</closeTag>   (close omitted for void / selfClosing)
// If the open tag has no dynamic attrs, all static parts collapse into a single rawRNode;
// otherwise an attrBindRNode renders the open tag dynamically at runtime.
function elementToJS(n: ElementTNode, assetMap?: Map<string, string>): string {
	const parts: string[] = [];
	parts.push(openTagRNodeJS(n, assetMap));
	for (const child of n.tnodes) {
		parts.push(nodeToJS(child, assetMap));
	}
	if (!n.isVoid && !n.selfClosing) {
		parts.push(`{ type: 'raw', raw: '${escapeStr(`</${n.tagName}>`)}' }`);
	}
	return parts.join(',\n');
}

function openTagRNodeJS(n: ElementTNode, assetMap?: Map<string, string>): string {
	if (n.attrs.some(p => p.type === 'asset')) {
		throw new Error("unresolved asset AttrPart — call resolveAssetRefs() before code generation");
	}
	const hasDynamic = n.attrs.some(p => p.type === 'dynamic');
	const openCloser = n.selfClosing ? ' />' : '>';
	if (!hasDynamic) {
		let raw = `<${n.tagName}`;
		for (const p of n.attrs) {
			if (p.type === 'static') raw += p.raw;
		}
		raw += openCloser;
		return `{ type: 'raw', raw: '${escapeStr(raw)}' }`;
	}
	const hasAsset = n.attrs.some(p => p.type === 'dynamic' && p.isAsset);
	const partsExpr = n.attrs.map(p =>
		p.type === 'static'
			? `{ type: 'static', raw: '${escapeStr(p.raw)}' }`
			: p.type === 'dynamic'
				? `{ type: 'dynamic', name: '${p.name}', expr: ${backcodeToJS(p.expr)}, isBoolean: ${p.isBoolean}${p.isAsset ? ', isAsset: true' : ''} }`
				: `/* unreachable: resolved asset */`
	).join(',\n');
	let assetMapStr = '';
	if (hasAsset && assetMap && assetMap.size > 0) {
		const entries = Array.from(assetMap).map(([k, v]) => `'${escapeStr(k)}': '${escapeStr(v)}'`).join(', ');
		assetMapStr = `, assetMap: { ${entries} }`;
	}
	const selfClosingStr = n.selfClosing ? ', selfClosing: true' : '';
	return `{ type: 'attr-bind', tagOpen: '<${n.tagName}'${assetMapStr}${selfClosingStr}, parts: [\n${partsExpr}\n] }`;
}

// Build a single RNode expression (either rawRNode or attrBindRNode with attrsOnly:true)
// representing an AttrPart[] rendered into a tag's open-tag attribute slot. Used for
// custom-element callerAttrs and definitionAttrs (which the runtime merges into one tag).
function attrPartsToAttrsOnlyRNodeJS(parts: AttrPart[], assetMap?: Map<string, string>): string {
	if (parts.some(p => p.type === 'asset')) {
		throw new Error("unresolved asset AttrPart — call resolveAssetRefs() before code generation");
	}
	const hasDynamic = parts.some(p => p.type === 'dynamic');
	if (!hasDynamic) {
		let raw = '';
		for (const p of parts) {
			if (p.type === 'static') raw += p.raw;
		}
		return `{ type: 'raw', raw: '${escapeStr(raw)}' }`;
	}
	const hasAsset = parts.some(p => p.type === 'dynamic' && p.isAsset);
	const partsExpr = parts.map(p =>
		p.type === 'static'
			? `{ type: 'static', raw: '${escapeStr(p.raw)}' }`
			: p.type === 'dynamic'
				? `{ type: 'dynamic', name: '${p.name}', expr: ${backcodeToJS(p.expr)}, isBoolean: ${p.isBoolean}${p.isAsset ? ', isAsset: true' : ''} }`
				: `/* unreachable: resolved asset */`
	).join(',\n');
	let assetMapStr = '';
	if (hasAsset && assetMap && assetMap.size > 0) {
		const entries = Array.from(assetMap).map(([k, v]) => `'${escapeStr(k)}': '${escapeStr(v)}'`).join(', ');
		assetMapStr = `, assetMap: { ${entries} }`;
	}
	return `{ type: 'attr-bind', tagOpen: ''${assetMapStr}, attrsOnly: true, parts: [\n${partsExpr}\n] }`;
}

function escapeStr(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function importAliasFor(file: string, partialName: string): string {
	return sanitizeName(file.replace(/\.html$/, '')) + '__' + sanitizeName(partialName);
}

export function backcodeToJS(c :Parsed) :string {
	const fn = generateFunction('', c);
	const vars = `[${c.vars.map(v => "'"+v+"'").join(', ')}]`;
	return `{ fn: ${fn}, vars: ${vars} }`;
}

// Collect all PartialRefTNodes in a tree (depth-first)
function collectPartialRefs(root: RootTNode): PartialRefTNode[] {
	const refs: PartialRefTNode[] = [];
	function walk(nodes: TNode[]) {
		for (const n of nodes) {
			if (n.type === 'partial-ref') {
				refs.push(n);
				for (const slotNodes of Object.values(n.slots)) walk(slotNodes);
			} else if (n.type === 'for') {
				walk(n.tnodes);
			} else if (n.type === 'if') {
				for (const b of n.branches) walk(b.tnodes);
			} else if (n.type === 'element') {
				walk(n.tnodes);
			}
		}
	}
	walk(root.tnodes);
	return refs;
}

// Topologically sort partials so same-file deps come before dependents
function topoSortPartials(partials: Map<string, RootTNode>): string[] {
	const names = Array.from(partials.keys());
	const visited = new Set<string>();
	const sorted: string[] = [];

	function visit(name: string) {
		if (visited.has(name)) return;
		visited.add(name);
		const root = partials.get(name)!;
		const refs = collectPartialRefs(root);
		for (const ref of refs) {
			if (ref.file === null && partials.has(ref.partialName)) {
				visit(ref.partialName);
			}
		}
		sorted.push(name);
	}

	for (const name of names) visit(name);
	return sorted;
}

const UNRESOLVED_CE = '__unresolved_custom_element__';

export function fileToJsModule(file: CompiledFile, filePath: string, assetMap?: Map<string, string>): string {
	const currentJs = filePath.replace(/\.html$/, '.js');

	// Collect all cross-file refs across all partials in this file
	const crossFileRefs = new Map<string, Set<string>>();  // file → set of partial names
	for (const root of file.partials.values()) {
		for (const ref of collectPartialRefs(root)) {
			if (ref.file !== null && ref.file !== UNRESOLVED_CE) {
				if (!crossFileRefs.has(ref.file)) crossFileRefs.set(ref.file, new Set());
				crossFileRefs.get(ref.file)!.add(ref.partialName);
			}
		}
	}

	// Build import statements
	const imports: string[] = [];
	for (const [refFile, partialNames] of crossFileRefs) {
		const refJs = refFile.replace(/\.html$/, '.js');
		let relPath = path.relative(path.dirname(currentJs), refJs);
		if (!relPath.startsWith('.')) relPath = './' + relPath;
		const aliases = Array.from(partialNames)
			.map(name => `${sanitizeName(name)} as ${importAliasFor(refFile, name)}`);
		imports.push(`import { ${aliases.join(', ')} } from '${relPath}';`);
	}

	// Topologically sort partials and emit exports
	const sorted = topoSortPartials(file.partials);
	const exports: string[] = [];
	for (const name of sorted) {
		const root = file.partials.get(name)!;
		exports.push(`export const ${sanitizeName(name)} = ${nodeToJS(root, assetMap)};`);
	}

	return [...imports, '', ...exports].join('\n');
}
