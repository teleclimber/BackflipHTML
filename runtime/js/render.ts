export interface rfn  {
	vars: string[],
	fn: (...args :any[]) => any
}
export interface RootRNode {
	type: 'root',
	nodes: RNode[],
	customElement?: boolean,
	definitionAttrNodes?: RNode[]
}
export interface RawRNode {
	type: 'raw',
	raw: string
}
export interface CommentRNode {	// an HTML comment <!--text-->, emitted verbatim
	type: 'comment',
	text: string
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
export interface PartialBindingR {
	name: string,
	data?: rfn,
	literal?: string | boolean,
	cast?: 'bool' | 'string'
}
export interface PartialRefRNode {
	type: 'partial-ref',
	partial?: RootRNode,
	wrapper?: { open: string, close: string } | null,
	slots: { [slotName: string]: RNode[] },
	bindings: PartialBindingR[],
	customElement?: boolean,
	unresolved?: boolean,
	callerTagName?: string,
	callerOpenTag?: RNode[]
}

export type AttrRPart =
	| { type: 'static'; raw: string }
	| { type: 'dynamic'; name: string; expr: rfn; isBoolean: boolean; isAsset?: boolean }

export interface AttrBindRNode {
	type: 'attr-bind',
	tagOpen: string,
	parts: AttrRPart[],
	assetMap?: Record<string, string>,
	selfClosing?: boolean,
	attrsOnly?: boolean
}

export type RNode = RawRNode | CommentRNode | PrintRNode | ForRNode | IfRNode | SlotRNode | PartialRefRNode | AttrBindRNode;

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
		case 'comment':
			yield `<!--${n.text}-->`;
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

function evalBinding(binding: PartialBindingR, ctx: any): any {
	if (binding.literal !== undefined) {
		return binding.literal;
	}
	let value = execFn(binding.data!, ctx);
	if (binding.cast === 'bool') value = Boolean(value);
	else if (binding.cast === 'string') value = String(value);
	return value;
}

function* streamRenderPartialRef(node: PartialRefRNode, ctx: any) :Generator<string> {
	if (node.customElement) {
		yield* streamRenderCustomElementRef(node, ctx);
		return;
	}
	// Evaluate bindings in caller ctx, build child ctx
	let childCtx = { ...ctx };
	for( const binding of node.bindings ) {
		childCtx[binding.name] = evalBinding(binding, ctx);
	}
	// Build slot map: capture caller ctx with each slot's nodes
	const slotMap: SlotMap = {};
	for( const [name, nodes] of Object.entries(node.slots) ) {
		slotMap[name] = { nodes, ctx };  // caller's ctx, not childCtx
	}
	// Render the partial with child ctx and slot map
	if (node.wrapper) {
		yield node.wrapper.open;
		yield* streamRenderRoot(node.partial!, childCtx, slotMap);
		yield node.wrapper.close;
	} else {
		yield* streamRenderRoot(node.partial!, childCtx, slotMap);
	}
}

function* streamRenderCustomElementRef(node: PartialRefRNode, ctx: any) :Generator<string> {
	const tagName = node.callerTagName!;

	if (node.unresolved) {
		// Fallback: render as plain HTML — caller-side attrs only, default slot in caller ctx.
		yield `<${tagName}`;
		for (const n of node.callerOpenTag ?? []) yield* streamRender(n, ctx, undefined);
		yield `>`;
		const def = node.slots?.['default'];
		if (def) for (const n of def) yield* streamRender(n, ctx, undefined);
		yield `</${tagName}>`;
		return;
	}

	// Bindings evaluated in caller ctx, applied to the child ctx that the body and the
	// definition-side attrs see.
	let childCtx = { ...ctx };
	for (const binding of node.bindings) {
		childCtx[binding.name] = evalBinding(binding, ctx);
	}
	const slotMap: SlotMap = {};
	for (const [name, nodes] of Object.entries(node.slots)) {
		slotMap[name] = { nodes, ctx };
	}

	// Single merged open tag: caller-side attrs in caller ctx, definition-side attrs in childCtx.
	yield `<${tagName}`;
	for (const n of node.callerOpenTag ?? []) yield* streamRender(n, ctx, undefined);
	for (const n of node.partial!.definitionAttrNodes ?? []) yield* streamRender(n, childCtx, undefined);
	yield `>`;
	for (const n of node.partial!.nodes) yield* streamRender(n, childCtx, slotMap);
	yield `</${tagName}>`;
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

function replaceAssetPaths(value: string, assetMap: Record<string, string>): string {
	for (const [name, prefix] of Object.entries(assetMap)) {
		value = value.replaceAll(`@${name}/`, prefix);
	}
	return value;
}

function renderAttrBind(n: AttrBindRNode, ctx: any): string {
	let out = n.attrsOnly ? '' : n.tagOpen;
	for (const p of n.parts) {
		if (p.type === 'static') {
			out += p.raw;
		} else {
			let val = execFn(p.expr, ctx);
			if (p.isAsset && n.assetMap && val !== null && val !== undefined && val !== false) {
				val = replaceAssetPaths(String(val), n.assetMap);
			}
			if (p.isBoolean) {
				if (val) out += ` ${p.name}`;
			} else {
				if (val !== null && val !== undefined && val !== false) {
					out += ` ${p.name}="${escapeHtml(String(val))}"`;
				}
			}
		}
	}
	if (n.attrsOnly) return out;
	return out + (n.selfClosing ? ' />' : '>');
}

function execFn(fData :rfn, ctx: any) :any {
	const ze_args = fData.vars.map( v => ctx[v] );
	return fData.fn(...ze_args);
}
