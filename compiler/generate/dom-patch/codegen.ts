import { backcodeToJS } from '../js/nodes2js.js';
import { branchMarker, commentMarker } from './bfid.js';
import type { BackcodeSite, IfSetSite } from './collect.js';
import type { GenerateMode } from '../../types.js';

/**
 * Where a site's DOM node is, relative to the owning patch-branch's ref element.
 *  - `ref-element`: the ref element itself (`bfid: null` in the descriptor). Covers
 *    the custom element (root branch) and any site whose nearest enclosing element
 *    *is* the branch's ref element (a `b-unwrap b-if` branch anchors its content to
 *    the element the set sits in).
 *  - `bfid-element`: a descendant element, found by its `data-bfid`.
 */
export type PatchTarget =
	| { kind: 'ref-element' }
	| { kind: 'bfid-element'; bfid: string };

export interface BfidSite {
	target: PatchTarget;
	backcode: BackcodeSite;
	// For 'print' sites: the ids of the two marker comments bracketing the range.
	// `target` is the print's parent element (the comments' DOM parent).
	comments?: { startId: string; endId: string };
}

/**
 * A qualifying `b-if`/`b-else-if`/`b-else` set, ready for codegen.
 *
 * `setId` (the leading marker's bfid) names the set's module-level `bfif_<setId>`
 * snapshot. `snapshot` is the `nodeToJS` literal of the whole `IfTNode`, taken
 * *after* all AST mutation so it carries the same bfids and print markers as the
 * server-rendered HTML. The runtime renders a swapped-in branch from it and chooses
 * the active branch with it. A qualifying set nested in it appears by name
 * (`bfif_<setId>`), not as a copy.
 */
export interface IfSetPatchSite {
	/** Anchor for the set's swap — and the ref element handed to every child branch. */
	target: PatchTarget;
	ifSet: IfSetSite;
	setId: string;
	endId: string;
	snapshot: string;
	/** Live vars anywhere in the set's branch *content* (nested conditions included). */
	subtreeVars: string[];
	/** Index-aligned with the branches; `null` for a branch with no patchable content. */
	branches: (PatchBranch | null)[];
}

/** A subtree that is wholly present or wholly absent; emitted as a branch descriptor. */
export interface PatchBranch {
	sites: BfidSite[];
	sets: IfSetPatchSite[];
	/** Live vars a change to which reaches this branch: its sites', and its sets' condition and subtree vars. */
	vars: string[];
}

/** `BackflipMyWidgetElement` — the HTMLElement subclass, emitted for 'base' and 'full'. */
export function elementClassNameFor(partialName: string): string {
	return classNameFor(partialName) + 'Element';
}

export function classNameFor(partialName: string): string {
	const parts = partialName.split('-').filter(s => s.length > 0);
	const camel = parts.map(s => s[0].toUpperCase() + s.slice(1)).join('');
	return 'Backflip' + camel;
}

/**
 * Emit the body of one partial's module: the module-level `bfif_<setId>` snapshot
 * consts (from every set in the tree), the `export class BackflipMyElement` shell
 * carrying the declared attributes and the root branch descriptor, and — for 'base'
 * and 'full' — the HTMLElement subclass that drives it, plus its
 * `customElements.define` for 'full'. The runtime does the patching.
 *
 * Returns null in 'render' mode when the root branch has nothing to patch: the shell
 * would have no work to do and the author asked for nothing else. 'base' and 'full'
 * always emit, since the author asked for a class whether or not it patches anything.
 */
export function generateClassForPartial(
	partialName: string,
	bAttrs: { name: string; isBool: boolean }[],
	root: PatchBranch,
	mode: GenerateMode,
	stores: string[] = [],
): string | null {
	const patches = root.sites.length > 0 || root.sets.length > 0;
	if (!patches && mode === 'render') return null;

	// A snapshot names the sets nested in it, so each must come after those. The
	// depth-first set order, reversed, puts every set after its descendants.
	const consts = allBranches(root).flatMap(b => b.sets).reverse()
		.map(s => `const ${ifConstName(s.setId)} = ${s.snapshot};`);

	const parts: string[] = [];
	if (consts.length) parts.push(consts.join('\n'), '');
	parts.push(genShell(partialName, bAttrs, stores, patches ? root : null));
	if (mode === 'base' || mode === 'full') {
		parts.push('', genCustomElementClass(partialName));
	}
	if (mode === 'full') {
		parts.push('', genDefine(partialName));
	}
	return parts.join('\n');
}

/**
 * A runtime file, as its path relative to the package's `dist/`. The dom-patch output
 * dir holds each at the same relative path, so the imports between them resolve.
 */
export type RuntimeFile = 'runtime/js/render.js' | 'runtime/dom-patch/patch.js' | 'runtime/dom-patch/stores.js';

/** The runtime names a module uses, keyed by the file that exports them. */
export type RuntimeImports = Map<RuntimeFile, string[]>;

export function runtimeImportsFor(mode: GenerateMode): RuntimeImports {
	const names = ['BackflipShell'];
	if (mode === 'base' || mode === 'full') names.push('BackflipElement');
	return new Map([['runtime/dom-patch/patch.js', names]]);
}

/** A store file a shell imports: the store's name and the file's URL. */
export interface StoreImport {
	name: string;
	url: string;
}

/** The module-level name a store file's default export is imported as. */
export function storeImportName(storeName: string): string {
	return `bfstore_${storeName}`;
}

