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

export type AttrRPart =
	| { type: 'static'; raw: string }
	| { type: 'dynamic'; name: string; expr: rfn; isBoolean: boolean }

export interface AttrBindRNode {
	type: 'attr-bind',
	tagOpen: string,
	parts: AttrRPart[]
}

export type RNode = RawRNode | PrintRNode | ForRNode | IfRNode | SlotRNode | PartialRefRNode | AttrBindRNode;

export type SlotMap = { [name: string]: { nodes: RNode[], ctx: any } }

export function render(n :RNode, ctx:any, slots?: SlotMap) :string {
	return Array.from(streamRender(n, ctx, slots)).join('');
}

export function renderRoot(n :RootRNode, ctx:any, slots?: SlotMap) :string {
	return Array.from(streamRenderRoot(n, ctx, slots)).join('');
}

export function* streamRenderRoot(n: RootRNode, ctx: any, slots?: SlotMap): Generator<string> {
	for (const child of n.nodes) yield* streamRender(child, ctx, slots);
}

function* streamRender(n :RNode, ctx:any, slots?: SlotMap) :Generator<string> {
	switch(n.type) {
		case 'for':
			yield* streamRenderFor(n, ctx, slots);
			break;
		case 'if':
			yield* streamRenderIf(n, ctx, slots);
			break;
		case 'print':
			yield escapeHtml(String(execFn(n.data, ctx)));
			break;
		case 'raw':
			yield n.raw;
			break;
		case 'partial-ref':
			yield* streamRenderPartialRef(n, ctx);
			break;
		case 'slot':
			yield* streamRenderSlot(n, slots);
			break;
		case 'attr-bind':
			yield renderAttrBind(n, ctx);
			break;
		default:
			throw new Error("unhandled node type");
	}
}

function* streamRenderFor(for_node: ForRNode, ctx:any, slots?: SlotMap) :Generator<string> {
	const iterable = execFn(for_node.iterable, ctx);
	if( !isIterable(iterable) ) throw new Error("iterable not iterable.");

	for( const it of iterable ) {
		const val_ctx :any = {};
		val_ctx[for_node.valName] = it;
		const inner_ctx = Object.assign({}, ctx, val_ctx);
		for (const nn of for_node.nodes) {
			yield* streamRender(nn, inner_ctx, slots);
		}
	}
}

// see https://stackoverflow.com/questions/18884249/checking-whether-something-is-iterable
function isIterable(obj:any) {
	// checks for null and undefined
	if (obj == null) {
	  return false;
	}
	return typeof obj[Symbol.iterator] === 'function';
}

function* streamRenderIf(if_node: IfRNode, ctx:any, slots?: SlotMap) :Generator<string> {
	for( const branch of if_node.branches ) {
		if( !branch.condition || execFn(branch.condition, ctx) ) {
			for (const n of branch.nodes) {
				yield* streamRender(n, ctx, slots);
			}
			return;
		}
	}
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function* streamRenderPartialRef(node: PartialRefRNode, ctx: any) :Generator<string> {
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
	if (node.wrapper) {
		yield node.wrapper.open;
		yield* streamRenderRoot(node.partial, childCtx, slotMap);
		yield node.wrapper.close;
	} else {
		yield* streamRenderRoot(node.partial, childCtx, slotMap);
	}
}

function* streamRenderSlot(node: SlotRNode, slots: SlotMap | undefined) :Generator<string> {
	const slotName = node.name ?? 'default';
	const slotEntry = slots?.[slotName];
	if( !slotEntry ) return;
	// Render slot content in the caller's context, slots don't leak inward
	for (const n of slotEntry.nodes) {
		yield* streamRender(n, slotEntry.ctx, undefined);
	}
}

function renderAttrBind(n: AttrBindRNode, ctx: any): string {
	let out = n.tagOpen;
	for (const p of n.parts) {
		if (p.type === 'static') {
			out += p.raw;
		} else {
			const val = execFn(p.expr, ctx);
			if (p.isBoolean) {
				if (val) out += ` ${p.name}`;
			} else {
				if (val !== null && val !== undefined && val !== false) {
					out += ` ${p.name}="${escapeHtml(String(val))}"`;
				}
			}
		}
	}
	return out + '>';
}

function execFn(fData :rfn, ctx: any) :any {
	const ze_args = fData.vars.map( v => ctx[v] );
	return fData.fn(...ze_args);
}
