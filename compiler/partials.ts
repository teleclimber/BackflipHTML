import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import stream from 'node:stream';
import { RewritingStream } from 'parse5-html-rewriting-stream';
import { compilePartial } from './compiler.js';
import { collectSlots, isCustomElementTagName, parseBPartValue } from './helpers.js';
import type { CompiledFile, CompileOptions, PartialRegistry, PartialRefTNode, RootTNode, PartialDef, PartialBinding, TNode, RawTNode, SourceLoc, ForTNode, IfTNode } from './types.js';
import { BackflipError } from './errors.js';
import { validateBAttrUsage, inferDataShape } from './data-shape.js';

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

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
 * Scan HTML source for top-level partial definitions, returning a PartialDef per definition.
 *
 * A top-level element qualifies as a partial when either:
 * - it carries a b-name="..." attribute (then customElement is false), OR
 * - its tag name is a hyphenated custom-element name (per `isCustomElementTagName`), in
 *   which case customElement is true.
 *
 * Precedence matches compilePartial's dispatcher: b-name wins over the custom-element tag-
 * name check, so a `<my-card b-name="foo">` is recorded as a b-name partial.
 *
 * Uses parse5's streaming SAX rewriter so comments, doctype, quoted attribute values,
 * and self-closing/void tags are handled correctly. `sourceCodeLocationInfo` is always
 * enabled on RewritingStream, so the line/col are taken from the parser.
 */
export function scanPartials(html: string, filename: string): Promise<{ defs: PartialDef[], errors: BackflipError[] }> {
    return new Promise((resolve, reject) => {
        const defs: PartialDef[] = [];
        const errors: BackflipError[] = [];
        // Top-level elements that are neither b-name nor a custom-element tag — every
        // top-level element in a partial file must be a partial definition.
        const unnamedTopLevel: { tagName: string, line?: number, col?: number, endLine?: number, endCol?: number }[] = [];
        let depth = 0;
        let currentDef: PartialDef | null = null;  // the top-level partial currently being scanned, if any

        const rewriteStream = new RewritingStream();

        rewriteStream.on('startTag', (tag) => {
            const isContainer = !tag.selfClosing && !VOID_ELEMENTS.has(tag.tagName);

            if (depth === 0) {
                const bNameAttr = tag.attrs.find(a => a.name === 'b-name');
                const exported = tag.attrs.some(a => a.name === 'b-export');
                const loc = tag.sourceCodeLocation as { startLine?: number; startCol?: number; endLine?: number; endCol?: number } | null | undefined;
                const startLine = loc?.startLine ?? 1;
                const endLine = loc?.endLine ?? startLine;

                let def: PartialDef | null = null;
                if (bNameAttr) {
                    def = {
                        name: bNameAttr.value,
                        exported,
                        customElement: false,
                        loc: { filename, from: startLine, to: isContainer ? startLine : endLine },
                    };
                } else if (isCustomElementTagName(tag.tagName)) {
                    def = {
                        name: tag.tagName,
                        exported,
                        customElement: true,
                        loc: { filename, from: startLine, to: isContainer ? startLine : endLine },
                    };
                }

                if (def) {
                    defs.push(def);
                    if (isContainer) currentDef = def;
                } else {
                    unnamedTopLevel.push({
                        tagName: tag.tagName,
                        line: loc?.startLine,
                        col: loc?.startCol,
                        endLine: loc?.endLine,
                        endCol: loc?.endCol,
                    });
                }
            }

            if (isContainer) depth++;
        });

        rewriteStream.on('endTag', (tag) => {
            if (depth === 0) return;
            depth--;
            if (depth === 0 && currentDef) {
                const loc = tag.sourceCodeLocation as { startLine?: number } | null | undefined;
                if (loc?.startLine) currentDef.loc.to = loc.startLine;
                currentDef = null;
            }
        });

        const s = new stream.Readable({ encoding: 'utf8' });
        s.push(html);
        s.push(null);
        s.pipe(rewriteStream);

        s.on('error', reject);
        rewriteStream.on('error', reject);
        rewriteStream.on('end', () => {
            // Flag unnamed top-level elements only when the file actually defines partials —
            // a stray non-partial file isn't an error on its own.
            if (defs.length > 0 && unnamedTopLevel.length > 0) {
                for (const entry of unnamedTopLevel) {
                    errors.push(new BackflipError(
                        `top-level <${entry.tagName}> is missing b-name; in a partial file every top-level element must be a named partial`,
                        { filename, line: entry.line, col: entry.col, endLine: entry.endLine, endCol: entry.endCol }
                    ));
                }
            }
            // Detect duplicate partial names within the file.
            const seen = new Map<string, PartialDef>();
            for (const def of defs) {
                const prior = seen.get(def.name);
                if (prior) {
                    errors.push(new BackflipError(
                        def.customElement
                            ? `custom element partial <${def.name}> conflicts with another partial of the same name in this file`
                            : `partial "${def.name}" is already defined in this file`,
                        { filename, line: def.loc.from }
                    ));
                } else {
                    seen.set(def.name, def);
                }
            }
            resolve({ defs, errors });
        });
    });
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
        const { file } = parseBPartValue(m[1]);
        if (file !== null) refs.add(file);
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
    node: { tnodes: TNode[] },
    ctx: ValidationContext
): void {
    for (const tnode of node.tnodes) {
        validateTNode(tnode, ctx);
    }
}

