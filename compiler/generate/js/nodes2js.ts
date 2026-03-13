import * as path from 'node:path';
import type { TNode, ForTNode, RootTNode, PrintTNode, RawTNode, IfTNode, IfBranch, SlotTNode, PartialRefTNode, PartialBinding, CompiledFile } from '../../compiler.ts';
import type { Parsed } from '../../backcode.ts';
import { generateFunction } from './generatejs.ts';

export function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_$]/g, '_');
}

export function nodeToJsExport(n :TNode|RootTNode) :string {
	return `export const nodes = ${nodeToJS(n)};`;
}

export function nodeToJS(n :TNode|RootTNode) :string {
	let out = '';

	switch(n.type) {
		case 'root':
			out = '{ type:"root", nodes: [\n'+ n.tnodes!.map( (nn) => nodeToJS(nn) ).join(',\n') + '] }';
			break;
		case 'for':
			out = forToJS(n);
			break;
		case 'if':
			out = ifToJS(n);
			break;
		case 'print':
			out = printToJS(n);
			break;
		case 'raw':
			out = rawToJS(n);
			break;
		case 'slot':
			out = slotToJS(n);
			break;
		case 'partial-ref':
			out = partialRefToJS(n);
			break;
		default:
			throw new Error("unhandled node type");
	}

	return out;
}

function forToJS(for_node: ForTNode) :string {
	return `{ type:'for',
	iterable: ${backcodeToJS(for_node.iterable)},
	valName: '${for_node.valName}',
	nodes: [\n ${for_node.tnodes?.map( n => nodeToJS(n)).join(',\n')} ]
}`;
}

function ifToJS(if_node: IfTNode) :string {
	const branches = if_node.branches.map(b => branchToJS(b)).join(',\n');
	return `{ type:'if',
	branches: [\n ${branches} ]
}`;
}

function branchToJS(branch: IfBranch) :string {
	const condition = branch.condition ? backcodeToJS(branch.condition) : 'undefined';
	return `{ condition: ${condition},
	nodes: [\n ${branch.tnodes.map(n => nodeToJS(n)).join(',\n')} ]
}`;
}

function rawToJS(n :RawTNode) :string {
	const escaped = n.raw
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n');
	return `{ type: 'raw', raw: '${escaped}' }`;
}

function printToJS(print_node: PrintTNode) :string {
	return `{ type:'print', data: ${backcodeToJS(print_node.data)} }`;
}

function slotToJS(n: SlotTNode) :string {
	const name = n.name === undefined ? 'undefined' : `'${n.name}'`;
	return `{ type: 'slot', name: ${name} }`;
}

function partialRefToJS(n: PartialRefTNode) :string {
	const partialIdent = n.file === null
		? sanitizeName(n.partialName)
		: importAliasFor(n.file, n.partialName);

	const wrapper = n.wrapper === null
		? 'null'
		: `{ open: '${escapeStr(n.wrapper.open)}', close: '${escapeStr(n.wrapper.close)}' }`;

	const slots = Object.entries(n.slots)
		.map(([name, tnodes]) => `'${name}': [\n${tnodes.map(t => nodeToJS(t)).join(',\n')}\n]`)
		.join(',\n');

	const bindings = n.bindings
		.map(b => `{ name: '${b.name}', data: ${backcodeToJS(b.data)} }`)
		.join(',\n');

	return `{ type: 'partial-ref',
	partial: ${partialIdent},
	wrapper: ${wrapper},
	slots: { ${slots} },
	bindings: [ ${bindings} ]
}`;
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

export function fileToJsModule(file: CompiledFile, filePath: string): string {
	const currentJs = filePath.replace(/\.html$/, '.js');

	// Collect all cross-file refs across all partials in this file
	const crossFileRefs = new Map<string, Set<string>>();  // file → set of partial names
	for (const root of file.partials.values()) {
		for (const ref of collectPartialRefs(root)) {
			if (ref.file !== null) {
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
		exports.push(`export const ${sanitizeName(name)} = ${nodeToJS(root)};`);
	}

	return [...imports, '', ...exports].join('\n');
}
