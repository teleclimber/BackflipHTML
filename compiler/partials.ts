import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import stream from 'node:stream';
import { RewritingStream } from 'parse5-html-rewriting-stream';
import { compilePartial } from './compiler.js';
import { collectSlots, isCustomElementTagName, parseBPartValue, VOID_ELEMENTS } from './helpers.js';
import { resolvePartial, resolveCustomElementCalls, linkBAttrBindings } from './link.js';
import type { CompiledFile, CompileOptions, PartialRegistry, PartialRefTNode, PartialDef, TNode, RawTNode, SourceLoc } from './types.js';
import { BackflipError } from './errors.js';
import { validateBAttrUsage, inferDataShape } from './data-shape.js';

export interface CompiledDirectory {
    files: Map<string, CompiledFile>  // key: relative file path e.g. "blog/general.html"
}

/**
 * Recursively collect all .html files under `dir`, returning relative paths.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

async function collectHtmlFiles(dir: string, base: string = dir): Promise<string[]> {
    let entries: Dirent<string>[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
        // A missing directory (e.g. a template root that hasn't been created yet,
        // or a subdirectory removed mid-scan) contributes no files rather than
        // crashing the caller. Watch-based tools rely on this to start and then
        // pick the directory up once it appears.
        if (err?.code === 'ENOENT') return [];
        throw err;
    }
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
 *
 * Coordinate space: this scan runs over FULL file contents (not slices), so all
 * sourceCodeLocation reads here are file-relative already — no locBase applies.
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
 *
 * No-mutation contract: this pass (and `validateTNode` below) is strictly
 * read-only over the AST. All resolution/mutation (custom-element call target
 * resolution and b-attr binding synthesis) happens earlier, in the link stage
 * (link.ts). Do not add AST mutation here — validators only read and report.
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
            const targetForAttrs = resolvePartial(ref, ctx.compiledFile, ctx.allFiles);
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
            // b-attr binding synthesis and the associated diagnostics have moved to
            // the link stage (link.ts `linkBAttrBindings`); by the time validation
            // runs, ref.bindings already carries the synthesized bindings.
        }

        // --- Validate slots ---
        const targetPartial = resolvePartial(ref, ctx.compiledFile, ctx.allFiles);
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
 * up cleanly. `startOffset` is the char offset of the slice's first character
 * in `html` (the sum of the lengths + newlines of the lines before `from`),
 * used as the offset part of the compile `locBase`.
 */
function sliceLines(html: string, from: number, to: number): { slice: string, startOffset: number } {
    const lines = html.split('\n');
    // Clamp to valid range (defensive — scanPartials should produce in-range loc).
    const lo = Math.max(1, from) - 1;
    const hi = Math.min(lines.length, to);
    let startOffset = 0;
    for (let i = 0; i < lo; i++) startOffset += lines[i].length + 1; // +1 for the '\n'
    return { slice: lines.slice(lo, hi).join('\n'), startOffset };
}

/**
 * Compile all HTML template files in a directory.
 *
 * Pass 1: Build the PartialRegistry by scanning all .html files for b-export attributes.
 * Cycle check: Build dependency graph and detect circular cross-file references.
 * Pass 2: For each file, slice each partial out by line range and compile it
 *         independently via compilePartial, passing a `locBase` for the slice's
 *         position. All coordinates in the resulting trees, errors, root.meta,
 *         and data-loc strings are file-relative.
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

            // Compile all partials in this file in parallel. Each compile gets a
            // locBase for its slice's position so every emitted location is
            // file-relative.
            const results = await Promise.all(defs.map(async (def) => {
                const { slice, startOffset } = sliceLines(html, def.loc.from, def.loc.to);
                const perPartialOptions: CompileOptions = { ...options, locBase: { line: def.loc.from - 1, offset: startOffset } };
                try {
                    return { def, ...(await compilePartial(slice, def, perPartialOptions)) };
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

    // Link stage (all AST mutation): resolve custom-element call sites against
    // same-file partials and the global exported custom-element registry, then
    // synthesize b-attr bindings on those call sites. Runs across all files before
    // validation so that read-only validators (below) see the fully linked trees —
    // in particular, the b-data-vs-data-shape check depends on the synthesized
    // bindings. May emit warnings for unresolved hyphenated tags and b-attr errors.
    allErrors.push(...resolveCustomElementCalls(files, registry));
    allErrors.push(...linkBAttrBindings(files, registry));

    // Validate references and slots (read-only; see validateRefs contract)
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
