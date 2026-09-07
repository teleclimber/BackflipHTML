import type {
	CompiledFile, CustomElementCallTNode, ElementTNode, PartialRefTNode, RootTNode, TNode,
} from '@backflip/html';
import { resolvePartial, visitTNodes } from '@backflip/html';
import { attrIndexOf, buildAttrIndex, type AttrIndex, type ElementLikeTNode } from './tnode-view.js';

/**
 * The render tree, as instances.
 *
 * The compiler's `TNode` tree is the *authoring* view: a `b-part` call is a leaf
 * in the caller's tree, slot content hangs where it was written rather than
 * where it renders, and one `b-for` body stands for every iteration. CSS needs
 * the *rendered* view, because that is what a browser matches against.
 *
 * A node here is an **instance**: a `(TNode, environment)` pair. One `ElementTNode`
 * inside a partial used three times is three instances, each with its own parent
 * chain. The rules in `expandList` are the CSS-side mirror of `streamRender*` in
 * `runtime/js/render.ts` — when they disagree, the runtime is right.
 *
 * Expansion is lazy: `childrenOf` expands one element level on demand, so
 * `css-select` can walk into a partial only when a selector actually asks
 * (`:has()`, a descendant combinator) without the whole forest being built for
 * every query.
 *
 * ## Identity is load-bearing
 *
 * `css-select` locates an element among its siblings by identity — `equals` in
 * `general.js` for `+` / `~` and the `nth-*` filters, and a raw `indexOf`
 * (`getNextSiblings` in `helpers/querying.js`) for `:has()` with a leading
 * sibling combinator. So a logical instance must always be the *same object*,
 * and `getChildren` / `getSiblings` must hand back the *same array*. That is
 * what `_children` memoizes. Never build instance nodes inside an adapter call.
 */

/** How many iterations of a `b-for` body are modelled. */
export const FOR_REPS = 3;

/** Maximum element nesting expanded. At the cap, an instance reports no children. */
export const MAX_DEPTH = 20;

/** Ceiling on the instances built for one analysis run. */
export const MAX_INSTANCES = 50_000;

/**
 * Ceiling on partial / slot / branch splices between one element and the next.
 * A `b-part` cycle written with `b-unwrap` tags renders no element to stop at,
 * so the element depth cap alone would not terminate. The compiler rejects such
 * cycles, but the LSP analyses half-written trees, so the backstop has to exist.
 */
const MAX_SPLICE = 50;

/** A slot fill, plus the environment its content resolves against. */
export interface SlotEntry {
	tnodes: TNode[];
	/**
	 * The environment in effect where the fill was written — the caller's. A
	 * `b-slot` inside the fill resolves against *this*, which is the whole of
	 * why slot forwarding works at any depth (runtime: `streamRenderSlot`).
	 */
	env: Env;
}

/** What a `SlotTNode` resolves against while one partial is being expanded. */
export interface Env {
	slots: { [slotName: string]: SlotEntry };
	/** File whose tree the partial being expanded lives in. */
	file: string;
	/** Name of that partial, for reporting. */
	partialName: string;
}

/**
 * Which expansion rule put an instance where it is, relative to the nearest
 * enclosing element. Innermost container wins: an element written inside a
 * `b-for` inside a `b-if` reports `'for'`, and `conditional` records the branch.
 */
export type InstanceOrigin = 'root' | 'element' | 'partial' | 'slot' | 'for' | 'if';

export interface InstanceNode {
	/** The compiler node that renders as this element. */
	tnode: ElementLikeTNode;
	/** The tnodes this instance's children expand from. */
	body: TNode[];
	/** The environment `body` expands under. */
	env: Env;
	/** File whose tree `tnode` lives in. */
	file: string;
	/** Partial `tnode` is written in. */
	partialName: string;
	parent: InstanceNode | null;
	/** Element nesting depth, counted from a root instance. */
	depth: number;
	/** This instance renders only when some `b-if` branch is taken. */
	conditional: boolean;
	/** How this instance came to sit under its parent. */
	via: InstanceOrigin;
	/** Attribute index when it is not the tnode's own (a merged custom-element call). */
	attrs: AttrIndex | null;
	/** Memoized children. The array identity is load-bearing — see above. */
	_children: InstanceNode[] | null;
	/** For a root instance, the array it shares with its root-level siblings. */
	_roots: InstanceNode[] | null;
}

