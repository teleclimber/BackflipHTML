export interface rfn  {
	vars: string[],
	fn: (...args :any[]) => any
}
export interface RootRNode {
	type: 'root',
	nodes: RNode[]
}
export interface RawRNode {
	type: 'raw',
	raw: string
}
export interface PrintRNode {	// for outputing {{ foo }} into HTML (do escaping)
	type: 'print',
	data: rfn,
}
export interface ForRNode {
	type: 'for',
	iterable: rfn,
	valName: string,
	nodes: RNode[]
}
export interface IfBranch {
	condition?: rfn,
	nodes: RNode[]
}
export interface IfRNode {
	type: 'if',
	branches: IfBranch[]
}

export type RNode = RawRNode | PrintRNode | ForRNode | IfRNode;

export function renderRoot(n :RootRNode, ctx:any) :string {
	return n.nodes.map( n => render(n, ctx) ).join('');
}
// all-at-once renderer. Change to streaming please.
export function render(n :RNode, ctx:any) :string {	
	let out = '';

	switch(n.type) {
		case 'for':
			out = renderFor(n, ctx);
			break;
		case 'if':
			out = renderIf(n, ctx);
			break;
		case 'print':
			out = renderPrint(n, ctx);
			break;
		case 'raw':
			out = n.raw;
			break;
		default:
			throw new Error("unhandled node type");
	}

	return out;
}
function renderFor(for_node: ForRNode, ctx:any) :string {
	const iterable = execFn(for_node.iterable, ctx);
	if( !isIterable(iterable) ) throw new Error("iterable not iterable.");

	let ret = '';
	for( const it of iterable ) {
		const val_ctx :any = {};
		val_ctx[for_node.valName] = it;
		const inner_ctx = Object.assign({}, ctx, val_ctx);
		ret += for_node.nodes?.map( (nn) => render(nn, inner_ctx) ).join('');
	}

	return ret;
}
// see https://stackoverflow.com/questions/18884249/checking-whether-something-is-iterable
function isIterable(obj:any) {
	// checks for null and undefined
	if (obj == null) {
	  return false;
	}
	return typeof obj[Symbol.iterator] === 'function';
}

function renderIf(if_node: IfRNode, ctx:any) :string {
	for( const branch of if_node.branches ) {
		if( !branch.condition || execFn(branch.condition, ctx) ) {
			return branch.nodes.map( n => render(n, ctx) ).join('');
		}
	}
	return '';
}

function renderPrint(print_node: PrintRNode, ctx:any) :string {
	return execFn(print_node.data, ctx);
}

function execFn(fData :rfn, ctx: any) :any {
	const ze_args = fData.vars.map( v => ctx[v] );
	return fData.fn(...ze_args);
}