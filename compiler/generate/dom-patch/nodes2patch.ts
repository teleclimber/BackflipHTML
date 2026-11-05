import type { CompiledFile, ElementTNode, PartialStore, TNode } from '../../types.js';
import { replaceAssetRef } from '../../assets.js';
import { forBoundNames } from '../../helpers.js';
import type { Parsed } from '../../backcode.js';
import { nodeToJS } from '../js/nodes2js.js';
import { branchMarker, itemMarker, makeBfidGen, type BfidGen } from './bfid.js';
import { collectPatchTree, type BranchScope, type IfSetScope, type LoopScope } from './collect.js';
import { qualifies } from './filter.js';
import { ensureBfid, ensureOpeningMarker, ensureCallBfid, elementForSite, ensureCommentsAround } from './mutate-ast.js';
import {
	allBranches, forConstName, generateClassForPartial, generateFile, ifConstName, runtimeImportsFor,
	type BfidSite, type IfSetPatchSite, type LoopPatchSite, type PatchBranch, type PatchTarget, type RuntimeFile,
} from './codegen.js';

export type { BfidGen } from './bfid.js';
export type { RuntimeFile } from './codegen.js';

/**
 * The runtime every generated module runs on: a module imports patch.js, which
 * imports render.js, and store files import stores.js. A build copies each from the
 * package's `dist/` into the dom-patch output dir at the same relative path.
 */
export const RUNTIME_FILES: RuntimeFile[] = ['runtime/js/render.js', 'runtime/dom-patch/patch.js', 'runtime/dom-patch/flush.js', 'runtime/dom-patch/stores.js'];

/** The file a partial's module is written to, relative to the dom-patch output root. */
export function moduleFileName(tagName: string): string {
	return `${tagName}.js`;
}

/** One generated module: the client JS for a single custom-element partial. */
export interface DomPatchModule {
	/** The partial's tag name, which also names the file — see moduleFileName. */
	tagName: string;
	js: string;
}

export interface DomPatchResult {
	/** One per custom-element partial in the file that generates client JS. */
	modules: DomPatchModule[];
}

export interface DomPatchOptions {
	bfidGen?: BfidGen;
	/**
	 * Public URL of the module generated for a given partial. When it returns a URL,
	 * that partial's root is stamped with a script the renderer auto-includes: an
	 * 'entry' for `b-generate="full"` (the module registers the element itself), a
	 * 'dependency' otherwise (an author module imports it). Partials that produce no
	 * module are left untouched.
	 */
	scriptUrlFor?: (tagName: string) => string | undefined;
	/** @name → URL prefix, which turns a store's "@name/subpath" src into the URL a shell imports. */
	assetMap?: Map<string, string>;
}

export function applyDomPatch(file: CompiledFile, opts?: DomPatchOptions): DomPatchResult {
	const gen = opts?.bfidGen ?? makeBfidGen();
	const modules: DomPatchModule[] = [];

	for (const [partialName, root] of file.partials) {
		if (root.kind !== 'custom-element') continue;
		// b-generate (or b-script, which implies it) is what asks for a module; without
		// one nothing is generated, whatever the partial declares.
		const mode = root.generate;
		if (mode === undefined) continue;

		const bAttrs = root.bAttrs ?? [];
		const stores = root.stores ?? [];

		// With no declared inputs there is nothing to patch, but 'base' and 'full'
		// still owe the author a class — an empty patch-branch gives them one.
		let rootBranch: PatchBranch = { sites: [], sets: [], loops: [], vars: [] };
		if (bAttrs.length > 0 || stores.length > 0) {
			// Walk into a scope tree (qualification folded in — the tree's shape depends
			// on which sets and loops qualify).
			const scope = collectPatchTree(root, qualifies);

			// Pass 1 — all AST mutation, every scope at every depth: allocate bfids and
			// splice in every marker pair (attr/print/if-set/loop), building the PatchBranch tree
			// with ids and targets filled in. No snapshots yet.
			rootBranch = buildPatchBranch(scope, gen);

			// Pass 2 — snapshots, now that every marker at every depth is in the tree.
			fillSnapshots(rootBranch);

			assertDeclared(rootBranch, new Set([...bAttrs, ...stores].map(d => d.name)), partialName);
		}

		// A store the generated code reads ships with every page that renders the partial,
		// and the shell imports its file. One with no src is the compiler's unserved-store
		// error; it is left out.
		const read = new Set(allBranches(rootBranch).flatMap(b => b.vars));
		const shipped = stores.filter((s): s is PartialStore & { src: string } => s.src !== undefined && read.has(s.name));
		const storeImports = shipped.map(s => ({ name: s.name, url: replaceAssetRef(s.src, opts?.assetMap ?? new Map()) }));

		const cls = generateClassForPartial(partialName, bAttrs, rootBranch, mode, shipped.map(s => s.name));
		if (!cls) continue;
		for (const store of shipped) store.shipped = true;

		modules.push({ tagName: partialName, js: generateFile([cls], runtimeImportsFor(mode), storeImports) });

		// Only partials that produce a module get a script. 'full' registers the element
		// itself, so its module is an executed entry; otherwise an author module imports it.
		const url = opts?.scriptUrlFor?.(partialName);
		if (url !== undefined) {
			const kind = mode === 'full' ? 'entry' : 'dependency';
			root.scripts ??= [];
			if (!root.scripts.some(s => s.url === url && s.kind === kind)) {
				root.scripts.push({ url, kind });
			}
		}
	}

	return { modules };
}

