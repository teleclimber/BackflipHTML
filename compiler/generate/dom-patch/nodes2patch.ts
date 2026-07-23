import type { CompiledFile, ElementTNode, IfTNode, TNode } from '../../types.js';
import type { Parsed } from '../../backcode.js';
import { nodeToJS } from '../js/nodes2js.js';
import { makeBfidGen, type BfidGen } from './bfid.js';
import { collectPatchTree, type BranchScope, type IfSetScope } from './collect.js';
import { qualifies } from './filter.js';
import { ensureBfid, ensureCallBfid, elementForSite, ensureCommentsAround } from './mutate-ast.js';
import {
	generateClassForPartial, generateFile, patchClassNameFor,
	type BfidSite, type IfSetPatchSite, type PatchBranch, type PatchTarget,
} from './codegen.js';

export type { BfidGen } from './bfid.js';

/** Default specifier for the JS runtime's render.js, alongside the generated module. */
export const DEFAULT_RENDER_IMPORT_PATH = './render.js';

/**
 * The import specifier a generated module at `outRelPath` (relative to the
 * dom-patch output root, e.g. `foo/bar.js`) needs to reach `render.js`, which
 * the CLI copies into that root.
 */
export function renderImportPathFor(outRelPath: string): string {
	const depth = outRelPath.split('/').length - 1;
	return depth === 0 ? DEFAULT_RENDER_IMPORT_PATH : '../'.repeat(depth) + 'render.js';
}

export interface DomPatchResult {
	js: string | null;
	/**
	 * True when the generated module imports `render.js` (i.e. it contains at least
	 * one if-set). The CLI uses this to decide whether the runtime file must be
	 * copied into the output dir.
	 */
	needsRender: boolean;
}

export interface DomPatchOptions {
	bfidGen?: BfidGen;
	/**
	 * Public URL of the generated dom-patch module this run produces. When set,
	 * every partial that produces a patch class gets a `{ url, kind: 'dependency' }`
	 * entry appended to `root.scripts` so the renderer can preload it (it's imported
	 * by the partial's hand-coded entry module). Partials that produce no class are
	 * left untouched, even when they share a file with one that does.
	 */
	scriptUrl?: string;
	/**
	 * Import specifier for the JS runtime's `render.js`, used by if-sets. Depends on
	 * how deep this module sits in the dom-patch output dir — see renderImportPathFor.
	 */
	renderImportPath?: string;
}

export function applyDomPatch(file: CompiledFile, opts?: DomPatchOptions): DomPatchResult {
	const gen = opts?.bfidGen ?? makeBfidGen();
	const classes: string[] = [];
	let anyIfSet = false;

	for (const [partialName, root] of file.partials) {
		if (root.kind !== 'custom-element') continue;
		const bAttrs = root.bAttrs ?? [];
		const liveVarNames = new Set(bAttrs.map(b => b.name));
		if (liveVarNames.size === 0) continue;

		// Walk into a scope tree (qualification folded in — the tree's shape depends
		// on which sets qualify).
		const scope = collectPatchTree(root, liveVarNames, s => qualifies(s, liveVarNames));

		// Pass 1 — all AST mutation, every scope at every depth: allocate bfids and
		// splice in every marker pair (attr/print/if-set), building the PatchBranch tree
		// with ids and targets filled in. No snapshots yet.
		const rootBranch = buildPatchBranch(scope, patchClassNameFor(partialName), liveVarNames, gen);

		if (rootBranch.sites.length === 0 && rootBranch.sets.length === 0) continue;

		// Pass 2 — snapshots, now that every marker at every depth is in the tree.
		fillSnapshots(rootBranch);
		if (hasAnySet(rootBranch)) anyIfSet = true;

		const cls = generateClassForPartial(partialName, bAttrs, rootBranch);
		if (cls) {
			classes.push(cls);
			// Only partials that produce a patch class need (and get) a generated module.
			// Record it as a 'dependency' the renderer will <link rel="modulepreload">.
			if (opts?.scriptUrl !== undefined) {
				const url = opts.scriptUrl;
				root.scripts ??= [];
				if (!root.scripts.some(s => s.url === url && s.kind === 'dependency')) {
					root.scripts.push({ url, kind: 'dependency' });
				}
			}
		}
	}

	if (classes.length === 0) return { js: null, needsRender: false };
	const renderImport = anyIfSet
		? (opts?.renderImportPath ?? DEFAULT_RENDER_IMPORT_PATH)
		: undefined;
	return { js: generateFile(classes, renderImport), needsRender: anyIfSet };
}

// Pass 1: turn a scope into a PatchBranch, allocating bfids/markers for its own
// sites and sets and, recursively, for every descendant branch — before any
// snapshot is taken.
function buildPatchBranch(
	scope: BranchScope,
	className: string,
	liveVarNames: Set<string>,
	gen: BfidGen,
): PatchBranch {
	const sites = scope.sites.map(s => toBfidSite(s, scope.refElement, gen));
	const sets = scope.sets.map(ss => toIfSetPatchSite(ss, scope.refElement, liveVarNames, gen));
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
	liveVarNames: Set<string>,
	gen: BfidGen,
): IfSetPatchSite {
	const set = scope.set;
	const target = resolveTarget(elementForSite(set), refElement, gen);
	const { startId: setId, endId } = ensureCommentsAround(set.container, set.node, gen);
	// A branch with nothing patchable gets no child class.
	const branches = scope.branches.map((child, i) =>
		child.sites.length === 0 && child.sets.length === 0
			? null
			: buildPatchBranch(child, `BackflipPatch_${setId}_${i}`, liveVarNames, gen));
	return {
		target, ifSet: set, setId, endId, snapshot: '',
		subtreeVars: computeSubtreeVars(set.node, liveVarNames),
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

function hasAnySet(branch: PatchBranch): boolean {
	return branch.sets.length > 0
		|| branch.sets.some(s => s.branches.some(c => c !== null && hasAnySet(c)));
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

// Live vars referenced anywhere in the set's branch content (nested conditions and
// b-for iterables included), minus b-for-bound value names. Deliberately over-broad
// per the spec — a var in a non-patchable position still yields a no-op mutate.
function computeSubtreeVars(node: IfTNode, liveVarNames: Set<string>): string[] {
	const out: string[] = [];
	for (const b of node.branches) walkSubtreeVars(b.tnodes, liveVarNames, new Set(), out);
	return out;
}

function walkSubtreeVars(
	tnodes: TNode[],
	liveVarNames: Set<string>,
	scope: Set<string>,
	out: string[],
): void {
	const add = (p: Parsed) => {
		for (const v of p.vars) {
			if (liveVarNames.has(v) && !scope.has(v) && !out.includes(v)) out.push(v);
		}
	};
	for (const n of tnodes) {
		switch (n.type) {
			case 'print':
				add(n.data);
				break;
			case 'element':
				for (const a of n.attrs) if (a.type === 'dynamic') add(a.expr);
				walkSubtreeVars(n.tnodes, liveVarNames, scope, out);
				break;
			case 'attr-bind':
				for (const a of n.attrs) if (a.type === 'dynamic') add(a.expr);
				break;
			case 'for': {
				add(n.iterable);
				const inner = new Set(scope);
				inner.add(n.valName);
				walkSubtreeVars(n.tnodes, liveVarNames, inner, out);
				break;
			}
			case 'if':
				for (const b of n.branches) {
					if (b.condition) add(b.condition);
					walkSubtreeVars(b.tnodes, liveVarNames, scope, out);
				}
				break;
		}
	}
}
