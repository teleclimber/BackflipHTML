import { visitTNodes } from './walk.js';
import { resolvePartial } from './link.js';
import { collectSlots } from './helpers.js';
import type { CompiledFile, RootTNode, SourceLoc, TNode } from './types.js';

/**
 * The partial-to-partial call graph.
 *
 * One walk, one resolution rule, for every tool that asks how partials relate:
 * which partials a definition calls, what calls it, which ones nothing calls,
 * and where a call's slot content sits. A second walk is a graph the editor,
 * the preview and the CSS analyzer can disagree about, so new consumers route
 * through here.
 *
 * Structure follows the *authoring* tree: a call's slot fills are written in
 * the caller, so they hang off the call, not off the definition it names.
 * Where that content renders is the reader's job — see `preview/usage-tree.ts`,
 * which lays a call's fills into the callee's declared slots.
 */

/** Identifies one partial definition. */
export function partialKey(file: string, name: string): string {
	return `${file}#${name}`;
}

/** A `b-part` / custom-element call site. */
export interface PartialCall {
	kind: 'call';
	/** File the call is written in. */
	file: string;
	/** Partial the call is written inside. */
	fromPartial: string;
	/** Partial being called. */
	partialName: string;
	/** File the call names, or null when it names none (a same-file call). */
	targetFile: string | null;
	/** Key of the definition the call resolves to, null when it resolves to none. */
	target: string | null;
	loc?: SourceLoc;
	dataBindings: string[];
	/** What the call writes into each slot, keyed by slot name. */
	fills: Map<string, SlotFill>;
}

/** What one call writes into one slot. */
export interface SlotFill {
	/** The calls and slot declarations in the fill, in source order. */
	items: PartialBodyItem[];
	/**
	 * The fill has content of some kind. Text and elements are content but are
	 * not items, and a call with no body still carries an empty default fill,
	 * so item count alone does not say whether a slot was given anything.
	 * Whitespace between tags is not content: it is indentation.
	 */
	hasContent: boolean;
}

/** A `b-slot` declaration: where a fill renders. */
export interface SlotDecl {
	kind: 'slot';
	name: string;
}

export type PartialBodyItem = PartialCall | SlotDecl;

export interface PartialGraphNode {
	key: string;
	file: string;
	name: string;
	root: RootTNode;
	/**
	 * Calls and slot declarations written at this level, in source order.
	 * Element, `b-if` and `b-for` nesting is flattened away; a call written
	 * inside another call's fill belongs to that call instead.
	 */
	body: PartialBodyItem[];
	/** Slot names this partial declares, in source order, without repeats. */
	slots: string[];
	/** Every call that resolves here. One entry per call site. */
	callers: PartialCall[];
	/** Nothing calls this partial. */
	isEntry: boolean;
	/** No entry point reaches this partial — it is only called from a cycle. */
	isUnreached: boolean;
}

export interface PartialGraph {
	/** Every definition, keyed by `partialKey`, in file then definition order. */
	nodes: Map<string, PartialGraphNode>;
	/** Every call site, in file, then definition, then depth-first source order. */
	calls: PartialCall[];
	/** The roots some resolvable call targets. */
	referenced: Set<RootTNode>;
	/** Keys of the partials nothing calls. */
	entries: string[];
	/** Keys of the partials no entry reaches. */
	unreached: string[];
}

interface ScanCtx {
	file: string;
	fromPartial: string;
	compiled: CompiledFile;
	files: Map<string, CompiledFile>;
	keyOf: Map<RootTNode, string>;
	referenced: Set<RootTNode>;
	calls: PartialCall[];
}

/**
 * The calls and slot declarations in one body, in source order.
 *
 * The walk stops at a call and recurses into its fills separately, so a call
 * written inside slot content is recorded under the slot it fills rather than
 * flattened onto the partial that wrote it. `ctx.calls` still receives every
 * call in plain pre-order.
 */
function scanBody(tnodes: TNode[], ctx: ScanCtx): PartialBodyItem[] {
	const items: PartialBodyItem[] = [];
	visitTNodes(tnodes, (n) => {
		if (n.type === 'slot') {
			items.push({ kind: 'slot', name: n.name ?? 'default' });
			return;
		}
		if (n.type !== 'partial-ref') return;
		const target = resolvePartial(n, ctx.compiled, ctx.files);
		if (target) ctx.referenced.add(target);
		const call: PartialCall = {
			kind: 'call',
			file: ctx.file,
			fromPartial: ctx.fromPartial,
			partialName: n.partialName,
			targetFile: n.file,
			target: target ? ctx.keyOf.get(target) ?? null : null,
			loc: n.loc,
			dataBindings: n.bindings.map(b => b.name),
			fills: new Map(),
		};
		ctx.calls.push(call);
		items.push(call);
		for (const [slotName, fill] of Object.entries(n.slots)) {
			call.fills.set(slotName, { items: scanBody(fill, ctx), hasContent: hasContent(fill) });
		}
	}, { enterSlotFills: false });
	return items;
}

/** Whether a slot fill was given anything but indentation. */
function hasContent(tnodes: TNode[]): boolean {
	return tnodes.some(n => n.type !== 'raw' || n.raw.trim() !== '');
}

/** Every call in `items`, including those nested in a call's fills. */
export function callsIn(items: PartialBodyItem[]): PartialCall[] {
	const out: PartialCall[] = [];
	for (const item of items) {
		if (item.kind !== 'call') continue;
		out.push(item);
		for (const fill of item.fills.values()) out.push(...callsIn(fill.items));
	}
	return out;
}

/** Build the call graph for a compiled directory. */
export function buildPartialGraph(files: Map<string, CompiledFile>): PartialGraph {
	const keyOf = new Map<RootTNode, string>();
	for (const [file, compiled] of files) {
		for (const [name, root] of compiled.partials) keyOf.set(root, partialKey(file, name));
	}

	const nodes = new Map<string, PartialGraphNode>();
	const calls: PartialCall[] = [];
	const referenced = new Set<RootTNode>();

	for (const [file, compiled] of files) {
		for (const [name, root] of compiled.partials) {
			const body = scanBody(root.tnodes, { file, fromPartial: name, compiled, files, keyOf, referenced, calls });
			const slots: string[] = [];
			for (const slot of collectSlots(root.tnodes)) {
				if (!slots.includes(slot)) slots.push(slot);
			}
			nodes.set(partialKey(file, name), {
				key: partialKey(file, name), file, name, root, body, slots,
				callers: [], isEntry: false, isUnreached: false,
			});
		}
	}

	for (const call of calls) {
		if (call.target === null) continue;
		nodes.get(call.target)?.callers.push(call);
	}

	const entries: string[] = [];
	for (const node of nodes.values()) {
		node.isEntry = node.callers.length === 0;
		if (node.isEntry) entries.push(node.key);
	}

	// Anything an entry point does not reach is called only from a cycle.
	const reached = new Set<string>();
	const reach = (key: string): void => {
		if (reached.has(key)) return;
		reached.add(key);
		const node = nodes.get(key);
		if (!node) return;
		for (const call of callsIn(node.body)) {
			if (call.target) reach(call.target);
		}
	};
	for (const key of entries) reach(key);

	const unreached: string[] = [];
	for (const node of nodes.values()) {
		node.isUnreached = !reached.has(node.key);
		if (node.isUnreached) unreached.push(node.key);
	}

	return { nodes, calls, referenced, entries, unreached };
}
