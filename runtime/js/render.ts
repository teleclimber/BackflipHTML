export interface rfn  {
	vars: string[],
	fn: (...args :any[]) => any
}
// A script the renderer auto-includes when this partial renders.
//  - 'entry'      → <script type="module" src>      (executed module, e.g. the hand-coded web component)
//  - 'dependency' → <link rel="modulepreload" href> (module imported by an entry; preloaded)
export interface PartialScript {
	url: string,
	kind: 'entry' | 'dependency',
}
// A store a partial declares with b-store:NAME. A shipped one is read by the
// partial's generated client code, so a page render sends it to the browser.
export interface PartialStoreR {
	name: string,
	shipped: boolean,
	src?: string,   // the store file's URL
}
export interface RootRNode {
	type: 'root',
	nodes: RNode[],
	name?: string,                // the partial's name, set when it declares stores
	customElement?: boolean,
	definitionAttrNodes?: RNode[],
	scripts?: PartialScript[],    // scripts collected and auto-included by renderRoot
	stores?: PartialStoreR[],
}

/** Store data passed to a render, by store name. */
export type StoreData = Record<string, unknown>;

// What a page render gathers from the partials it actually renders, and the
// auto-include block built from it.
class PageCollector {
	// url → kind; first-seen wins, Map preserves order.
	private scripts = new Map<string, PartialScript['kind']>();
	// store name → its escaped JSON, in first-shipped order.
	private stores = new Map<string, string>();

	constructor(private storeData: StoreData) {}

	add(root: RootRNode | undefined): void {
		for (const s of root?.stores ?? []) {
			if (!s.shipped || this.stores.has(s.name)) continue;
			this.stores.set(s.name, storeJson(s.name, this.storeData[s.name]));
			if (s.src) this.addScript(s.src, 'dependency');
		}
		for (const s of root?.scripts ?? []) this.addScript(s.url, s.kind);
	}

	private addScript(url: string, kind: PartialScript['kind']): void {
		if (!this.scripts.has(url)) this.scripts.set(url, kind);
	}

	// Store tags come first, so the data is in the document before any module runs.
	// Dependency modules follow as <link rel="modulepreload"> so the browser can
	// fetch them in parallel with the entry modules that import them; entry modules
	// come last as <script type="module">. Nothing collected → empty string.
	block(): string {
		const tags: string[] = [];
		for (const [name, json] of this.stores) {
			tags.push(`<script type="application/json" data-bf-store="${escapeHtml(name)}">${json}</script>`);
		}
		const preloads: string[] = [];
		const modules: string[] = [];
		for (const [url, kind] of this.scripts) {
			if (kind === 'dependency') {
				preloads.push(`<link rel="modulepreload" href="${escapeHtml(url)}">`);
			} else {
				modules.push(`<script src="${escapeHtml(url)}" type="module"></script>`);
			}
		}
		return [...tags, ...preloads, ...modules].join('\n');
	}
}

// A store's data as JSON that cannot end its <script> tag: `<`, `>` and `&` are
// escaped, and so are U+2028 and U+2029, matching PHP's json_encode with JSON_HEX_TAG
// and JSON_HEX_AMP.
function storeJson(name: string, data: unknown): string {
	let json: string | undefined;
	try {
		json = JSON.stringify(data);
	} catch (e) {
		throw new Error(`store "${name}" cannot be serialized to JSON: ${e instanceof Error ? e.message : e}`);
	}
	if (json === undefined) throw new Error(`store "${name}" cannot be serialized to JSON: its data is ${typeof data}`);
	return json.replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
}

// Threaded through a render. `stores` holds one store object per passed store, the
// same object for every partial that declares it; `page` is set only under a page
// render.
interface RenderState {
	stores: Record<string, { data: unknown }>,
	page?: PageCollector
}

function renderState(stores: StoreData | undefined, page?: PageCollector): RenderState {
	const objects: RenderState['stores'] = {};
	for (const [name, data] of Object.entries(stores ?? {})) objects[name] = { data };
	return page ? { stores: objects, page } : { stores: objects };
}