// Pass 1: turn a scope into a PatchBranch, allocating bfids/markers for its own
// sites, sets and loops and, recursively, for every descendant branch — before any
// snapshot is taken. `bound` holds the names the enclosing loops bind.
function buildPatchBranch(scope: BranchScope, gen: BfidGen, bound: Set<string> = new Set()): PatchBranch {
	const sites = scope.sites.map(s => toBfidSite(s, scope.refElement, gen));
	const sets = scope.sets.map(ss => toIfSetPatchSite(ss, scope.refElement, gen, bound));
	const loops = scope.loops.map(ls => toLoopPatchSite(ls, scope.refElement, gen, bound));
	return { sites, sets, loops, vars: computeVars(sites, sets, loops, bound) };
}

function toBfidSite(
	site: BranchScope['sites'][number],
	refElement: ElementTNode | null,
	gen: BfidGen,
): BfidSite {
	// A caller-attr site's anchor is the nested call's rendered element, not an
	// ElementTNode — it always resolves to a descendant (never the ref element), so
	// stamp the call's callerAttrs directly instead of going through resolveTarget.
	if (site.site.kind === 'caller-attr-expr') {
		return { target: { kind: 'bfid-element', bfid: ensureCallBfid(site.site.ref, gen) }, backcode: site };
	}
	const target = resolveTarget(elementForSite(site), refElement, gen);
	if (site.site.kind === 'print') {
		const comments = ensureCommentsAround(site.site.container, site.site.node, gen);
		return { target, backcode: site, comments };
	}
	return { target, backcode: site };
}

function toIfSetPatchSite(
	scope: IfSetScope,
	refElement: ElementTNode | null,
	gen: BfidGen,
	bound: Set<string>,
): IfSetPatchSite {
	const set = scope.set;
	const target = resolveTarget(elementForSite(set), refElement, gen);
	const { startId: setId, endId } = ensureCommentsAround(set.container, set.node, gen);
	// Before the branches' own sites, so the branch marker stays first in its content.
	set.node.branches.forEach((b, i) => ensureOpeningMarker(b, branchMarker(setId, i)));
	// A branch with nothing patchable gets no descriptor.
	const branches = scope.branches.map(child =>
		child.sites.length === 0 && child.sets.length === 0 && child.loops.length === 0 ? null : buildPatchBranch(child, gen, bound));
	const subtreeVars: string[] = [];
	for (const b of set.node.branches) walkSubtreeVars(b.tnodes, bound, subtreeVars);
	return { target, ifSet: set, setId, endId, snapshot: '', subtreeVars, branches };
}

function toLoopPatchSite(
	scope: LoopScope,
	refElement: ElementTNode | null,
	gen: BfidGen,
	bound: Set<string>,
): LoopPatchSite {
	const loop = scope.loop;
	const target = resolveTarget(elementForSite(loop), refElement, gen);
	const { startId: loopId, endId } = ensureCommentsAround(loop.container, loop.node, gen);
	// Before the item's own sites, so the item marker stays first in its content.
	ensureOpeningMarker(loop.node, itemMarker(loopId));
	const subtreeVars: string[] = [];
	walkSubtreeVars([loop.node], bound, subtreeVars);
	const item = buildPatchBranch(scope.item, gen, new Set([...bound, ...forBoundNames(loop.node)]));
	return { target, loop, loopId, endId, snapshot: '', subtreeVars, item };
}

