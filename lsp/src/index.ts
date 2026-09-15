import { collectSlots, collectRefSites, inferDataShape, inferFreeVars, parseBPartValue } from '@backflip/html';
import type { CompiledDirectory, RootTNode, SourceLoc, DataShape, PartialRefSite } from '@backflip/html';
import type { CallSiteTag } from './tag-context.js';

export interface PartialDef {
	file: string;
	name: string;
	/**
	 * The definition's *name* span: the `b-name="..."` attribute for a named
	 * partial, the whole open tag for a custom element one. Not the definition's
	 * extent — see `extent`.
	 */
	loc?: SourceLoc;
	/**
	 * The definition's full extent, opening `<` through the end of the closing
	 * tag, as 0-based file offsets (end exclusive). Offsets rather than
	 * line/col because that is all `PartialMeta` carries; convert with
	 * `TextDocument.positionAt`.
	 *
	 * Absent when the compiler never resolved the extent — an unclosed
	 * definition leaves `meta.endOffset` at its start.
	 */
	extent?: { startOffset: number; endOffset: number };
	exported: boolean;
	slots: string[];
	freeVars: string[];
	dataShape?: Map<string, DataShape>;
	customElement: boolean;
	bAttrs?: { name: string; isBool: boolean }[];
}

/**
 * One indexed `b-part` / custom-element call site. The compiler's type: the
 * editor counts the same references the preview does and the generated output
 * resolves.
 */
export type PartialRef = PartialRefSite;

export interface ProjectIndex {
	partialDefs: Map<string, PartialDef[]>; // key: partial name
	partialRefs: PartialRef[];
}

export function buildIndex(directory: CompiledDirectory): ProjectIndex {
	const partialDefs = new Map<string, PartialDef[]>();
	const partialRefs = collectRefSites(directory.files);

	for (const [filePath, compiledFile] of directory.files) {
		for (const [name, root] of compiledFile.partials) {
			const slots = collectSlots(root.tnodes);
			const def: PartialDef = {
				file: filePath,
				name,
				loc: root.loc,
				extent: partialExtent(root),
				exported: root.exported ?? false,
				slots,
				freeVars: inferFreeVars(root),
				dataShape: inferDataShape(root),
				customElement: root.kind === 'custom-element',
				bAttrs: root.kind === 'custom-element' ? root.bAttrs?.map(a => ({ name: a.name, isBool: a.isBool })) : undefined,
			};
			const existing = partialDefs.get(name);
			if (existing) {
				existing.push(def);
			} else {
				partialDefs.set(name, [def]);
			}
		}
	}

	return { partialDefs, partialRefs };
}

/**
 * The definition's extent from its `PartialMeta`, or undefined when the
 * compiler could not determine one. `lowerNamedDefinition` seeds `endOffset`
 * at `startOffset` and only overwrites it once the closing tag is found, so a
 * non-advancing end means "unknown" rather than "empty".
 */
function partialExtent(root: RootTNode): { startOffset: number; endOffset: number } | undefined {
	const meta = root.meta;
	if (!meta || meta.endOffset <= meta.startOffset) return undefined;
	return { startOffset: meta.startOffset, endOffset: meta.endOffset };
}

/**
 * The definition a `b-part` value names, from the file it was written in.
 *
 * `targetFile` is what the value named, or null for a same-file reference —
 * `parseBPartValue`'s two cases.
 */
export function resolvePartialDef(
	partialName: string,
	targetFile: string | null,
	sourceFile: string,
	index: ProjectIndex,
): PartialDef | null {
	const defs = index.partialDefs.get(partialName);
	if (!defs || defs.length === 0) return null;
	const resolvedFile = targetFile ?? sourceFile;
	return defs.find(d => d.file === resolvedFile) ?? null;
}

/**
 * The custom element partial a `<tag>` in `fromFile` resolves to, following the
 * compiler's precedence: a definition in the same file wins, otherwise the
 * exported one. Without a file to resolve from, only an exported definition
 * answers — an unexported name is visible to its own file alone.
 */
export function visibleCustomElementDef(
	tagName: string,
	fromFile: string | null,
	index: ProjectIndex,
): PartialDef | null {
	const defs = index.partialDefs.get(tagName)?.filter(d => d.customElement);
	if (!defs || defs.length === 0) return null;
	return defs.find(d => d.file === fromFile) ?? defs.find(d => d.exported) ?? null;
}

/** Every custom element partial a call in `fromFile` can name. */
export function visibleCustomElementDefs(fromFile: string, index: ProjectIndex): PartialDef[] {
	const visible: PartialDef[] = [];
	for (const tagName of index.partialDefs.keys()) {
		const def = visibleCustomElementDef(tagName, fromFile, index);
		if (def) visible.push(def);
	}
	return visible;
}

/** Every partial defined in `file`, which a same-file `b-part` can name. */
export function partialsInFile(file: string, index: ProjectIndex): PartialDef[] {
	const defs: PartialDef[] = [];
	for (const group of index.partialDefs.values()) {
		for (const def of group) {
			if (def.file === file) defs.push(def);
		}
	}
	return defs;
}

/** Every exported partial, which a cross-file `b-part` can name. */
export function exportedPartials(index: ProjectIndex): PartialDef[] {
	const defs: PartialDef[] = [];
	for (const group of index.partialDefs.values()) {
		for (const def of group) {
			if (def.exported) defs.push(def);
		}
	}
	return defs;
}

/**
 * The partial a call-site tag names, and its definition when one is indexed.
 * The two call forms resolve differently: a `b-part` value names a file (or the
 * one it is written in), while a custom element name resolves by visibility.
 */
export function resolveCallTarget(
	call: CallSiteTag, sourceFile: string, index: ProjectIndex,
): { partialName: string; def: PartialDef | null } {
	if (call.bPartValue !== null) {
		const { partialName, file: targetFile } = parseBPartValue(call.bPartValue);
		return { partialName, def: resolvePartialDef(partialName, targetFile, sourceFile, index) };
	}
	return { partialName: call.tagName, def: visibleCustomElementDef(call.tagName, sourceFile, index) };
}
