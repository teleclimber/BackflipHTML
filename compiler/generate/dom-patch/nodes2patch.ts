import type { CompiledFile } from '../../types.js';
import { makeBfidGen, type BfidGen } from './bfid.js';
import { collectBackcodeSites } from './collect.js';
import { qualifies } from './filter.js';
import { ensureBfid, elementForSite } from './mutate-ast.js';
import { generateClassForPartial, generateFile, type BfidSite } from './codegen.js';

export type { BfidGen } from './bfid.js';

export interface DomPatchResult {
	js: string | null;
}

export function applyDomPatch(file: CompiledFile, bfidGen?: BfidGen): DomPatchResult {
	const gen = bfidGen ?? makeBfidGen();
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
			const element = elementForSite(site);
			if (!element) continue;
			withBfids.push({ target: { kind: 'bfid-element', bfid: ensureBfid(element, gen) }, backcode: site });
		}
		if (withBfids.length === 0) continue;

		const cls = generateClassForPartial(partialName, bAttrs, withBfids);
		if (cls) classes.push(cls);
	}

	if (classes.length === 0) return { js: null };
	return { js: generateFile(classes) };
}
