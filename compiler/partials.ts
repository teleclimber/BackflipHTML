import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compileFile, collectSlots, isCustomElementTagName, type CompiledFile, type CompileOptions, type PartialRegistry, type PartialRefTNode, type RootTNode, type CustomElementRegistry, type CustomElementDef, type PartialBinding, type AttrBindTNode, BackflipError } from './compiler.js';
import { validateBAttrUsage } from './data-shape.js';

export interface CompiledDirectory {
    files: Map<string, CompiledFile>  // key: relative file path e.g. "blog/general.html"
}

/**
 * Recursively collect all .html files under `dir`, returning relative paths.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

async function collectHtmlFiles(dir: string, base: string = dir): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const sub = await collectHtmlFiles(fullPath, base);
            results.push(...sub);
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
            results.push(path.relative(base, fullPath));
        }
    }
    return results;
}

/**
 * Scan HTML source for elements that have both b-name="..." and b-export attributes.
 * Returns the set of exported partial names found in this file.
 *
 * We look for tags that contain both b-name="..." and b-export (in any order/spacing).
 * We match on a single tag's attribute span using a simple heuristic: find all
 * opening tags that contain both attributes.
 */
function scanExportedPartials(html: string): Set<string> {
    const names = new Set<string>();
    // Match opening tags that contain both b-export and b-name="..."
    // We use a regex that finds <tagName ...attrs...> where attrs contain both.
    // Strategy: find all b-name="value" occurrences and check if the enclosing tag also has b-export.
    const tagRegex = /<[a-zA-Z][^>]*\bb-name="([^"]*)"[^>]*\bb-export\b[^>]*>|<[a-zA-Z][^>]*\bb-export\b[^>]*\bb-name="([^"]*)"[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(html)) !== null) {
        const name = m[1] ?? m[2];
        if (name) names.add(name);
    }
    return names;
}

/**
 * Scan HTML source for top-level custom element partial definitions.
 *
 * A "custom element" here is a hyphenated tag name following the HTML custom element
 * convention (lowercase letter start, contains '-'), excluding b-* directive tags.
 * "Top-level" means the tag appears at depth 0 of the document — not nested inside
 * any other element. The scan is best-effort and uses a small state machine that
 * tracks tag depth, skips comments/CDATA/doctype, and respects quoted attribute values.
 */
export function scanCustomElementPartials(html: string): CustomElementDef[] {
    const results: CustomElementDef[] = [];
    let depth = 0;
    let i = 0;
    let line = 1, col = 1;

    function advanceTo(target: number) {
        while (i < target && i < html.length) {
            if (html.charCodeAt(i) === 10) { line++; col = 1; }
            else col++;
            i++;
        }
    }

    while (i < html.length) {
        const c = html.charCodeAt(i);
        if (c !== 60 /* '<' */) { advanceTo(i + 1); continue; }

        // Comment
        if (html.startsWith('<!--', i)) {
            const end = html.indexOf('-->', i + 4);
            advanceTo(end < 0 ? html.length : end + 3);
            continue;
        }
        // Doctype / CDATA-like '<!...>'
        if (html.startsWith('<!', i)) {
            const end = html.indexOf('>', i);
            advanceTo(end < 0 ? html.length : end + 1);
            continue;
        }
        // Closing tag
        if (html.startsWith('</', i)) {
            const end = html.indexOf('>', i);
            if (end < 0) break;
            depth = Math.max(0, depth - 1);
            advanceTo(end + 1);
            continue;
        }
        // Opening tag (must be followed by a letter)
        const next = html.charCodeAt(i + 1);
        const isLetter = (next >= 65 && next <= 90) || (next >= 97 && next <= 122);
        if (!isLetter) { advanceTo(i + 1); continue; }

        const tagStart = i;
        const tagStartLine = line, tagStartCol = col;

        // Find end of tag, skipping over quoted attribute values
        let j = i + 1;
        let inQuote: number = 0;
        while (j < html.length) {
            const cc = html.charCodeAt(j);
            if (inQuote) {
                if (cc === inQuote) inQuote = 0;
            } else {
                if (cc === 34 /* " */ || cc === 39 /* ' */) inQuote = cc;
                else if (cc === 62 /* > */) break;
            }
            j++;
        }
        if (j >= html.length) break;

        const tagText = html.slice(tagStart + 1, j); // excludes '<' and '>'
        const selfClosing = tagText.trimEnd().endsWith('/');
        const nameMatch = tagText.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
        const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';

        if (depth === 0 && isCustomElementTagName(tagName)) {
            const exported = /\bb-export(?:\s|=|\/?>|$)/.test(tagText);
            results.push({ name: tagName, exported, line: tagStartLine, col: tagStartCol });
        }

        advanceTo(j + 1);
        if (!selfClosing) depth++;
    }
    return results;
}