function errorLoc(filename: string, loc?: SourceLoc): { filename: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
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

function hasSlotContent(nodes: TNode[]): boolean {
    for (const n of nodes) {
        if (n.type === 'raw') {
            if ((n as RawTNode).raw.trim() !== '') return true;
        } else {
            return true;
        }
    }
    return false;
}

function validateTNode(
    tnode: TNode,
    ctx: ValidationContext
): void {
    if (tnode.type === 'partial-ref') {
        const ref = tnode as PartialRefTNode;

        // Custom element calls are resolved by resolveCustomElementCalls; the existence
        // check has already happened (and a warning was emitted if unresolved). Skip the
        // b-part existence check for these refs, but still validate slots below.
        const isUnresolvedCustom = ref.kind === 'custom-element' && ref.file === '__unresolved_custom_element__';

        if (ref.kind !== 'custom-element') {
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
                    const defs = ctx.registry.get(ref.file)!;
                    const isExported = defs.some(d => d.name === ref.partialName && d.exported);
                    if (!isExported) {
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
        if (ref.kind === 'custom-element' && ref.file !== '__unresolved_custom_element__') {
            const targetForAttrs = resolvePartial(ref, ctx);
            if (targetForAttrs && targetForAttrs.kind === 'custom-element' && targetForAttrs.definitionAttrNames && ref.callerAttrNames) {
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
            if (targetForAttrs && targetForAttrs.kind === 'custom-element' && targetForAttrs.bAttrs && targetForAttrs.bAttrs.length > 0) {
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
                const isBareAttr = (caller: { name: string; value: string; loc?: SourceLoc }): boolean => {
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
                            synthesized.push({ kind: 'literal', name: bAttr.name, value: caller.value });
                        } else {
                            // expr
                            synthesized.push({ kind: 'expr', name: bAttr.name, data: caller.expr!, cast: 'string' });
                        }
                    } else {
                        // Bool b-attr
                        if (caller.kind === 'plain' && !isBareAttr(caller)) {
                            // premium="..." or premium="" — both warn (string-where-bool-expected)
                            ctx.errors.push(new BackflipError(
                                `attribute "${bAttr.name}" on <${ref.callerTagName}> has a string value but the partial definition declares it as bool; the value will be coerced to true`,
                                { ...(errorLoc(ctx.sourceRelPath, caller.loc ?? ref.loc) ?? { filename: ctx.sourceRelPath }), severity: 'warning' }
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

        // --- Validate b-data binding names against the target partial's data shape ---
        // Each b-data:NAME passed at the call site must correspond to a free variable
        // (or declared b-attr) that the target partial actually uses. Otherwise the
        // value would be silently discarded — almost certainly a typo or stale code.
        if (targetPartial) {
            const shape = inferDataShape(targetPartial);
            for (const binding of ref.bindings) {
                // Synthesized b-attr bindings (data + cast, or literal) carry b-attr-declared
                // names which are pre-seeded into the shape, so they always pass the check.
                if (shape.has(binding.name)) continue;
                ctx.errors.push(new BackflipError(
                    `variable ${binding.name} is unused in partial <${ref.partialName}>`,
                    errorLoc(ctx.sourceRelPath, binding.nameLoc ?? ref.loc)
                ));
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
    } else if (tnode.type === 'element') {
        validateRootTNode(tnode, ctx);
    }
}

/**
 * Find an exported custom element partial with this name in the registry.
 * Returns the file path that defines it, or null.
 */
function findExportedCustomElement(
    name: string,
    registry: PartialRegistry
): string | null {
    for (const [file, defs] of registry) {
        for (const def of defs) {
            if (def.customElement && def.exported && def.name === name) return file;
        }
    }
    return null;
}

/**
 * Walk a TNode tree and call the visitor on every partial-ref node.
 */
function visitPartialRefs(
    nodes: TNode[],
    visit: (ref: PartialRefTNode) => void
): void {
    for (const n of nodes) {
        if (n.type === 'partial-ref') {
            visit(n as PartialRefTNode);
            for (const slotNodes of Object.values((n as PartialRefTNode).slots)) {
                visitPartialRefs(slotNodes, visit);
            }
        } else if (n.type === 'for') {
            visitPartialRefs((n as ForTNode).tnodes, visit);
        } else if (n.type === 'if') {
            for (const branch of (n as IfTNode).branches) {
                visitPartialRefs(branch.tnodes, visit);
            }
        } else if (n.type === 'element') {
            visitPartialRefs(n.tnodes, visit);
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
    registry: PartialRegistry
): BackflipError[] {
    const warnings: BackflipError[] = [];

    for (const [filePath, compiled] of files) {
        for (const [, root] of compiled.partials) {
            visitPartialRefs(root.tnodes, (ref) => {
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
 * Validate global uniqueness rules for custom element partials.
 *
 * Rule: Once a custom element partial name is exported anywhere in the directory,
 * no other definition (exported or not) of that same name is allowed in any file.
 * Two unexported definitions with the same name in different files are fine.
 */
export function validateCustomElementUniqueness(
    registry: PartialRegistry
): BackflipError[] {
    const errors: BackflipError[] = [];

    // Group custom-element definitions by name across all files
    const byName = new Map<string, PartialDef[]>();
    for (const [, defs] of registry) {
        for (const def of defs) {
            if (!def.customElement) continue;
            const list = byName.get(def.name) ?? [];
            list.push(def);
            byName.set(def.name, list);
        }
    }

    for (const [name, occurrences] of byName) {
        const exported = occurrences.filter(d => d.exported);
        if (exported.length === 0) continue; // all unexported: same name across files is OK

        if (occurrences.length > 1) {
            // Conflict: at least one is exported and there are other definitions
            const locs = occurrences.map(d => `${d.loc.filename}:${d.loc.from}`).join(', ');
            for (const d of occurrences) {
                errors.push(new BackflipError(
                    `custom element partial <${name}> is exported in one file but also defined elsewhere; an exported custom element partial must be unique across the project (defined in: ${locs})`,
                    { filename: d.loc.filename, line: d.loc.from }
                ));
            }
        }
    }

    return errors;
}

/**
 * Slice complete lines [from..to] (1-based, inclusive) from `html`. Used to
 * extract a single partial's source for compilePartial. The returned slice
 * preserves trailing newlines so parse5's line tracking inside the slice lines
 * up cleanly.
 */
function sliceLines(html: string, from: number, to: number): string {
    const lines = html.split('\n');
    // Clamp to valid range (defensive — scanPartials should produce in-range loc).
    const lo = Math.max(1, from) - 1;
    const hi = Math.min(lines.length, to);
    return lines.slice(lo, hi).join('\n');
}

/**
 * Compile all HTML template files in a directory.
 *
 * Pass 1: Build the PartialRegistry by scanning all .html files for b-export attributes.
 * Cycle check: Build dependency graph and detect circular cross-file references.
 * Pass 2: For each file, slice each partial out by line range and compile it
 *         independently via compilePartial. Locs in the resulting trees and
 *         errors stay slice-relative; consumers translate via PartialDef when
 *         they need file-relative coordinates.
 */
export async function compileDirectory(dir: string, options?: CompileOptions): Promise<{ directory: CompiledDirectory, errors: BackflipError[] }> {
    const allErrors: BackflipError[] = [];

    // Pass 1: collect files and build registry
    const relPaths = await collectHtmlFiles(dir);

    const fileContents = new Map<string, string>();
    const registry: PartialRegistry = new Map();

    await Promise.all(relPaths.map(async (relPath) => {
        const absPath = path.join(dir, relPath);
        const html = await fs.readFile(absPath, 'utf-8');
        fileContents.set(relPath, html);
        const { defs, errors } = await scanPartials(html, relPath);
        registry.set(relPath, defs);
        allErrors.push(...errors);
    }));

    // Validate custom element partial uniqueness across the project
    allErrors.push(...validateCustomElementUniqueness(registry));

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

    // Pass 2: compile every partial independently. For each file, compile its
    // PartialDefs in parallel and assemble into a CompiledFile.
    const compiledPairs = await Promise.all(
        relPaths.map(async (relPath): Promise<[string, CompiledFile]> => {
            const html = fileContents.get(relPath)!;
            const defs = registry.get(relPath) ?? [];
            const compiledFile: CompiledFile = { partials: new Map() };

            // Compile all partials in this file in parallel.
            const results = await Promise.all(defs.map(async (def) => {
                const slice = sliceLines(html, def.loc.from, def.loc.to);
                try {
                    return { def, ...(await compilePartial(slice, def, options)) };
                } catch (e) {
                    // compilePartial only rejects on internal precondition violations
                    // (slice/PartialDef mismatch). Surface as an error and skip the partial.
                    const msg = e instanceof Error ? e.message : String(e);
                    allErrors.push(new BackflipError(msg, { filename: relPath }));
                    return null;
                }
            }));

            for (const r of results) {
                if (!r) continue;
                allErrors.push(...r.errors);
                // Last-write-wins on duplicate names — scanPartials already reported the dup error.
                compiledFile.partials.set(r.def.name, r.compiled);
            }
            return [relPath, compiledFile];
        })
    );

    const files = new Map<string, CompiledFile>(compiledPairs);

    // Resolve custom element call sites against same-file partials and the global
    // exported custom-element registry. Mutates partial-ref nodes in place. May emit
    // warnings for unresolved hyphenated tags.
    allErrors.push(...resolveCustomElementCalls(files, registry));

    // Validate references and slots
    for (const [relPath, compiled] of compiledPairs) {
        const refErrors = validateRefs(compiled, relPath, registry, files);
        allErrors.push(...refErrors);

        // Validate b-attr usage inside each custom element partial body. Errors
        // and warnings (returned by validateBAttrUsage) flow through alongside
        // the other compile-time diagnostics — same channel as the unresolved
        // custom-element warnings emitted earlier.
        for (const [, root] of compiled.partials) {
            if (root.kind === 'custom-element') {
                allErrors.push(...validateBAttrUsage(root, relPath));
            }
        }
    }

    return { directory: { files }, errors: allErrors };
}
