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
export interface RootRNode {
	type: 'root',
	nodes: RNode[],
	customElement?: boolean,
	definitionAttrNodes?: RNode[],
	scripts?: PartialScript[]   // scripts collected and auto-included by renderRoot
}

// Ordered, deduped collector: url → kind (first-seen wins, Map preserves order).
type ScriptCollector = Map<string, PartialScript['kind']>;

function collectScripts(target: ScriptCollector, scripts?: PartialScript[]): void {
	if (!scripts) return;
	for (const s of scripts) if (!target.has(s.url)) target.set(s.url, s.kind);
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

// Batch render of a page root. Collects the script URLs of every reactive
// custom-element partial actually rendered and injects <script> tags.
export function renderRoot(n :RootRNode, ctx:any, slots?: SlotMap) :string {
	return Array.from(streamRenderRoot(n, ctx, slots)).join('');
}

// Public streaming page entry. Seeds the script collector with this root's own
// scripts, streams the body, and injects the auto-include block before the
// first </body> (see injectScriptsStreaming). Distinct from streamRenderRootInner,
// which is the non-injecting primitive used for nested partials.
export function* streamRenderRoot(n: RootRNode, ctx: any, slots?: SlotMap): Generator<string> {
	const scripts: ScriptCollector = new Map();
	collectScripts(scripts, n.scripts);
	yield* injectScriptsStreaming(streamRenderRootInner(n, ctx, slots, scripts), scripts);
}

// Non-injecting root walk. Reused recursively for nested partials, so it must not
// emit <script> tags — only the page-level streamRenderRoot does that.
function* streamRenderRootInner(n: RootRNode, ctx: any, slots?: SlotMap, scripts?: ScriptCollector): Generator<string> {
	for (const child of n.nodes) yield* streamRender(child, ctx, slots, scripts);
}

function* streamRender(n :RNode, ctx:any, slots?: SlotMap, scripts?: ScriptCollector) :Generator<string> {
	switch(n.type) {
		case 'for':
			yield* streamRenderFor(n, ctx, slots, scripts);
			break;
		case 'if':
			yield* streamRenderIf(n, ctx, slots, scripts);
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
			yield* streamRenderPartialRef(n, ctx, scripts);
			break;
		case 'slot':
			yield* streamRenderSlot(n, slots, scripts);
			break;
		case 'attr-bind':
			yield renderAttrBind(n, ctx);
			break;
		default:
			throw new Error("unhandled node type");
	}
}

function* streamRenderFor(for_node: ForRNode, ctx:any, slots?: SlotMap, scripts?: ScriptCollector) :Generator<string> {
	const iterable = execFn(for_node.iterable, ctx);
	if( !isIterable(iterable) ) throw new Error("iterable not iterable.");

	for( const it of iterable ) {
		const val_ctx :any = {};
		val_ctx[for_node.valName] = it;
		const inner_ctx = Object.assign({}, ctx, val_ctx);
		for (const nn of for_node.nodes) {
			yield* streamRender(nn, inner_ctx, slots, scripts);
		}
	}
}

// Build the auto-include block from the (ordered, deduped) collector. Dependency
// modules are emitted first as <link rel="modulepreload"> so the browser can fetch
// them in parallel with the entry modules that import them; entry modules follow as
// <script type="module">. Empty collector → empty string.
function buildScriptBlock(scripts: ScriptCollector): string {
	if (scripts.size === 0) return '';
	const preloads: string[] = [];
	const modules: string[] = [];
	for (const [url, kind] of scripts) {
		if (kind === 'dependency') {
			preloads.push(`<link rel="modulepreload" href="${escapeHtml(url)}">`);
		} else {
			modules.push(`<script src="${escapeHtml(url)}" type="module"></script>`);
		}
	}
	return [...preloads, ...modules].join('\n');
}

const BODY_CLOSE = '</body>';

// Stream `inner`, injecting the <script> block immediately before the first
// </body> (case-insensitive) — or appending it at the end when no </body> exists.
// The block can't be built until `inner` is exhausted (the script set is only
// complete then), so once </body> is seen we withhold everything from it onward
// (just "</body></html>" + trailing whitespace, normally) and flush block + tail
// at the end. A small carry guards against </body> split across chunk boundaries.
// Placement and ordering match the old batch seek exactly, so renderRoot stays
// byte-identical.
function* injectScriptsStreaming(inner: Generator<string>, scripts: ScriptCollector): Generator<string> {
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
	const block = buildScriptBlock(scripts);
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

function* streamRenderIf(if_node: IfRNode, ctx:any, slots?: SlotMap, scripts?: ScriptCollector) :Generator<string> {
	for( const branch of if_node.branches ) {
		if( !branch.condition || execFn(branch.condition, ctx) ) {
			for (const n of branch.nodes) {
				yield* streamRender(n, ctx, slots, scripts);
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

function* streamRenderPartialRef(node: PartialRefRNode, ctx: any, scripts?: ScriptCollector) :Generator<string> {
	if (node.customElement) {
		yield* streamRenderCustomElementRef(node, ctx, scripts);
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
		yield* streamRenderRootInner(node.partial!, childCtx, slotMap, scripts);
		yield node.wrapper.close;
	} else {
		yield* streamRenderRootInner(node.partial!, childCtx, slotMap, scripts);
	}
}

function* streamRenderCustomElementRef(node: PartialRefRNode, ctx: any, scripts?: ScriptCollector) :Generator<string> {
	const tagName = node.callerTagName!;

	if (node.unresolved) {
		// Fallback: render as plain HTML — caller-side attrs only, default slot in caller ctx.
		yield `<${tagName}`;
		for (const n of node.callerOpenTag ?? []) yield* streamRender(n, ctx, undefined, scripts);
		yield `>`;
		const def = node.slots?.['default'];
		if (def) for (const n of def) yield* streamRender(n, ctx, undefined, scripts);
		yield `</${tagName}>`;
		return;
	}

	// This reactive partial actually rendered — record its scripts for auto-inclusion.
	if (scripts) collectScripts(scripts, node.partial?.scripts);

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
	for (const n of node.callerOpenTag ?? []) yield* streamRender(n, ctx, undefined, scripts);
	for (const n of node.partial!.definitionAttrNodes ?? []) yield* streamRender(n, childCtx, undefined, scripts);
	yield `>`;
	for (const n of node.partial!.nodes) yield* streamRender(n, childCtx, slotMap, scripts);
	yield `</${tagName}>`;
}

function* streamRenderSlot(node: SlotRNode, slots: SlotMap | undefined, scripts?: ScriptCollector) :Generator<string> {
	const slotName = node.name ?? 'default';
	const slotEntry = slots?.[slotName];
	if( !slotEntry ) return;
	// Render slot content in the caller's context, slots don't leak inward
	for (const n of slotEntry.nodes) {
		yield* streamRender(n, slotEntry.ctx, undefined, scripts);
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