/**
 * Scan HTML source for cross-file b-part references (b-part="path/file.html#partialName").
 * Returns a set of relative file paths that this file references.
 */
function scanCrossFileRefs(html: string): Set<string> {
    const refs = new Set<string>();
    // Match b-part="something#name" where something doesn't start with #
    const refRegex = /\bb-part="([^"#][^"]*#[^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = refRegex.exec(html)) !== null) {
        const value = m[1];
        const hashIdx = value.indexOf('#');
        if (hashIdx > 0) {
            refs.add(value.slice(0, hashIdx));
        }
    }
    return refs;
}

/**
 * Detect cycles in a directed dependency graph using DFS.
 * Returns the cycle path as an array of node names if a cycle exists, or null.
 */
function findCycle(graph: Map<string, Set<string>>): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();

    for (const node of graph.keys()) {
        color.set(node, WHITE);
        parent.set(node, null);
    }

    function dfs(u: string): string[] | null {
        color.set(u, GRAY);
        const neighbors = graph.get(u) ?? new Set();
        for (const v of neighbors) {
            if (!color.has(v)) continue; // node not in graph (would be caught by validation)
            if (color.get(v) === GRAY) {
                // Found a cycle — reconstruct path
                const cycle: string[] = [v, u];
                let cur: string | null | undefined = parent.get(u);
                while (cur !== null && cur !== undefined && cur !== v) {
                    cycle.push(cur);
                    cur = parent.get(cur);
                }
                cycle.push(v);
                cycle.reverse();
                return cycle;
            }
            if (color.get(v) === WHITE) {
                parent.set(v, u);
                const result = dfs(v);
                if (result !== null) return result;
            }
        }
        color.set(u, BLACK);
        return null;
    }

    for (const node of graph.keys()) {
        if (color.get(node) === WHITE) {
            const result = dfs(node);
            if (result !== null) return result;
        }
    }
    return null;
}

interface ValidationContext {
    compiledFile: CompiledFile;
    sourceRelPath: string;
    registry: PartialRegistry;
    allFiles: Map<string, CompiledFile>;
    errors: BackflipError[];
}

/**
 * Validate PartialRefTNode references in a compiled file:
 * - Same-file partial existence
 * - Cross-file partial existence and export
 * - Slot existence (b-in references matching b-slot declarations)
 */
function validateRefs(
    compiledFile: CompiledFile,
    sourceRelPath: string,
    registry: PartialRegistry,
    allFiles: Map<string, CompiledFile>
): BackflipError[] {
    const ctx: ValidationContext = { compiledFile, sourceRelPath, registry, allFiles, errors: [] };
    for (const [, root] of compiledFile.partials) {
        validateRootTNode(root, ctx);
    }
    return ctx.errors;
}

function validateRootTNode(
    node: { tnodes: import('./compiler.ts').TNode[] },
    ctx: ValidationContext
): void {
    for (const tnode of node.tnodes) {
        validateTNode(tnode, ctx);
    }
}

function errorLoc(filename: string, loc?: import('./compiler.ts').SourceLoc): { filename: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
    if (!loc) return { filename };
    return { filename, line: loc.startLine, col: loc.startCol, endLine: loc.endLine, endCol: loc.endCol };
}

/**
 * Resolve the target partial's RootTNode for a partial-ref, or null if not found.
 */
