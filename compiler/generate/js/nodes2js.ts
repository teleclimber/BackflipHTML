import type { TNode, ForTNode, RootTNode, PrintTNode, RawTNode, IfTNode, IfBranch } from '../../compiler.ts';
import type { Parsed } from '../../backcode.ts';
import { generateFunction } from './generatejs.ts';

// this file takes the compiler's output which is an AST of sorts, 
// with embeded code ast
// and generates a JS file, I think?

// What are we generating here exactly?
// The ast is a tree because of the for loops and possibly others.

// Whatever you do don't overcomplicate at this early stage.
// even if doesn't scale to a large site do simple things first.

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
	return `{ type: 'raw', raw: '${n.raw.replace(/\n/g, '\\n')}' }`;	// definitely need to escape quotes! and newlines!
}

function printToJS(print_node: PrintTNode) :string {
	return `{ type:'print', data: ${backcodeToJS(print_node.data)} }`;
}

function backcodeToJS(c :Parsed) :string {
	const fn = generateFunction('', c);
	const vars = `[${c.vars.map(v => "'"+v+"'").join(', ')}]`;
	return `{ fn: ${fn}, vars: ${vars} }`;
}