/** Assemble the module, importing each runtime name its classes use, and each store file. */
export function generateFile(classes: (string | null)[], imports: RuntimeImports = new Map(), stores: StoreImport[] = []): string {
	const kept = classes.filter((c): c is string => c !== null);
	if (kept.length === 0) return '';
	const header = '// Generated by BackflipHTML dom-patch — do not edit.';
	const importLines = [...imports].map(([file, names]) => `import { ${names.join(', ')} } from './${file}';`);
	for (const s of stores) importLines.push(`import ${storeImportName(s.name)} from ${JSON.stringify(s.url)};`);
	if (importLines.length) importLines.push('');
	return [header, '', ...importLines, ...kept.flatMap(c => [c, ''])].join('\n').trimEnd() + '\n';
}

// Every patch-branch in the tree, depth-first (a branch before its children).
export function allBranches(branch: PatchBranch): PatchBranch[] {
	const out = [branch];
	for (const s of branch.sets) {
		for (const child of s.branches) {
			if (child) out.push(...allBranches(child));
		}
	}
	return out;
}

/** The module-level const holding a set's snapshot, keyed off its leading marker's bfid. */
export function ifConstName(setId: string): string { return `bfif_${setId}`; }

// --- the shell ----------------------------------------------------------------

// `BackflipMyWidget` — the declared attributes, the stores its code reads and, when
// anything patches, the root branch descriptor. The runtime's `BackflipShell` reads
// the attributes and stores and runs the descriptor.
function genShell(
	partialName: string,
	bAttrs: { name: string; isBool: boolean }[],
	stores: string[],
	root: PatchBranch | null,
): string {
	const lines = [`export class ${classNameFor(partialName)} extends BackflipShell {`];
	if (bAttrs.length > 0) {
		const attrs = bAttrs.map(b => `${b.name}: '${b.isBool ? 'bool' : 'string'}'`).join(', ');
		lines.push(`\tstatic bfAttrs = { ${attrs} };`);
	}
	if (stores.length > 0) {
		lines.push(`\tstatic bfStores = { ${stores.map(n => `${n}: ${storeImportName(n)}`).join(', ')} };`);
	}
	if (root) lines.push(`\tstatic bfRoot = ${genBranchDesc(root, 1)};`);
	lines.push('}');
	return lines.join('\n');
}

// --- descriptors ----------------------------------------------------------------
//
// The literal shapes are the runtime's `BranchDesc`, `SetDesc` and `SiteDesc`.

function genBranchDesc(branch: PatchBranch, depth: number): string {
	const ind = '\t'.repeat(depth);
	return [
		'{',
		`${ind}\tsites: ${genList(branch.sites.map(genSiteDesc), depth + 1)},`,
		`${ind}\tsets: ${genList(branch.sets.map(s => genSetDesc(s, depth + 2)), depth + 1)},`,
		`${ind}}`,
	].join('\n');
}

// `depth` is the indent of the line the set's `{` opens on; the rest of it sits one deeper.
function genSetDesc(s: IfSetPatchSite, depth: number): string {
	const ind = '\t'.repeat(depth + 1);
	const branches = s.branches.map(b => b ? genBranchDesc(b, depth + 2) : 'null');
	const branchMarkers = s.branches.map((_, i) => `'${branchMarker(s.setId, i)}'`).join(', ');
	return [
		`{ bfid: ${bfidLiteral(s.target)}, markers: ${markersLiteral(s.setId, s.endId)},`,
		`${ind}snapshot: ${ifConstName(s.setId)}, subtreeVars: [${s.subtreeVars.map(v => `'${v}'`).join(', ')}],`,
		`${ind}branchMarkers: [${branchMarkers}],`,
		`${ind}branches: ${genList(branches, depth + 1)} }`,
	].join('\n');
}

function genSiteDesc(s: BfidSite): string {
	const inner = s.backcode.site;
	const bfid = bfidLiteral(s.target);
	const expr = backcodeToJS(s.backcode.parsed);
	switch (inner.kind) {
		case 'attr':
		case 'definition-root-attr':
		case 'caller-attr-expr': {
			const bool = inner.attr.isBoolean ? ', bool: true' : '';
			return `{ bfid: ${bfid}, attr: '${inner.attr.name}'${bool}, expr: ${expr} }`;
		}
		case 'print': {
			if (!s.comments) {
				throw new Error("dom-patch codegen: 'print' site is missing its comment markers");
			}
			return `{ bfid: ${bfid}, markers: ${markersLiteral(s.comments.startId, s.comments.endId)}, expr: ${expr} }`;
		}
		default:
			throw new Error(`dom-patch codegen: unsupported site kind '${inner.kind}' — add a descriptor for it when wiring this kind in.`);
	}
}

// One item per line, indented one level past `depth`; `[]` when empty.
function genList(items: string[], depth: number): string {
	if (items.length === 0) return '[]';
	const ind = '\t'.repeat(depth);
	return `[\n${items.map(i => `${ind}\t${i},`).join('\n')}\n${ind}]`;
}

function bfidLiteral(t: PatchTarget): string {
	return t.kind === 'ref-element' ? 'null' : `'${t.bfid}'`;
}

function markersLiteral(startId: string, endId: string): string {
	return `['${commentMarker(startId)}', '${commentMarker(endId)}']`;
}

// --- the custom element class ('base' and 'full') --------------------------

// `BackflipMyWidgetElement` — the lifecycle half, driving the shell above. The
// lifecycle lives in the runtime's `BackflipElement`, which observes the shell's
// declared attributes; this subclass only names the shell.
function genCustomElementClass(partialName: string): string {
	return [
		`export class ${elementClassNameFor(partialName)} extends BackflipElement {`,
		`\tstatic bfShell = ${classNameFor(partialName)};`,
		'}',
	].join('\n');
}

// A name may be registered once. Two copies of one module (or an author module
// defining the same tag) would otherwise throw and take the rest of the module down.
function genDefine(partialName: string): string {
	const className = elementClassNameFor(partialName);
	return `if (!customElements.get('${partialName}')) customElements.define('${partialName}', ${className});`;
}