function resolvePartial(ref: PartialRefTNode, ctx: ValidationContext): RootTNode | null {
    if (ref.file === null) {
        return ctx.compiledFile.partials.get(ref.partialName) ?? null;
    } else {
        const targetFile = ctx.allFiles.get(ref.file);
        if (!targetFile) return null;
        return targetFile.partials.get(ref.partialName) ?? null;
    }
}

function hasSlotContent(nodes: import('./compiler.ts').TNode[]): boolean {
    for (const n of nodes) {
        if (n.type === 'raw') {
            if ((n as import('./compiler.ts').RawTNode).raw.trim() !== '') return true;
        } else {
            return true;
        }
    }
    return false;
}

function validateTNode(
    tnode: import('./compiler.ts').TNode,
    ctx: ValidationContext
): void {
    if (tnode.type === 'partial-ref') {
        const ref = tnode as PartialRefTNode;

        // Custom element calls are resolved by resolveCustomElementCalls; the existence
        // check has already happened (and a warning was emitted if unresolved). Skip the
        // b-part existence check for these refs, but still validate slots below.
        const isUnresolvedCustom = ref.customElement && ref.file === '__unresolved_custom_element__';

        if (!ref.customElement) {
            // --- Validate partial existence (b-part) ---
            if (ref.file === null) {
                // Same-file reference
                if (!ctx.compiledFile.partials.has(ref.partialName)) {
                    ctx.errors.push(new BackflipError(
                        `b-part references partial "${ref.partialName}" which is not defined in this file`,
                        errorLoc(ctx.sourceRelPath, ref.loc)
                    ));
                }
            } else {
                // Cross-file reference
                if (!ctx.registry.has(ref.file)) {
                    ctx.errors.push(new BackflipError(
                        `b-part references file "${ref.file}" which does not exist in the directory`,
                        errorLoc(ctx.sourceRelPath, ref.loc)
                    ));
                } else {
                    const exportedNames = ctx.registry.get(ref.file)!;
                    if (!exportedNames.has(ref.partialName)) {
                        const targetFile = ctx.allFiles.get(ref.file);
                        const partialExistsInFile = targetFile?.partials.has(ref.partialName) ?? false;

                        if (partialExistsInFile) {
                            ctx.errors.push(new BackflipError(
                                `b-part references partial "${ref.partialName}" in file "${ref.file}", but that partial is not exported (missing b-export)`,
                                errorLoc(ctx.sourceRelPath, ref.loc)
                            ));
                        } else {
                            ctx.errors.push(new BackflipError(
                                `b-part references partial "${ref.partialName}" in file "${ref.file}", but no partial named "${ref.partialName}" exists in that file`,
                                errorLoc(ctx.sourceRelPath, ref.loc)
                            ));
                        }
                    }
                }
            }
        }

        if (isUnresolvedCustom) {
            // No target partial to validate against — recurse into slot contents and stop.
            for (const slotNodes of Object.values(ref.slots)) {
                for (const slotTNode of slotNodes) {
                    validateTNode(slotTNode, ctx);
                }
            }
            return;
        }

        // --- Validate attribute conflicts for custom element calls ---
        if (ref.customElement && ref.file !== '__unresolved_custom_element__') {
            const targetForAttrs = resolvePartial(ref, ctx);
            if (targetForAttrs && targetForAttrs.customElement && targetForAttrs.definitionAttrNames && ref.callerAttrNames) {
                const defNames = new Set(targetForAttrs.definitionAttrNames);
                for (const callerName of ref.callerAttrNames) {
                    if (defNames.has(callerName)) {
                        ctx.errors.push(new BackflipError(
                            `attribute "${callerName}" appears on both the call site <${ref.callerTagName}> and the definition of custom element partial <${ref.partialName}>; merge of conflicting attributes is not supported`,
                            errorLoc(ctx.sourceRelPath, ref.loc)
                        ));
                    }
                }
            }

            // --- Validate b-attr declarations against caller-side attributes ---
            if (targetForAttrs && targetForAttrs.customElement && targetForAttrs.bAttrs && targetForAttrs.bAttrs.length > 0) {
                const bAttrs = targetForAttrs.bAttrs;
                const bAttrNameSet = new Set(bAttrs.map(b => b.name));
                const callerInfos = ref.callerAttrInfos ?? [];
                const synthesized: PartialBinding[] = [];

                // Reject b-data:NAME on caller when target declares b-attr:NAME.
                for (const binding of ref.bindings) {
                    if (bAttrNameSet.has(binding.name)) {
                        ctx.errors.push(new BackflipError(
                            `b-data:${binding.name} on <${ref.callerTagName}> conflicts with b-attr:${binding.name} declared on the partial definition; pass the value as an attribute instead`,
                            errorLoc(ctx.sourceRelPath, ref.loc)
                        ));
                    }
                }

                // Determine whether a 'plain' caller attribute was written bare (just `name`)
                // or with a value (`name="..."`, including empty `name=""`). parse5 reports
                // `attr.value === ''` for both, but the source-location range distinguishes
                // them: bare attrs have a location range equal to the name length.
                const isBareAttr = (caller: { name: string; value: string; loc?: import('./compiler.ts').SourceLoc }): boolean => {
                    if (caller.value !== '') return false;
                    if (!caller.loc) return true; // best effort: no loc → assume bare since value is empty
                    const span = caller.loc.endOffset - caller.loc.startOffset;
                    return span === caller.name.length;
                };

                for (const bAttr of bAttrs) {
                    const caller = callerInfos.find(c => c.name === bAttr.name);
                    if (!caller) {
                        ctx.errors.push(new BackflipError(
                            `b-attr "${bAttr.name}" required by custom element <${ref.partialName}> but not provided at call site`,
                            errorLoc(ctx.sourceRelPath, ref.loc)
                        ));
                        continue;
                    }

                    if (!bAttr.isBool) {
                        // Non-bool b-attr
                        if (caller.kind === 'plain' && isBareAttr(caller)) {
                            ctx.errors.push(new BackflipError(
                                `attribute "${bAttr.name}" on <${ref.callerTagName}> requires a string value (declared as non-bool b-attr in the partial definition)`,
                                errorLoc(ctx.sourceRelPath, caller.loc ?? ref.loc)
                            ));
                            // Even though invalid, continue and don't synthesize this one.
                            continue;
                        }
                        // Synthesize binding
                        if (caller.kind === 'plain') {
                            synthesized.push({ name: bAttr.name, literal: caller.value });
                        } else {
                            // expr
                            synthesized.push({ name: bAttr.name, data: caller.expr!, cast: 'string' });
                        }
                    } else {
                        // Bool b-attr
                        if (caller.kind === 'plain' && !isBareAttr(caller)) {
                            // premium="..." or premium="" — both warn (string-where-bool-expected)
                            ctx.errors.push(new BackflipError(
                                `attribute "${bAttr.name}" on <${ref.callerTagName}> has a string value but the partial definition declares it as bool; the value will be coerced to true`,
                                { ...(errorLoc(ctx.sourceRelPath, caller.loc ?? ref.loc) ?? { filename: ctx.sourceRelPath }), severity: 'warning' }
                            ));
                            synthesized.push({ name: bAttr.name, literal: true });
                        } else if (caller.kind === 'plain') {
                            // bare attribute — premium
                            synthesized.push({ name: bAttr.name, literal: true });
                        } else {
                            // expr — :premium="..."
                            synthesized.push({ name: bAttr.name, data: caller.expr!, cast: 'bool' });
                        }
                    }
                }

                // Append synthesized bindings to ref.bindings.
                if (synthesized.length > 0) {
                    ref.bindings.push(...synthesized);
                }

                // Patch caller-side AttrBind isBoolean for .bool b-attrs so that the
                // rendered attribute is suppressed when the bound expression is falsy.
                const boolBAttrNames = new Set(bAttrs.filter(b => b.isBool).map(b => b.name));
                if (boolBAttrNames.size > 0 && ref.callerOpenTag) {
                    for (const n of ref.callerOpenTag) {
                        if (n.type !== 'attr-bind') continue;
                        const ab = n as AttrBindTNode;
                        for (const part of ab.parts) {
                            if (part.type === 'dynamic' && boolBAttrNames.has(part.name)) {
                                part.isBoolean = true;
                            }
                        }
                    }
                }
            }
        }

        // --- Validate slots ---
        const targetPartial = resolvePartial(ref, ctx);
        if (targetPartial) {
            const declaredSlots = new Set(collectSlots(targetPartial.tnodes));

            for (const slotName of Object.keys(ref.slots)) {
                const slotNodes = ref.slots[slotName];
                if (!hasSlotContent(slotNodes)) continue; // empty slot, skip

                if (!declaredSlots.has(slotName)) {
                    const loc = ref.slotLocs?.[slotName] ?? ref.loc;
                    if (slotName === 'default') {
                        ctx.errors.push(new BackflipError(
                            `default slot content provided but partial "${ref.partialName}" declares no default slot`,
                            errorLoc(ctx.sourceRelPath, loc)
                        ));
                    } else {
                        ctx.errors.push(new BackflipError(
                            `b-in references slot "${slotName}" which does not exist in partial "${ref.partialName}"`,
                            errorLoc(ctx.sourceRelPath, loc)
                        ));
                    }
                }
            }
        }

        // Validate slot contents recursively
        for (const slotNodes of Object.values(ref.slots)) {
            for (const slotTNode of slotNodes) {
                validateTNode(slotTNode, ctx);
            }
        }
    } else if (tnode.type === 'for') {
        validateRootTNode(tnode, ctx);
    } else if (tnode.type === 'if') {
        for (const branch of tnode.branches) {
            validateRootTNode(branch, ctx);
        }
    }
}

