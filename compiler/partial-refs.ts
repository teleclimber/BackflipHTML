import { buildPartialGraph, partialKey } from './partial-graph.js';
import type { CompiledFile, SourceLoc } from './types.js';

/**
 * The partial-to-partial call graph, flattened to one entry per call site.
 *
 * A `PartialRefTNode` names the partial being called but not the partial it
 * sits inside, and nothing in the tree says which definition the call resolves
 * to. Answering "what references this partial?" needs both ends, so they are
 * recorded together here — once, for every tool that asks.
 *
 * This is the flat view of `partial-graph.ts`: same walk, same resolution, no
 * nesting. Consumers that need the shape of the relation — what a call fills,
 * what a partial declares — read the graph instead.
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
	/** Key of the definition the call resolves to, null when it resolves to none. */
	target: string | null;
	loc?: SourceLoc;
	dataBindings: string[];
	slotsFilled: string[];
}

/**
 * Every partial call site in a compiled directory, in file, then definition,
 * then depth-first source order.
 *
 * Slot content belongs to the caller's tree, so a call written inside slot
 * content is attributed to the partial that wrote it.
 */
export function collectRefSites(files: Map<string, CompiledFile>): PartialRefSite[] {
	return buildPartialGraph(files).calls.map(call => ({
		file: call.file,
		fromPartial: call.fromPartial,
		partialName: call.partialName,
		targetFile: call.targetFile,
		target: call.target,
		loc: call.loc,
		dataBindings: call.dataBindings,
		slotsFilled: [...call.fills.keys()],
	}));
}

/**
 * The call sites that resolve to the definition of `partialName` in `defFile`.
 *
 * A call the linker could not resolve — a custom element with no definition —
 * resolves to nothing and so counts against nothing.
 *
 * One entry per call site: a caller that calls the same partial eight times
 * yields eight.
 */
export function refSitesFor(
	sites: PartialRefSite[],
	partialName: string,
	defFile: string,
): PartialRefSite[] {
	const key = partialKey(defFile, partialName);
	return sites.filter(site => site.target === key);
}
