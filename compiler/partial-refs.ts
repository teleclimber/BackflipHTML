import { visitPartialRefs } from './walk.js';
import type { CompiledFile, SourceLoc } from './types.js';

/**
 * The partial-to-partial call graph, flattened to one entry per call site.
 *
 * A `PartialRefTNode` names the partial being called but not the partial it
 * sits inside, and nothing in the tree says which definition the call resolves
 * to. Answering "what references this partial?" needs both ends, so they are
 * recorded together here — once, for every tool that asks.
 */
export interface PartialRefSite {
	/** File the call is written in. */
	file: string;
	/** Partial the call is written inside. */
	fromPartial: string;
	/** Partial being called. */
	partialName: string;
	/** File the call names, or null when it names none (a same-file call). */
	targetFile: string | null;
	loc?: SourceLoc;
	dataBindings: string[];
	slotsFilled: string[];
}

/**
 * Every partial call site in a compiled directory, in file, then definition,
 * then depth-first source order.
 *
 * The traversal is `visitPartialRefs`, the same one codegen and `link.ts` use,
 * so the references reported here are the ones the generated output resolves.
 * Slot content belongs to the caller's tree, so a call written inside slot
 * content is attributed to the partial that wrote it.
 */
export function collectRefSites(files: Map<string, CompiledFile>): PartialRefSite[] {
	const sites: PartialRefSite[] = [];
	for (const [file, compiled] of files) {
		for (const [fromPartial, root] of compiled.partials) {
			visitPartialRefs(root.tnodes, (ref) => {
				sites.push({
					file,
					fromPartial,
					partialName: ref.partialName,
					targetFile: ref.file,
					loc: ref.loc,
					dataBindings: ref.bindings.map(b => b.name),
					slotsFilled: Object.keys(ref.slots),
				});
			});
		}
	}
	return sites;
}

/**
 * The call sites that resolve to the definition of `partialName` in `defFile`.
 *
 * Matching is by file, mirroring `resolvePartial`: a call naming no file
 * resolves within the file it was written in, one naming a file resolves
 * there. A custom-element call the linker could not resolve carries a sentinel
 * file name, which matches no definition and so counts against nothing.
 *
 * One entry per call site: a caller that calls the same partial eight times
 * yields eight.
 */
export function refSitesFor(
	sites: PartialRefSite[],
	partialName: string,
	defFile: string,
): PartialRefSite[] {
	return sites.filter(site => {
		if (site.partialName !== partialName) return false;
		return site.targetFile === null
			? site.file === defFile
			: site.targetFile === defFile;
	});
}
