import type { CompiledFile, ElementTNode, IfTNode, TNode } from '../../types.js';
import type { Parsed } from '../../backcode.js';
import { nodeToJS } from '../js/nodes2js.js';
import { makeBfidGen, type BfidGen } from './bfid.js';
import { collectPatchTree, type BranchScope, type IfSetScope } from './collect.js';
import { qualifies } from './filter.js';
import { ensureBfid, ensureCallBfid, elementForSite, ensureCommentsAround } from './mutate-ast.js';
import {
	generateClassForPartial, generateFile, patchClassNameFor, runtimeImportsFor,
	type BfidSite, type IfSetPatchSite, type PatchBranch, type PatchTarget, type RuntimeFile,
} from './codegen.js';

export type { BfidGen } from './bfid.js';
export type { RuntimeFile } from './codegen.js';

/**
 * Where each runtime file a module can import is built, relative to the package's
 * `dist/`. A build copies it to the dom-patch output root, beside the modules.
 */
export const RUNTIME_FILE_DIST_PATHS: Record<RuntimeFile, string> = {
	'render.js': 'runtime/js/render.js',
	'patch.js': 'runtime/dom-patch/patch.js',
};

/** The file a partial's module is written to, relative to the dom-patch output root. */
export function moduleFileName(tagName: string): string {
	return `${tagName}.js`;
}

/** One generated module: the client JS for a single custom-element partial. */
export interface DomPatchModule {
	/** The partial's tag name, which also names the file — see moduleFileName. */
	tagName: string;
	js: string;
	/** The runtime files the module imports, which must be copied alongside it. */
	runtimeFiles: RuntimeFile[];
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

		// With no declared attributes there is nothing to patch, but 'base' and 'full'
		// still owe the author a class — an empty patch-branch gives them one.
		let rootBranch: PatchBranch = { className: patchClassNameFor(partialName), sites: [], sets: [], vars: [] };
		if (bAttrs.length > 0) {
			// Walk into a scope tree (qualification folded in — the tree's shape depends
			// on which sets qualify).
			const scope = collectPatchTree(root, qualifies);

			// Pass 1 — all AST mutation, every scope at every depth: allocate bfids and
			// splice in every marker pair (attr/print/if-set), building the PatchBranch tree
			// with ids and targets filled in. No snapshots yet.
			rootBranch = buildPatchBranch(scope, patchClassNameFor(partialName), gen);

			// Pass 2 — snapshots, now that every marker at every depth is in the tree.
			fillSnapshots(rootBranch);

			assertDeclared(rootBranch, new Set(bAttrs.map(b => b.name)), partialName);
		}

		const cls = generateClassForPartial(partialName, bAttrs, rootBranch, mode);
		if (!cls) continue;

		const imports = runtimeImportsFor(rootBranch, mode);
		modules.push({ tagName: partialName, js: generateFile([cls], imports), runtimeFiles: [...imports.keys()] });

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
// sites and sets and, recursively, for every descendant branch — before any
// snapshot is taken.
function buildPatchBranch(
	scope: BranchScope,
	className: string,
	gen: BfidGen,
): PatchBranch {
	const sites = scope.sites.map(s => toBfidSite(s, scope.refElement, gen));
	const sets = scope.sets.map(ss => toIfSetPatchSite(ss, scope.refElement, gen));
	return { className, sites, sets, vars: computeVars(sites, sets) };
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
): IfSetPatchSite {
	const set = scope.set;
	const target = resolveTarget(elementForSite(set), refElement, gen);
	const { startId: setId, endId } = ensureCommentsAround(set.container, set.node, gen);
	// A branch with nothing patchable gets no child class.
	const branches = scope.branches.map((child, i) =>
		child.sites.length === 0 && child.sets.length === 0
			? null
			: buildPatchBranch(child, `BackflipPatch_${setId}_${i}`, gen));
	return {
		target, ifSet: set, setId, endId, snapshot: '',
		subtreeVars: computeSubtreeVars(set.node),
		branches,
	};
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

// Pass 2: fill in every set's snapshot depth-first, once all markers exist.
function fillSnapshots(branch: PatchBranch): void {
	for (const s of branch.sets) {
		s.snapshot = nodeToJS(s.ifSet.node);
		for (const child of s.branches) {
			if (child) fillSnapshots(child);
		}
	}
}

// Guard the invariant this module is built on: the compiler rejects a partial that
// generates client JS and reads anything it does not declare, so every var reaching
// codegen resolves through collectData(). Nothing downstream re-checks it — a name
// that slipped through would compile into a patch writing `undefined` into the page,
// so it fails here instead.
function assertDeclared(branch: PatchBranch, declared: Set<string>, partialName: string): void {
	for (const v of branch.vars) {
		if (!declared.has(v)) {
			throw new Error(`dom-patch: <${partialName}> patches on "${v}", which is not a declared b-attr`);
		}
	}
	for (const s of branch.sets) {
		for (const child of s.branches) {
			if (child) assertDeclared(child, declared, partialName);
		}
	}
}

// PatchBranch.vars, first-seen: site live vars, then each set's condition and
// subtree vars.
function computeVars(sites: BfidSite[], sets: IfSetPatchSite[]): string[] {
	const out: string[] = [];
	const note = (v: string) => { if (!out.includes(v)) out.push(v); };
	for (const s of sites) for (const v of s.backcode.liveVars) note(v);
	for (const s of sets) {
		for (const v of s.ifSet.liveVars) note(v);
		for (const v of s.subtreeVars) note(v);
	}
	return out;
}

// Vars referenced anywhere in the set's branch content (nested conditions and
// b-for iterables included), minus b-for-bound value names — those are bound by the
// loop, not supplied by the element. Deliberately over-broad per the spec: a var in
// a non-patchable position still yields a no-op mutate.
function computeSubtreeVars(node: IfTNode): string[] {
	const out: string[] = [];
	for (const b of node.branches) walkSubtreeVars(b.tnodes, new Set(), out);
	return out;
}

function walkSubtreeVars(
	tnodes: TNode[],
	scope: Set<string>,
	out: string[],
): void {
	const add = (p: Parsed) => {
		for (const v of p.vars) {
			if (!scope.has(v) && !out.includes(v)) out.push(v);
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
				const inner = new Set(scope);
				inner.add(n.valName);
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
