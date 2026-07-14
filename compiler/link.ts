import { BackflipError } from './errors.js';
import { visitTNodes } from './walk.js';
import type {
	CompiledFile, PartialRegistry, PartialRefTNode, RootTNode, SourceLoc, PartialBinding,
} from './types.js';

/**
 * The link stage: all AST-mutating resolution that happens between compilation and
 * validation. Compilation produces per-partial trees; linking wires cross-partial
 * relationships (custom-element call targets, b-attr bindings) by mutating those
 * trees in place. Validation (partials.ts `validateRefs`) then runs strictly
 * read-only over the linked trees.
 */

function errorLoc(filename: string, loc?: SourceLoc): { filename: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
	if (!loc) return { filename };
	return { filename, line: loc.startLine, col: loc.startCol, endLine: loc.endLine, endCol: loc.endCol };
}

/**
 * Resolve the target partial's RootTNode for a partial-ref, or null if not found.
 * Shared by the link and validate stages.
 */
export function resolvePartial(
	ref: PartialRefTNode,
	compiledFile: CompiledFile,
	allFiles: Map<string, CompiledFile>,
): RootTNode | null {
	if (ref.file === null) {
		return compiledFile.partials.get(ref.partialName) ?? null;
	}
	const targetFile = allFiles.get(ref.file);
	if (!targetFile) return null;
	return targetFile.partials.get(ref.partialName) ?? null;
}

/**
 * Find an exported custom element partial with this name in the registry.
 * Returns the file path that defines it, or null.
 */
function findExportedCustomElement(
	name: string,
	registry: PartialRegistry,
): string | null {
	for (const [file, defs] of registry) {
		for (const def of defs) {
			if (def.customElement && def.exported && def.name === name) return file;
		}
	}
	return null;
}

/**
 * Resolve custom element call sites (partial-ref with customElement: true) against
 * same-file partials first, then the global exported custom-element registry.
 *
 * - Same-file: if the file defines a custom-element partial with the matching name,
 *   leave file = null (same-file reference).
 * - Cross-file: if an exported custom-element partial with this name exists in some
 *   other file, set file to that file's path.
 * - Unresolved: mark the ref's `file` to a sentinel that codegen will detect, and emit
 *   a warning. Stage 6 codegen falls back to rendering the raw tag.
 */
export function resolveCustomElementCalls(
	files: Map<string, CompiledFile>,
	registry: PartialRegistry,
): BackflipError[] {
	const warnings: BackflipError[] = [];

	for (const [filePath, compiled] of files) {
		for (const [, root] of compiled.partials) {
			visitTNodes(root.tnodes, (node) => {
				if (node.type !== 'partial-ref') return;
				const ref = node;
				if (ref.kind !== 'custom-element') return;
				if (ref.file !== null) return; // already resolved (shouldn't happen at this stage)

				const sameFilePartial = compiled.partials.get(ref.partialName);
				if (sameFilePartial && sameFilePartial.kind === 'custom-element') {
					// Resolves to same-file definition; keep file = null
					return;
				}

				const exportedFile = findExportedCustomElement(ref.partialName, registry);
				if (exportedFile && exportedFile !== filePath) {
					ref.file = exportedFile;
					return;
				}

				// Unresolved — emit a warning. Codegen treats unresolvedRaw as the fallback.
				ref.file = '__unresolved_custom_element__';
				warnings.push(new BackflipError(
					`unknown custom element <${ref.partialName}> — no matching partial found in this file or among exported custom element partials. Treating as raw HTML.`,
					{ filename: filePath, line: ref.loc?.startLine, col: ref.loc?.startCol, severity: 'warning' }
				));
			});
		}
	}

	return warnings;
}

/**
 * Link stage: synthesize b-attr bindings on custom-element call sites.
 *
 * For every custom-element partial-ref whose target declares b-attr:* directives,
 * this analyzes the caller-side attributes, synthesizes `PartialBinding`s (appended
 * to `ref.bindings`), and patches `isBoolean` on matching dynamic caller attrs so
 * the rendered attribute is suppressed when its bound expression is falsy. The
 * diagnostics it emits are *linking* errors (conflicts, missing/typed attributes),
 * so they belong here rather than in the read-only validate stage. It must run
 * before validation because the b-data-vs-data-shape check depends on the bindings
 * synthesized here.
 */