/**
 * Find an exported custom element partial with this name in the registry.
 * Returns the file path that defines it, or null.
 */
function findExportedCustomElement(
    name: string,
    registry: CustomElementRegistry
): string | null {
    for (const [file, defs] of registry) {
        for (const def of defs) {
            if (def.name === name && def.exported) return file;
        }
    }
    return null;
}

/**
 * Walk a TNode tree and call the visitor on every partial-ref node.
 */
function visitPartialRefs(
    nodes: import('./compiler.ts').TNode[],
    visit: (ref: PartialRefTNode) => void
): void {
    for (const n of nodes) {
        if (n.type === 'partial-ref') {
            visit(n as PartialRefTNode);
            for (const slotNodes of Object.values((n as PartialRefTNode).slots)) {
                visitPartialRefs(slotNodes, visit);
            }
        } else if (n.type === 'for') {
            visitPartialRefs((n as import('./compiler.ts').ForTNode).tnodes, visit);
        } else if (n.type === 'if') {
            for (const branch of (n as import('./compiler.ts').IfTNode).branches) {
                visitPartialRefs(branch.tnodes, visit);
            }
        }
    }
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
function resolveCustomElementCalls(
    files: Map<string, CompiledFile>,
    customElementRegistry: CustomElementRegistry
): BackflipError[] {
    const warnings: BackflipError[] = [];

    for (const [filePath, compiled] of files) {
        for (const [, root] of compiled.partials) {
            visitPartialRefs(root.tnodes, (ref) => {
                if (!ref.customElement) return;
                if (ref.file !== null) return; // already resolved (shouldn't happen at this stage)

                const sameFilePartial = compiled.partials.get(ref.partialName);
                if (sameFilePartial && sameFilePartial.customElement) {
                    // Resolves to same-file definition; keep file = null
                    return;
                }

                const exportedFile = findExportedCustomElement(ref.partialName, customElementRegistry);
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
 * Validate global uniqueness rules for custom element partials.
 *
 * Rule: Once a custom element partial name is exported anywhere in the directory,
 * no other definition (exported or not) of that same name is allowed in any file.
 * Two unexported definitions with the same name in different files are fine.
 */
export function validateCustomElementUniqueness(
    customElementRegistry: CustomElementRegistry
): BackflipError[] {
    const errors: BackflipError[] = [];

    // Group definitions by name across all files
    const byName = new Map<string, { file: string, def: CustomElementDef }[]>();
    for (const [file, defs] of customElementRegistry) {
        for (const def of defs) {
            const list = byName.get(def.name) ?? [];
            list.push({ file, def });
            byName.set(def.name, list);
        }
    }

    for (const [name, occurrences] of byName) {
        const exported = occurrences.filter(o => o.def.exported);
        if (exported.length === 0) continue; // all unexported: same name across files is OK

        if (occurrences.length > 1) {
            // Conflict: at least one is exported and there are other definitions
            const locs = occurrences.map(o => `${o.file}:${o.def.line ?? '?'}`).join(', ');
            for (const o of occurrences) {
                errors.push(new BackflipError(
                    `custom element partial <${name}> is exported in one file but also defined elsewhere; an exported custom element partial must be unique across the project (defined in: ${locs})`,
                    { filename: o.file, line: o.def.line, col: o.def.col }
                ));
            }
        }
    }

    return errors;
}

/**
 * Compile all HTML template files in a directory.
 *
 * Pass 1: Build the PartialRegistry by scanning all .html files for b-export attributes.
 * Cycle check: Build dependency graph and detect circular cross-file references.
 * Pass 2: Compile each file in parallel with the full registry, then validate cross-file refs.
 */
export async function compileDirectory(dir: string, options?: CompileOptions): Promise<{ directory: CompiledDirectory, errors: BackflipError[] }> {
    const allErrors: BackflipError[] = [];

    // Pass 1: collect files and build registry
    const relPaths = await collectHtmlFiles(dir);

    const fileContents = new Map<string, string>();
    const registry: PartialRegistry = new Map();
    const customElementRegistry: CustomElementRegistry = new Map();

    await Promise.all(relPaths.map(async (relPath) => {
        const absPath = path.join(dir, relPath);
        const html = await fs.readFile(absPath, 'utf-8');
        fileContents.set(relPath, html);
        const exported = scanExportedPartials(html);
        registry.set(relPath, exported);
        const customElements = scanCustomElementPartials(html);
        customElementRegistry.set(relPath, customElements);
    }));

    // Validate custom element partial uniqueness across the project
    allErrors.push(...validateCustomElementUniqueness(customElementRegistry));

    // Cycle check: build dependency graph and DFS for cycles
    const depGraph = new Map<string, Set<string>>();
    for (const relPath of relPaths) {
        const html = fileContents.get(relPath)!;
        const refs = scanCrossFileRefs(html);
        depGraph.set(relPath, refs);
    }

    const cycle = findCycle(depGraph);
    if (cycle !== null) {
        allErrors.push(new BackflipError(
            `Circular dependency detected: ${cycle.join(' -> ')}`
        ));
    }

    // Pass 2: compile all files in parallel
    const compiledPairs = await Promise.all(
        relPaths.map(async (relPath): Promise<[string, CompiledFile]> => {
            const html = fileContents.get(relPath)!;
            const { compiled, errors } = await compileFile(html, registry, relPath, options);
            allErrors.push(...errors);
            return [relPath, compiled];
        })
    );

    const files = new Map<string, CompiledFile>(compiledPairs);

    // Resolve custom element call sites against same-file partials and the global
    // exported custom-element registry. Mutates partial-ref nodes in place. May emit
    // warnings for unresolved hyphenated tags.
    allErrors.push(...resolveCustomElementCalls(files, customElementRegistry));

    // Validate references and slots
    for (const [relPath, compiled] of compiledPairs) {
        const refErrors = validateRefs(compiled, relPath, registry, files);
        allErrors.push(...refErrors);

        // Validate b-attr usage inside each custom element partial body. Errors
        // and warnings (returned by validateBAttrUsage) flow through alongside
        // the other compile-time diagnostics — same channel as the unresolved
        // custom-element warnings emitted earlier.
        for (const [, root] of compiled.partials) {
            if (root.customElement === true) {
                allErrors.push(...validateBAttrUsage(root, relPath));
            }
        }
    }

    return { directory: { files }, errors: allErrors };
}
