import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compileFile, type CompiledFile, type PartialRegistry, type PartialRefTNode, BackflipError } from './compiler.ts';

export interface CompiledDirectory {
    files: Map<string, CompiledFile>  // key: relative file path e.g. "blog/general.html"
}

/**
 * Recursively collect all .html files under `dir`, returning relative paths.
 */
async function collectHtmlFiles(dir: string, base: string = dir): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
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

/**
 * Validate cross-file PartialRefTNode references in a compiled file.
 * Returns an array of errors found.
 */
function validateRefs(
    compiledFile: CompiledFile,
    sourceRelPath: string,
    registry: PartialRegistry
): BackflipError[] {
    const errors: BackflipError[] = [];
    for (const [, root] of compiledFile.partials) {
        validateRootTNode(root, sourceRelPath, registry, errors);
    }
    return errors;
}

function validateRootTNode(
    node: { tnodes: import('./compiler.ts').TNode[] },
    sourceRelPath: string,
    registry: PartialRegistry,
    errors: BackflipError[]
): void {
    for (const tnode of node.tnodes) {
        validateTNode(tnode, sourceRelPath, registry, errors);
    }
}

function validateTNode(
    tnode: import('./compiler.ts').TNode,
    sourceRelPath: string,
    registry: PartialRegistry,
    errors: BackflipError[]
): void {
    if (tnode.type === 'partial-ref') {
        const ref = tnode as PartialRefTNode;
        if (ref.file !== null) {
            // Cross-file reference: validate registry
            if (!registry.has(ref.file)) {
                errors.push(new BackflipError(
                    `In "${sourceRelPath}": b-part references file "${ref.file}" which does not exist in the directory`
                ));
            } else {
                const exportedNames = registry.get(ref.file)!;
                if (!exportedNames.has(ref.partialName)) {
                    errors.push(new BackflipError(
                        `In "${sourceRelPath}": b-part references partial "${ref.partialName}" in file "${ref.file}", but that partial is not exported (missing b-export)`
                    ));
                }
            }
        }
        // Validate slot contents
        for (const slotNodes of Object.values(ref.slots)) {
            for (const slotTNode of slotNodes) {
                validateTNode(slotTNode, sourceRelPath, registry, errors);
            }
        }
    } else if (tnode.type === 'for') {
        validateRootTNode(tnode, sourceRelPath, registry, errors);
    } else if (tnode.type === 'if') {
        for (const branch of tnode.branches) {
            validateRootTNode(branch, sourceRelPath, registry, errors);
        }
    }
}

/**
 * Compile all HTML template files in a directory.
 *
 * Pass 1: Build the PartialRegistry by scanning all .html files for b-export attributes.
 * Cycle check: Build dependency graph and detect circular cross-file references.
 * Pass 2: Compile each file in parallel with the full registry, then validate cross-file refs.
 */
export async function compileDirectory(dir: string): Promise<{ directory: CompiledDirectory, errors: BackflipError[] }> {
    const allErrors: BackflipError[] = [];

    // Pass 1: collect files and build registry
    const relPaths = await collectHtmlFiles(dir);

    const fileContents = new Map<string, string>();
    const registry: PartialRegistry = new Map();

    await Promise.all(relPaths.map(async (relPath) => {
        const absPath = path.join(dir, relPath);
        const html = await fs.readFile(absPath, 'utf-8');
        fileContents.set(relPath, html);
        const exported = scanExportedPartials(html);
        registry.set(relPath, exported);
    }));

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
            const { compiled, errors } = await compileFile(html, registry, relPath);
            allErrors.push(...errors);
            return [relPath, compiled];
        })
    );

    // Validate cross-file references
    for (const [relPath, compiled] of compiledPairs) {
        const refErrors = validateRefs(compiled, relPath, registry);
        allErrors.push(...refErrors);
    }

    const files = new Map<string, CompiledFile>(compiledPairs);
    return { directory: { files }, errors: allErrors };
}
