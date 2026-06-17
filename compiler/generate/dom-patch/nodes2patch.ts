import type { CompiledFile } from '../../types.js';
import { makeBfidGen, commentMarker, type BfidGen } from './bfid.js';
import { collectBackcodeSites } from './collect.js';
import { qualifies } from './filter.js';
import { ensureBfid, elementForSite, insertCommentsAround } from './mutate-ast.js';
import { generateClassForPartial, generateFile, type BfidSite } from './codegen.js';

export type { BfidGen } from './bfid.js';

export interface DomPatchResult {
	js: string | null;
}

export interface DomPatchOptions {
	bfidGen?: BfidGen;
	/**
	 * Public URL of the JS file this run produces. When set, every partial that
	 * produces a patch class is stamped with `root.scriptUrl = scriptUrl` so the
	 * renderer can auto-include the script. Partials that produce no class are
	 * left unstamped, even when they share a file with one that does.
	 */
	scriptUrl?: string;
}

export function applyDomPatch(file: CompiledFile, opts?: DomPatchOptions): DomPatchResult {
	const gen = opts?.bfidGen ?? makeBfidGen();
	const classes: string[] = [];

	for (const [partialName, root] of file.partials) {
		if (root.kind !== 'custom-element') continue;
		const bAttrs = root.bAttrs ?? [];
		const liveVarNames = new Set(bAttrs.map(b => b.name));
		if (liveVarNames.size === 0) continue;

		const sites = collectBackcodeSites(root, liveVarNames);
		const filtered = sites.filter(qualifies);
		if (filtered.length === 0) continue;

		const withBfids: BfidSite[] = [];
		for (const site of filtered) {
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
				const startId = gen();
				const endId = gen();
				insertCommentsAround(site.site.container, site.site.node, commentMarker(startId), commentMarker(endId));
				withBfids.push({ target, backcode: site, comments: { startId, endId } });
				continue;
			}
			const element = elementForSite(site);
			if (!element) continue;
			withBfids.push({ target: { kind: 'bfid-element', bfid: ensureBfid(element, gen) }, backcode: site });
		}
		if (withBfids.length === 0) continue;

		const cls = generateClassForPartial(partialName, bAttrs, withBfids);
		if (cls) {
			classes.push(cls);
			// Only partials that produce a patch class need (and get) a script URL.
			if (opts?.scriptUrl !== undefined) root.scriptUrl = opts.scriptUrl;
		}
	}

	if (classes.length === 0) return { js: null };
	return { js: generateFile(classes) };
}