export interface ExpandCtx {
	files: Map<string, CompiledFile>;
	/** Where each partial root lives, for building a callee's environment. */
	rootInfo: Map<RootTNode, { file: string; name: string }>;
	/** Roots whose body has been expanded at least once. */
	visited: Set<RootTNode>;
	/** Merged caller ++ definition attrs, per custom-element call. */
	mergedAttrs: WeakMap<CustomElementCallTNode, AttrIndex>;
	count: number;
	truncated: boolean;
}

/** A partial expansion started from, and why it was chosen. */
export interface RootSelection {
	root: RootTNode;
	file: string;
	name: string;
	/** `entry`: nothing calls it. `unreached`: only reachable through a cycle. */
	reason: 'entry' | 'unreached';
}

export interface InstanceForest {
	/** Instances with no parent, in root order. */
	tops: InstanceNode[];
	/** Every instance, document order within each root. */
	all: InstanceNode[];
	ctx: ExpandCtx;
	/** The partials expansion started from, in the order they were grown. */
	roots: RootSelection[];
	/** The instance budget ran out; some of the forest is missing. */
	truncated: boolean;
}

// --- Expansion ---

/** Where the next instances go, and how they got there. Threaded through `expandList`. */
interface Site {
	env: Env;
	parent: InstanceNode | null;
	depth: number;
	/** Container splices since the last element, against `MAX_SPLICE`. */
	splice: number;
	conditional: boolean;
	via: InstanceOrigin;
}

type NewNode = Omit<InstanceNode, '_children' | '_roots'>;

function makeNode(ctx: ExpandCtx, fields: NewNode): InstanceNode | null {
	if (ctx.count >= MAX_INSTANCES) {
		ctx.truncated = true;
		return null;
	}
	ctx.count++;
	return { ...fields, _children: null, _roots: null };
}

/**
 * Expand one list of tnodes into the instances it renders, appending to `out`.
 *
 * | TNode | Instances |
 * |---|---|
 * | `element` | one; its children expand lazily under the same env |
 * | `partial-ref` / `b-part` | none of its own — the target's body is spliced in under a fresh env. The tag carrying the call, when there is one, is already the enclosing `ElementTNode` |
 * | `partial-ref` / `custom-element` | one merged tag; children are the target's body under the fresh env |
 * | `partial-ref` / `custom-element`, unresolved | one tag with the call-site attrs; children are the default slot in the *current* env |
 * | `slot` | the fill spliced in under the env it was written in |
 * | `for` | the body repeated `FOR_REPS` times |
 * | `if` | every branch spliced in, each marked conditional |
 * | `raw` / `comment` / `print` / `attr-bind` | none |
 */
function expandList(tnodes: TNode[], site: Site, out: InstanceNode[], ctx: ExpandCtx): void {
	if (site.splice > MAX_SPLICE || ctx.truncated) return;
	for (const n of tnodes) {
		if (ctx.truncated) return;
		switch (n.type) {
			case 'element': {
				const node = makeNode(ctx, {
					tnode: n,
					body: n.tnodes,
					env: site.env,
					file: site.env.file,
					partialName: site.env.partialName,
					parent: site.parent,
					depth: site.depth,
					conditional: site.conditional,
					via: site.via,
					attrs: null,
				});
				if (node) out.push(node);
				break;
			}
			case 'partial-ref':
				expandRef(n, site, out, ctx);
				break;
			case 'slot': {
				const entry = site.env.slots[n.name ?? 'default'];
				if (entry) {
					expandList(entry.tnodes, {
						...site, env: entry.env, splice: site.splice + 1, via: 'slot',
					}, out, ctx);
				}
				break;
			}
			case 'for':
				for (let i = 0; i < FOR_REPS; i++) {
					expandList(n.tnodes, { ...site, splice: site.splice + 1, via: 'for' }, out, ctx);
				}
				break;
			case 'if':
				// Every branch is modelled as present. Two elements in mutually
				// exclusive branches therefore look like siblings; marking them
				// conditional keeps that from ever being reported as definite.
				for (const branch of n.branches) {
					expandList(branch.tnodes, {
						...site, splice: site.splice + 1, conditional: true, via: 'if',
					}, out, ctx);
				}
				break;
			// raw / comment / print / attr-bind render no element
		}
	}
}

