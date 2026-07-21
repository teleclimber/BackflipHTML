import type { CompiledFile } from '../../types.js';
import { nodeToJS } from '../js/nodes2js.js';
import { makeBfidGen, type BfidGen } from './bfid.js';
import { collectBackcodeSites, isIfSetSite, type IfSetSite } from './collect.js';
import { qualifies } from './filter.js';
import { ensureBfid, elementForSite, ensureCommentsAround } from './mutate-ast.js';
import { generateClassForPartial, generateFile, type BfidSite, type IfSetPatchSite } from './codegen.js';

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

		const sites = collectBackcodeSites(root, liveVarNames);
		const filtered = sites.filter(s => qualifies(s, liveVarNames));
		if (filtered.length === 0) continue;

		// Pass 1 — attr/print/definition-root-attr sites: allocate bfids and splice in
		// print markers. This must complete before any if-set is snapshotted (pass 2),
		// or the client-rendered branch would lack markers the server-rendered HTML has.
		const withBfids: BfidSite[] = [];
		const ifSetSites: IfSetSite[] = [];
		for (const site of filtered) {
			if (isIfSetSite(site)) {
				ifSetSites.push(site);
				continue;
			}
			if (site.site.kind === 'definition-root-attr') {
				// Patches the custom element itself — runtime already has the reference (this.ce).
				withBfids.push({ target: { kind: 'this-element' }, backcode: site });
				continue;
			}
			if (site.site.kind === 'print') {
				// The print's parent element anchors the runtime lookup (or this.ce when
				// the print sits directly in the custom element). Two marker comments are
				// inserted as siblings so the runtime can find and replace the range.
				const parentEl = site.site.parentElement;
				const target = parentEl
					? { kind: 'bfid-element' as const, bfid: ensureBfid(parentEl, gen) }
					: { kind: 'this-element' as const };
				const comments = ensureCommentsAround(site.site.container, site.site.node, gen);
				withBfids.push({ target, backcode: site, comments });
				continue;
			}
			const element = elementForSite(site);
			if (!element) continue;
			withBfids.push({ target: { kind: 'bfid-element', bfid: ensureBfid(element, gen) }, backcode: site });
		}

		// Pass 2 — if-sets. The snapshot is taken now, after every data-bfid and print
		// marker from pass 1 is in the tree, so a client-rendered branch carries the
		// same markers as the server-rendered HTML and stays patchable.
		const ifSets: IfSetPatchSite[] = [];
		for (const site of ifSetSites) {
			const parentEl = elementForSite(site);
			const target = parentEl
				? { kind: 'bfid-element' as const, bfid: ensureBfid(parentEl, gen) }
				: { kind: 'this-element' as const };
			const { startId: setId, endId } = ensureCommentsAround(site.container, site.node, gen);
			ifSets.push({ target, ifSet: site, setId, endId, snapshot: nodeToJS(site.node) });
		}

		if (withBfids.length === 0 && ifSets.length === 0) continue;
		if (ifSets.length > 0) anyIfSet = true;

		const cls = generateClassForPartial(partialName, bAttrs, [...withBfids, ...ifSets]);
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
