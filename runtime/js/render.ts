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
export interface SlotRNode {
	type: 'slot',
	name: string | undefined
}
export interface PartialRefRNode {
	type: 'partial-ref',
	partial: RootRNode,
	wrapper: { open: string, close: string } | null,
	slots: { [slotName: string]: RNode[] },
	bindings: { name: string, data: rfn }[]
}

export type RNode = RawRNode | PrintRNode | ForRNode | IfRNode | SlotRNode | PartialRefRNode;

export type SlotMap = { [name: string]: { nodes: RNode[], ctx: any } }

export function renderRoot(n :RootRNode, ctx:any, slots?: SlotMap) :string {
	return n.nodes.map( n => render(n, ctx, slots) ).join('');
}
// all-at-once renderer. Change to streaming please.
export function render(n :RNode, ctx:any, slots?: SlotMap) :string {
	let out = '';

	switch(n.type) {
		case 'for':
			out = renderFor(n, ctx, slots);
			break;
		case 'if':
			out = renderIf(n, ctx, slots);
			break;
		case 'print':
			out = renderPrint(n, ctx);
			break;
		case 'raw':
			out = n.raw;
			break;
		case 'partial-ref':
			out = renderPartialRef(n, ctx);
			break;
		case 'slot':
			out = renderSlot(n, slots);
			break;
		default:
			throw new Error("unhandled node type");
	}

	return out;
}
function renderFor(for_node: ForRNode, ctx:any, slots?: SlotMap) :string {
	const iterable = execFn(for_node.iterable, ctx);
	if( !isIterable(iterable) ) throw new Error("iterable not iterable.");

	let ret = '';
	for( const it of iterable ) {
		const val_ctx :any = {};
		val_ctx[for_node.valName] = it;
		const inner_ctx = Object.assign({}, ctx, val_ctx);
		ret += for_node.nodes?.map( (nn) => render(nn, inner_ctx, slots) ).join('');
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

function renderIf(if_node: IfRNode, ctx:any, slots?: SlotMap) :string {
	for( const branch of if_node.branches ) {
		if( !branch.condition || execFn(branch.condition, ctx) ) {
			return branch.nodes.map( n => render(n, ctx, slots) ).join('');
		}
	}
	return '';
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderPrint(print_node: PrintRNode, ctx:any) :string {
	return escapeHtml(String(execFn(print_node.data, ctx)));
}

function renderPartialRef(node: PartialRefRNode, ctx: any) :string {
	// Evaluate bindings in caller ctx, build child ctx
	let childCtx = { ...ctx };
	for( const binding of node.bindings ) {
		childCtx[binding.name] = execFn(binding.data, ctx);
	}
	// Build slot map: capture caller ctx with each slot's nodes
	const slotMap: SlotMap = {};
	for( const [name, nodes] of Object.entries(node.slots) ) {
		slotMap[name] = { nodes, ctx };  // caller's ctx, not childCtx
	}
	// Render the partial with child ctx and slot map
	const rendered = renderRoot(node.partial, childCtx, slotMap);
	// Apply wrapper if present
	return node.wrapper ? node.wrapper.open + rendered + node.wrapper.close : rendered;
}

function renderSlot(node: SlotRNode, slots: SlotMap | undefined) :string {
	const slotName = node.name ?? 'default';
	const slotEntry = slots?.[slotName];
	if( !slotEntry ) return '';
	// Render slot content in the caller's context, slots don't leak inward
	return slotEntry.nodes.map( n => render(n, slotEntry.ctx, undefined) ).join('');
}

function execFn(fData :rfn, ctx: any) :any {
	const ze_args = fData.vars.map( v => ctx[v] );
	return fData.fn(...ze_args);
}