function expandRef(ref: PartialRefTNode, site: Site, out: InstanceNode[], ctx: ExpandCtx): void {
	const own = ctx.files.get(site.env.file);
	const target = own ? resolvePartial(ref, own, ctx.files) : null;

	if (ref.kind === 'b-part') {
		// An unresolvable b-part renders nothing (it is a compile error anyway).
		if (!target) return;
		ctx.visited.add(target);
		expandList(target.tnodes, {
			...site,
			env: calleeEnv(ref, target, site.env, ctx),
			splice: site.splice + 1,
			via: 'partial',
		}, out, ctx);
		return;
	}

	const common = {
		tnode: ref,
		file: site.env.file,
		partialName: site.env.partialName,
		parent: site.parent,
		depth: site.depth,
		conditional: site.conditional,
		via: site.via,
	};

	if (!target) {
		// Unknown custom element: rendered as a raw tag with the call-site attrs,
		// its default slot in the caller's environment (render.ts `node.unresolved`).
		const node = makeNode(ctx, {
			...common, body: ref.slots['default'] ?? [], env: site.env, attrs: null,
		});
		if (node) out.push(node);
		return;
	}

	ctx.visited.add(target);
	const node = makeNode(ctx, {
		...common,
		body: target.tnodes,
		env: calleeEnv(ref, target, site.env, ctx),
		attrs: mergedAttrs(ref, target, ctx),
	});
	if (node) out.push(node);
}

/**
 * The environment the target partial's body expands under: its own file and
 * name, and a slot map binding the call's fills to the environment they were
 * written in. Mirrors `SlotMap` in `runtime/js/render.ts`.
 */
function calleeEnv(ref: PartialRefTNode, target: RootTNode, env: Env, ctx: ExpandCtx): Env {
	const slots: { [slotName: string]: SlotEntry } = {};
	for (const [name, tnodes] of Object.entries(ref.slots)) slots[name] = { tnodes, env };
	const info = ctx.rootInfo.get(target);
	return { slots, file: info?.file ?? env.file, partialName: info?.name ?? ref.partialName };
}

/**
 * One tag is rendered for a custom-element call, its attributes being the
 * call-site ones followed by the definition's (`render.ts` emits them in that
 * order, and the first of a duplicate wins).
 */
function mergedAttrs(ref: CustomElementCallTNode, target: RootTNode, ctx: ExpandCtx): AttrIndex {
	let index = ctx.mergedAttrs.get(ref);
	if (!index) {
		const definition = target.kind === 'custom-element' ? target.definitionAttrs ?? [] : [];
		index = buildAttrIndex([...(ref.callerAttrs ?? []), ...definition]);
		ctx.mergedAttrs.set(ref, index);
	}
	return index;
}

// --- Navigation ---

/** This instance's children, expanded on first ask and memoized thereafter. */
export function childrenOf(n: InstanceNode, ctx: ExpandCtx): InstanceNode[] {
	if (n._children) return n._children;
	const out: InstanceNode[] = [];
	// An element boundary resets conditionality: only the tag carrying the b-if
	// is conditional, not everything below it.
	if (n.depth < MAX_DEPTH) {
		expandList(n.body, {
			env: n.env, parent: n, depth: n.depth + 1,
			splice: 0, conditional: false, via: 'element',
		}, out, ctx);
	}
	n._children = out;
	return out;
}

/** The child list this instance belongs to. Same array as `childrenOf(parent)`. */
export function siblingsOf(n: InstanceNode, ctx: ExpandCtx): InstanceNode[] {
	if (n.parent) return childrenOf(n.parent, ctx);
	return n._roots ?? (n._roots = [n]);
}

