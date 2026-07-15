import { BackflipError } from './errors.js';
import { buildSourceTree } from './parse-tree.js';
import { lowerSlice } from './lower.js';
import type { RootTNode, CompileOptions, PartialDef } from './types.js';
export { BackflipError };

/**
 * Compile a single partial.
 *
 * `htmlSlice` is the source for exactly one top-level partial (matching
 * `partialDef`), typically obtained by slicing complete lines `[from..to]` of
 * the source file. The very first start tag in the slice must match
 * `partialDef` (name + customElement flag); a mismatch rejects the promise.
 *
 * All `SourceLoc` values in the returned tree, all error locations, and any
 * `data-loc` strings baked into raw HTML are SLICE-RELATIVE. Callers translate
 * to file coordinates by adding `partialDef.loc.from - 1` to line numbers when
 * needed.
 *
 * Two passes: `buildSourceTree` (parse-tree.ts) turns the slice into a
 * faithful source tree with no directive knowledge; `lowerSlice` (lower.ts)
 * holds all directive semantics and produces the compiled TNode AST.
 */
export async function compilePartial(htmlSlice: string, partialDef: PartialDef, options?: CompileOptions): Promise<{ compiled: RootTNode, errors: BackflipError[] }> {
	const filename = partialDef.loc.filename;
	const { nodes } = await buildSourceTree(htmlSlice, filename);
	const { compiledFile, errors } = lowerSlice(nodes, partialDef, options, htmlSlice);

	// Validate that the slice produced exactly one partial matching partialDef.
	// A mismatch here means the caller sliced incorrectly or fed the wrong def —
	// reject so the bug surfaces loudly rather than producing garbage.
	const found = compiledFile.partials.get(partialDef.name);
	if (!found) {
		const names = Array.from(compiledFile.partials.keys());
		throw new Error(
			`compilePartial: slice did not contain expected partial "${partialDef.name}" `
			+ `(found: ${names.length === 0 ? 'none' : names.join(', ')}) in ${filename}`
		);
	}
	const isCustom = found.kind === 'custom-element';
	if (isCustom !== partialDef.customElement) {
		throw new Error(
			`compilePartial: partial "${partialDef.name}" customElement flag mismatch `
			+ `(slice: ${isCustom}, partialDef: ${partialDef.customElement}) in ${filename}`
		);
	}
	return { compiled: found, errors };
}
