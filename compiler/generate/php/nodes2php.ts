import * as path from 'node:path';
import type { TNode, ForTNode, RootTNode, PrintTNode, RawTNode, IfTNode, IfBranch, SlotTNode, PartialRefTNode, PartialBinding, CompiledFile } from '../../compiler.ts';
import type { Parsed } from '../../backcode.ts';
import { generatePhpFunction } from './generatephp.ts';

export function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_$]/g, '_');
}

export function nodeToPhp(n: TNode | RootTNode): string {
	let out = '';

	switch (n.type) {
		case 'root':
			out = rootToPhp(n);
			break;
		case 'for':
			out = forToPhp(n);
			break;
		case 'if':
			out = ifToPhp(n);
			break;
		case 'print':
			out = printToPhp(n);
			break;
		case 'raw':
			out = rawToPhp(n);
			break;
		case 'slot':
			out = slotToPhp(n);
			break;
		case 'partial-ref':
			out = partialRefToPhp(n);
			break;
		default:
			throw new Error("unhandled node type");
	}

	return out;
}

function rootToPhp(n: RootTNode): string {
	const nodes = n.tnodes.map(nn => nodeToPhp(nn)).join(',\n    ');
	return `['type' => 'root', 'nodes' => [\n    ${nodes}\n]]`;
}

function forToPhp(for_node: ForTNode): string {
	return `['type' => 'for',
    'iterable' => ${backcodeToPhp(for_node.iterable)},
    'valName' => '${for_node.valName}',
    'nodes' => [
        ${for_node.tnodes?.map(n => nodeToPhp(n)).join(',\n        ')}
    ]
]`;
}

function ifToPhp(if_node: IfTNode): string {
	const branches = if_node.branches.map(b => branchToPhp(b)).join(',\n        ');
	return `['type' => 'if',
    'branches' => [
        ${branches}
    ]
]`;
}

function branchToPhp(branch: IfBranch): string {
	const condition = branch.condition ? backcodeToPhp(branch.condition) : 'null';
	return `['condition' => ${condition}, 'nodes' => [
            ${branch.tnodes.map(n => nodeToPhp(n)).join(',\n            ')}
        ]]`;
}

function rawToPhp(n: RawTNode): string {
	const escaped = n.raw
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'");
	return `['type' => 'raw', 'raw' => '${escaped}']`;
}

function printToPhp(print_node: PrintTNode): string {
	return `['type' => 'print', 'data' => ${backcodeToPhp(print_node.data)}]`;
}

function slotToPhp(n: SlotTNode): string {
	const name = n.name === undefined ? 'null' : `'${n.name}'`;
	return `['type' => 'slot', 'name' => ${name}]`;
}

function partialRefToPhp(n: PartialRefTNode): string {
	const partialIdent = n.file === null
		? '$' + sanitizeName(n.partialName)
		: '$' + importAliasFor(n.file, n.partialName);

	const wrapper = n.wrapper === null
		? 'null'
		: `['open' => '${escapeStr(n.wrapper.open)}', 'close' => '${escapeStr(n.wrapper.close)}']`;

	const slots = Object.entries(n.slots)
		.map(([name, tnodes]) => `'${name}' => [\n        ${tnodes.map(t => nodeToPhp(t)).join(',\n        ')}\n    ]`)
		.join(',\n    ');

	const bindings = n.bindings
		.map(b => `['name' => '${b.name}', 'data' => ${backcodeToPhp(b.data)}]`)
		.join(',\n        ');

	return `['type' => 'partial-ref',
    'partial' => ${partialIdent},
    'wrapper' => ${wrapper},
    'slots' => [${slots ? ' ' + slots + ' ' : ''}],
    'bindings' => [${bindings ? '\n        ' + bindings + '\n    ' : ''}]
]`;
}

function escapeStr(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function importAliasFor(file: string, partialName: string): string {
	return sanitizeName(file.replace(/\.html$/, '')) + '__' + sanitizeName(partialName);
}

export function backcodeToPhp(c: Parsed): string {
	const fn = generatePhpFunction('', c);
	const vars = `[${c.vars.map(v => "'" + v + "'").join(', ')}]`;
	return `['fn' => ${fn}, 'vars' => ${vars}]`;
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

export function fileToPhpFile(file: CompiledFile, filePath: string): string {
	const currentPhp = filePath.replace(/\.html$/, '.php');

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

	// Build require statements
	const requires: string[] = [];
	for (const [refFile, partialNames] of crossFileRefs) {
		const refPhp = refFile.replace(/\.html$/, '.php');
		let relPath = path.relative(path.dirname(currentPhp), refPhp);
		if (!relPath.startsWith('.')) relPath = './' + relPath;
		const requireVar = '_bf_' + sanitizeName(refFile.replace(/\.html$/, ''));
		requires.push(`$${requireVar} = backflip_require(__DIR__ . '/${relPath}');`);
		for (const name of partialNames) {
			const alias = importAliasFor(refFile, name);
			requires.push(`$${alias} = $${requireVar}['${sanitizeName(name)}'];`);
		}
	}

	// Topologically sort partials and emit assignments
	const sorted = topoSortPartials(file.partials);
	const assignments: string[] = [];
	for (const name of sorted) {
		const root = file.partials.get(name)!;
		assignments.push(`$${sanitizeName(name)} = ${nodeToPhp(root)};`);
	}

	// Build compact call
	const compactArgs = sorted.map(name => `'${sanitizeName(name)}'`).join(', ');
	const returnStmt = `return compact(${compactArgs});`;

	const header = `<?php\n/* generated by BackflipHTML — do not edit */\n`;

	const parts: string[] = [header];
	if (requires.length > 0) {
		parts.push(requires.join('\n'));
		parts.push('');
	}
	parts.push(assignments.join('\n\n'));
	parts.push('');
	parts.push(returnStmt);

	return parts.join('\n');
}