// A site's DOM node is either the patch-branch's own ref element or a descendant
// found by bfid. `anchor === refElement` (both null counts) means the former.
function resolveTarget(
	anchor: ElementTNode | null,
	refElement: ElementTNode | null,
	gen: BfidGen,
): PatchTarget {
	if (anchor === refElement) return { kind: 'ref-element' };
	return { kind: 'bfid-element', bfid: ensureBfid(anchor!, gen) };
}

// Pass 2: snapshot every set and loop in the tree. A literal names each qualifying set
// and loop nested in it (by its `bfif_` or `bffor_` const) instead of repeating its content.
function fillSnapshots(root: PatchBranch): void {
	const branches = allBranches(root);
	const sets = branches.flatMap(b => b.sets);
	const loops = branches.flatMap(b => b.loops);
	const names = new Map<TNode, string>([
		...sets.map((s): [TNode, string] => [s.ifSet.node, ifConstName(s.setId)]),
		...loops.map((l): [TNode, string] => [l.loop.node, forConstName(l.loopId)]),
	]);
	const snapshot = (own: TNode) => {
		const ref = (n: TNode) => n === own ? undefined : names.get(n);
		return nodeToJS(own, { ifRef: ref, forRef: ref });
	};
	for (const s of sets) s.snapshot = snapshot(s.ifSet.node);
	for (const l of loops) l.snapshot = snapshot(l.loop.node);
}

// Guard the invariant this module is built on: the compiler rejects a partial that
// generates client JS and reads anything it does not declare, so every var reaching
// codegen is one the shell reads off the element. Nothing downstream re-checks it — a name
// that slipped through would compile into a patch writing `undefined` into the page,
// so it fails here instead.
function assertDeclared(branch: PatchBranch, declared: Set<string>, partialName: string): void {
	for (const v of branch.vars) {
		if (!declared.has(v)) {
			throw new Error(`dom-patch: <${partialName}> patches on "${v}", which is not a declared b-attr or b-store`);
		}
	}
	for (const s of branch.sets) {
		for (const child of s.branches) {
			if (child) assertDeclared(child, declared, partialName);
		}
	}
	for (const l of branch.loops) assertDeclared(l.item, declared, partialName);
}

// PatchBranch.vars, first-seen: site live vars, then each set's condition and
// subtree vars, then each loop's subtree vars. Names an enclosing loop binds are left out.
function computeVars(sites: BfidSite[], sets: IfSetPatchSite[], loops: LoopPatchSite[], bound: Set<string>): string[] {
	const out: string[] = [];
	const note = (v: string) => { if (!bound.has(v) && !out.includes(v)) out.push(v); };
	for (const s of sites) for (const v of s.backcode.liveVars) note(v);
	for (const s of sets) {
		for (const v of s.ifSet.liveVars) note(v);
		for (const v of s.subtreeVars) note(v);
	}
	for (const l of loops) for (const v of l.subtreeVars) note(v);
	return out;
}

// Vars referenced anywhere in `tnodes` (nested conditions, b-for iterables and keys
// included), minus names in `scope` — those are bound by a loop, not supplied by the
// element. Deliberately over-broad per the spec: a var in a non-patchable position
// still yields a no-op mutate.
function walkSubtreeVars(
	tnodes: TNode[],
	scope: Set<string>,
	out: string[],
): void {
	const add = (p: Parsed, names = scope) => {
		for (const v of p.vars) {
			if (!names.has(v) && !out.includes(v)) out.push(v);
		}
	};
	for (const n of tnodes) {
		switch (n.type) {
			case 'print':
				add(n.data);
				break;
			case 'element':
				for (const a of n.attrs) if (a.type === 'dynamic') add(a.expr);
				walkSubtreeVars(n.tnodes, scope, out);
				break;
			case 'attr-bind':
				for (const a of n.attrs) if (a.type === 'dynamic') add(a.expr);
				break;
			case 'for': {
				add(n.iterable);
				const inner = new Set([...scope, ...forBoundNames(n)]);
				if (n.key) add(n.key, inner);
				walkSubtreeVars(n.tnodes, inner, out);
				break;
			}
			case 'if':
				for (const b of n.branches) {
					if (b.condition) add(b.condition);
					walkSubtreeVars(b.tnodes, scope, out);
				}
				break;
		}
	}
}