export function linkBAttrBindings(
	files: Map<string, CompiledFile>,
	_registry: PartialRegistry,
): BackflipError[] {
	const errors: BackflipError[] = [];

	for (const [sourceRelPath, compiled] of files) {
		for (const [, root] of compiled.partials) {
			visitTNodes(root.tnodes, (node) => {
				if (node.type !== 'partial-ref') return;
				const ref = node;
				if (ref.kind !== 'custom-element') return;
				if (ref.file === '__unresolved_custom_element__') return;

				const target = resolvePartial(ref, compiled, files);
				if (!target || target.kind !== 'custom-element' || !target.bAttrs || target.bAttrs.length === 0) return;

				const bAttrs = target.bAttrs;
				const bAttrNameSet = new Set(bAttrs.map(b => b.name));
				const callerInfos = ref.callerAttrInfos ?? [];
				const synthesized: PartialBinding[] = [];

				// Reject b-data:NAME on caller when target declares b-attr:NAME.
				for (const binding of ref.bindings) {
					if (bAttrNameSet.has(binding.name)) {
						errors.push(new BackflipError(
							`b-data:${binding.name} on <${ref.callerTagName}> conflicts with b-attr:${binding.name} declared on the partial definition; pass the value as an attribute instead`,
							errorLoc(sourceRelPath, ref.loc)
						));
					}
				}

				// Determine whether a 'plain' caller attribute was written bare (just `name`)
				// or with a value (`name="..."`, including empty `name=""`). parse5 reports
				// `attr.value === ''` for both, but the source-location range distinguishes
				// them: bare attrs have a location range equal to the name length.
				const isBareAttr = (caller: { name: string; value: string; loc?: SourceLoc }): boolean => {
					if (caller.value !== '') return false;
					if (!caller.loc) return true; // best effort: no loc → assume bare since value is empty
					const span = caller.loc.endOffset - caller.loc.startOffset;
					return span === caller.name.length;
				};

				for (const bAttr of bAttrs) {
					const caller = callerInfos.find(c => c.name === bAttr.name);
					if (!caller) {
						errors.push(new BackflipError(
							`b-attr "${bAttr.name}" required by custom element <${ref.partialName}> but not provided at call site`,
							errorLoc(sourceRelPath, ref.loc)
						));
						continue;
					}

					if (!bAttr.isBool) {
						// Non-bool b-attr
						if (caller.kind === 'plain' && isBareAttr(caller)) {
							errors.push(new BackflipError(
								`attribute "${bAttr.name}" on <${ref.callerTagName}> requires a string value (declared as non-bool b-attr in the partial definition)`,
								errorLoc(sourceRelPath, caller.loc ?? ref.loc)
							));
							// Even though invalid, continue and don't synthesize this one.
							continue;
						}
						// Synthesize binding
						if (caller.kind === 'plain') {
							synthesized.push({ kind: 'literal', name: bAttr.name, value: caller.value });
						} else {
							// expr
							synthesized.push({ kind: 'expr', name: bAttr.name, data: caller.expr!, cast: 'string' });
						}
					} else {
						// Bool b-attr
						if (caller.kind === 'plain' && !isBareAttr(caller)) {
							// premium="..." or premium="" — both warn (string-where-bool-expected)
							errors.push(new BackflipError(
								`attribute "${bAttr.name}" on <${ref.callerTagName}> has a string value but the partial definition declares it as bool; the value will be coerced to true`,
								{ ...(errorLoc(sourceRelPath, caller.loc ?? ref.loc) ?? { filename: sourceRelPath }), severity: 'warning' }
							));
							synthesized.push({ kind: 'literal', name: bAttr.name, value: true });
						} else if (caller.kind === 'plain') {
							// bare attribute — premium
							synthesized.push({ kind: 'literal', name: bAttr.name, value: true });
						} else {
							// expr — :premium="..."
							synthesized.push({ kind: 'expr', name: bAttr.name, data: caller.expr!, cast: 'bool' });
						}
					}
				}

				// Append synthesized bindings to ref.bindings.
				if (synthesized.length > 0) {
					ref.bindings.push(...synthesized);
				}

				// Patch caller-side AttrPart isBoolean for .bool b-attrs so that the
				// rendered attribute is suppressed when the bound expression is falsy.
				const boolBAttrNames = new Set(bAttrs.filter(b => b.isBool).map(b => b.name));
				if (boolBAttrNames.size > 0 && ref.callerAttrs) {
					for (const part of ref.callerAttrs) {
						if (part.type === 'dynamic' && boolBAttrNames.has(part.name)) {
							part.isBoolean = true;
						}
					}
				}
			});
		}
	}

	return errors;
}