/** The attribute lookup for this instance. */
export function attrsOf(n: InstanceNode): AttrIndex {
	return n.attrs ?? attrIndexOf(n.tnode);
}

// --- Roots ---

/**
 * Expand one partial standalone, against an empty environment.
 *
 * A `named` root's own `b-name` tag is already an `ElementTNode` among its
 * tnodes (or absent, for `<b-unwrap b-name>`). A `custom-element` root's tag is
 * rendered by the *call site*, so its tnodes carry no wrapper — with no call
 * site to render it, the tag is synthesized here, or the partial would lose its
 * own outermost element.
 */
function expandRoot(root: RootTNode, file: string, name: string, ctx: ExpandCtx): InstanceNode[] {
	ctx.visited.add(root);
	const env: Env = { slots: {}, file, partialName: name };
	const out: InstanceNode[] = [];
	if (root.kind === 'custom-element') {
		const tag: ElementTNode = {
			type: 'element',
			tagName: name,
			attrs: root.definitionAttrs ?? [],
			tnodes: root.tnodes,
			loc: root.loc,
			openTagLoc: root.loc,
		};
		const node = makeNode(ctx, {
			tnode: tag, body: root.tnodes, env, file, partialName: name,
			parent: null, depth: 0, conditional: false, via: 'root', attrs: null,
		});
		if (node) out.push(node);
	} else {
		expandList(root.tnodes, {
			env, parent: null, depth: 0, splice: 0, conditional: false, via: 'root',
		}, out, ctx);
	}
	for (const node of out) node._roots = out;
	return out;
}

/** Every partial that some resolvable `partial-ref` targets. */
function collectReferenced(files: Map<string, CompiledFile>): Set<RootTNode> {
	const referenced = new Set<RootTNode>();
	for (const compiled of files.values()) {
		for (const root of compiled.partials.values()) {
			visitTNodes(root.tnodes, (n) => {
				if (n.type !== 'partial-ref') return;
				const target = resolvePartial(n, compiled, files);
				if (target) referenced.add(target);
			});
		}
	}
	return referenced;
}

function materialize(nodes: InstanceNode[], out: InstanceNode[], ctx: ExpandCtx): void {
	for (const node of nodes) {
		out.push(node);
		materialize(childrenOf(node, ctx), out, ctx);
	}
}

/**
 * Build the render forest for a compiled directory.
 *
 * Entry points are the partials nothing calls; everything else is reached
 * through them. A partial left with no instances after that is expanded
 * standalone as an extra root — which catches partials only reachable through a
 * reference cycle, and keeps an unused partial analysed against an empty
 * context.
 */
export function buildInstanceForest(files: Map<string, CompiledFile>): InstanceForest {
	const ctx: ExpandCtx = {
		files,
		rootInfo: new Map(),
		visited: new Set(),
		mergedAttrs: new WeakMap(),
		count: 0,
		truncated: false,
	};
	for (const [file, compiled] of files) {
		for (const [name, root] of compiled.partials) ctx.rootInfo.set(root, { file, name });
	}

	const referenced = collectReferenced(files);
	const tops: InstanceNode[] = [];
	const all: InstanceNode[] = [];
	const roots: RootSelection[] = [];

	const grow = (root: RootTNode, file: string, name: string, reason: RootSelection['reason']): void => {
		roots.push({ root, file, name, reason });
		const grown = expandRoot(root, file, name, ctx);
		tops.push(...grown);
		materialize(grown, all, ctx);
	};

	for (const [file, compiled] of files) {
		for (const [name, root] of compiled.partials) {
			if (!referenced.has(root)) grow(root, file, name, 'entry');
		}
	}
	// Anything still unvisited is reachable only through a cycle. Growing them
	// one at a time keeps a partial from being expanded twice.
	for (const [file, compiled] of files) {
		for (const [name, root] of compiled.partials) {
			if (!ctx.visited.has(root)) grow(root, file, name, 'unreached');
		}
	}

	return { tops, all, ctx, roots, truncated: ctx.truncated };
}