// Bind each store `root` declares into `ctx`, its context.
function bindStores(ctx: any, root: RootRNode, rs: RenderState): void {
	for (const s of root.stores ?? []) {
		if (!Object.hasOwn(rs.stores, s.name)) {
			throw new Error(`partial "${root.name}" declares b-store:${s.name}, but no store "${s.name}" was passed to the renderer`);
		}
		ctx[s.name] = rs.stores[s.name];
	}
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

export type SlotMap = { [name: string]: { nodes: RNode[], ctx: any, slots?: SlotMap } }

// Render one node. Partials it renders get their declared stores from `stores`;
// no store tags or scripts are emitted.
export function render(n :RNode, ctx:any, slots?: SlotMap, stores?: StoreData) :string {
	return Array.from(streamRender(n, ctx, slots, renderState(stores))).join('');
}

// Batch render of a page root. Collects the scripts and shipped stores of every
// reactive custom-element partial actually rendered and injects them.
export function renderRoot(n :RootRNode, ctx:any, slots?: SlotMap, stores?: StoreData) :string {
	return Array.from(streamRenderRoot(n, ctx, slots, stores)).join('');
}

// Public streaming page entry. Seeds the page collector with this root's own
// scripts and stores, streams the body, and injects the auto-include block before
// the first </body> (see injectBlockStreaming). Distinct from streamRenderRootInner,
// which is the non-injecting primitive used for nested partials. The root's context
// is `ctx` plus the stores the root declares.
export function* streamRenderRoot(n: RootRNode, ctx: any, slots?: SlotMap, stores?: StoreData): Generator<string> {
	const page = new PageCollector(stores ?? {});
	const rs = renderState(stores, page);
	for (const s of n.stores ?? []) {
		if (Object.hasOwn(ctx, s.name)) {
			throw new Error(`ctx key "${s.name}" is also a store the root partial "${n.name}" declares; rename one`);
		}
	}
	const rootCtx = { ...ctx };
	bindStores(rootCtx, n, rs);
	page.add(n);
	yield* injectBlockStreaming(streamRenderRootInner(n, rootCtx, slots, rs), page);
}

// Non-injecting root walk. Reused recursively for nested partials, so it must not
// emit <script> tags — only the page-level streamRenderRoot does that.
function* streamRenderRootInner(n: RootRNode, ctx: any, slots: SlotMap | undefined, rs: RenderState): Generator<string> {
	for (const child of n.nodes) yield* streamRender(child, ctx, slots, rs);
}

function* streamRender(n :RNode, ctx:any, slots: SlotMap | undefined, rs: RenderState) :Generator<string> {
	switch(n.type) {
		case 'for':
			yield* streamRenderFor(n, ctx, slots, rs);
			break;
		case 'if':
			yield* streamRenderIf(n, ctx, slots, rs);
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
			yield* streamRenderPartialRef(n, ctx, slots, rs);
			break;
		case 'slot':
			yield* streamRenderSlot(n, slots, rs);
			break;
		case 'attr-bind':
			yield renderAttrBind(n, ctx);
			break;
		default:
			throw new Error("unhandled node type");
	}
}

function* streamRenderFor(for_node: ForRNode, ctx:any, slots: SlotMap | undefined, rs: RenderState) :Generator<string> {
	const iterable = execFn(for_node.iterable, ctx);
	if( !isIterable(iterable) ) throw new Error("iterable not iterable.");

	for( const it of iterable ) {
		const val_ctx :any = {};
		val_ctx[for_node.valName] = it;
		const inner_ctx = Object.assign({}, ctx, val_ctx);
		for (const nn of for_node.nodes) {
			yield* streamRender(nn, inner_ctx, slots, rs);
		}
	}
}

const BODY_CLOSE = '</body>';

// Stream `inner`, injecting the auto-include block immediately before the first
// </body> (case-insensitive) — or appending it at the end when no </body> exists.
// The block can't be built until `inner` is exhausted (the collector is only
// complete then), so once </body> is seen we withhold everything from it onward
// (just "</body></html>" + trailing whitespace, normally) and flush block + tail
// at the end. A small carry guards against </body> split across chunk boundaries.
// Placement and ordering match the old batch seek exactly, so renderRoot stays
// byte-identical.
function* injectBlockStreaming(inner: Generator<string>, page: PageCollector): Generator<string> {
	let carry = '';            // possible partial </body> prefix held back (pre-match)
	let tail: string | null = null;  // everything from </body> onward, once matched
	for (const chunk of inner) {
		if (tail !== null) { tail += chunk; continue; }
		const buf = carry + chunk;
		const idx = buf.search(/<\/body>/i);
		if (idx !== -1) {
			yield buf.slice(0, idx);
			tail = buf.slice(idx);
			carry = '';
		} else {
			// Hold back up to len-1 trailing chars: they might begin a split </body>.
			const keep = Math.min(BODY_CLOSE.length - 1, buf.length);
			yield buf.slice(0, buf.length - keep);
			carry = buf.slice(buf.length - keep);
		}
	}
	const block = page.block();
	if (tail !== null) {
		yield block + tail;
	} else {
		if (carry) yield carry;
		if (block) yield block;
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

// Index of the branch an if node renders: the first whose condition holds (a b-else
// has none, so it always does), or -1 when none does.
export function activeBranchIndex(if_node: IfRNode, ctx: any): number {
	return if_node.branches.findIndex(branch => !branch.condition || execFn(branch.condition, ctx));
}

function* streamRenderIf(if_node: IfRNode, ctx:any, slots: SlotMap | undefined, rs: RenderState) :Generator<string> {
	const i = activeBranchIndex(if_node, ctx);
	if (i === -1) return;
	for (const n of if_node.branches[i].nodes) {
		yield* streamRender(n, ctx, slots, rs);
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

function* streamRenderPartialRef(node: PartialRefRNode, ctx: any, slots: SlotMap | undefined, rs: RenderState) :Generator<string> {
	if (node.customElement) {
		yield* streamRenderCustomElementRef(node, ctx, slots, rs);
		return;
	}
	// A partial's context holds its bindings and declared stores and nothing else: the
	// child ctx starts empty, and the bindings that fill it are evaluated in the caller's ctx.
	const childCtx: any = {};
	for( const binding of node.bindings ) {
		childCtx[binding.name] = evalBinding(binding, ctx);
	}
	bindStores(childCtx, node.partial!, rs);
	// Build slot map: capture caller ctx with each slot's nodes
	const slotMap: SlotMap = {};
	for( const [name, nodes] of Object.entries(node.slots) ) {
		slotMap[name] = { nodes, ctx, slots };  // caller's ctx + caller's slot map, not childCtx
	}
	// Render the partial with child ctx and slot map
	if (node.wrapper) {
		yield node.wrapper.open;
		yield* streamRenderRootInner(node.partial!, childCtx, slotMap, rs);
		yield node.wrapper.close;
	} else {
		yield* streamRenderRootInner(node.partial!, childCtx, slotMap, rs);
	}
}

function* streamRenderCustomElementRef(node: PartialRefRNode, ctx: any, slots: SlotMap | undefined, rs: RenderState) :Generator<string> {
	const tagName = node.callerTagName!;

	if (node.unresolved) {
		// Fallback: render as plain HTML — caller-side attrs only, default slot in caller ctx.
		yield `<${tagName}`;
		for (const n of node.callerOpenTag ?? []) yield* streamRender(n, ctx, undefined, rs);
		yield `>`;
		const def = node.slots?.['default'];
		if (def) for (const n of def) yield* streamRender(n, ctx, slots, rs);
		yield `</${tagName}>`;
		return;
	}

	// Bindings evaluated in caller ctx, applied to the child ctx that the body and the
	// definition-side attrs see.
	const childCtx: any = {};
	for (const binding of node.bindings) {
		childCtx[binding.name] = evalBinding(binding, ctx);
	}
	bindStores(childCtx, node.partial!, rs);
	// This reactive partial actually rendered — record its scripts and stores for auto-inclusion.
	rs.page?.add(node.partial);
	const slotMap: SlotMap = {};
	for (const [name, nodes] of Object.entries(node.slots)) {
		slotMap[name] = { nodes, ctx, slots };
	}

	// Single merged open tag: caller-side attrs in caller ctx, definition-side attrs in childCtx.
	yield `<${tagName}`;
	for (const n of node.callerOpenTag ?? []) yield* streamRender(n, ctx, undefined, rs);
	for (const n of node.partial!.definitionAttrNodes ?? []) yield* streamRender(n, childCtx, undefined, rs);
	yield `>`;
	for (const n of node.partial!.nodes) yield* streamRender(n, childCtx, slotMap, rs);
	yield `</${tagName}>`;
}

function* streamRenderSlot(node: SlotRNode, slots: SlotMap | undefined, rs: RenderState) :Generator<string> {
	const slotName = node.name ?? 'default';
	const slotEntry = slots?.[slotName];
	if( !slotEntry ) return;
	// Render slot content in the caller's lexical environment: its ctx and the slot
	// map in effect where the content was written (so a nested b-slot forwards).
	for (const n of slotEntry.nodes) {
		yield* streamRender(n, slotEntry.ctx, slotEntry.slots, rs);
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

// Evaluate a compiled expression: its vars, read from ctx, are the fn's arguments.
export function execFn(fData :rfn, ctx: any) :any {
	const ze_args = fData.vars.map( v => ctx[v] );
	return fData.fn(...ze_args);
}
