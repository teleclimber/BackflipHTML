import { backcodeToJS } from '../js/nodes2js.js';
import { commentMarker } from './bfid.js';
import type { BackcodeSite, IfSetSite } from './collect.js';
import type { GenerateMode } from '../../types.js';

/**
 * Where a site's DOM node is, relative to the owning patch-branch's `ref_elem`.
 *  - `ref-element`: the patch-branch's own ref element — `this.ref_elem`. Reached
 *    with no querySelector. Covers the custom element itself (root branch) and any
 *    site whose nearest enclosing element *is* the branch's ref element (a
 *    `b-unwrap b-if` branch anchors its content to the element the set sits in).
 *  - `bfid-element`: a descendant element, located via `sel_<bfid>()`.
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
 * `setId` (the leading marker's bfid) names every symbol the set generates:
 * the module-level `bfif_<setId>` snapshot, `renderIf_<setId>`,
 * `getCreatePatchBranch_<setId>`, and the `this.if_<setId>` / `this.if_pb_<setId>`
 * fields. `snapshot` is the `nodeToJS` literal of the whole `IfTNode`, taken
 * *after* all AST mutation so it carries the same bfids and print markers as the
 * server-rendered HTML. It is also what the active branch is chosen from. A
 * qualifying set nested in it appears by name (`bfif_<setId>`), not as a copy.
 */
export interface IfSetPatchSite {
	/** Anchor for `renderIf_`'s swap — and the `ref_elem` handed to every child branch. */
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

/** One generated `BackflipPatch_<id>` class. */
export interface PatchBranch {
	/** `BackflipPatch_MyElement` at the root, `BackflipPatch_<setId>_<branchIndex>` below it. */
	className: string;
	sites: BfidSite[];
	sets: IfSetPatchSite[];
	/** Live vars this class's `update` switches over. */
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

/** The root patch-branch class name, paralleling `classNameFor` (`Backflip` → `BackflipPatch_`). */
export function patchClassNameFor(partialName: string): string {
	return 'BackflipPatch_' + classNameFor(partialName).slice('Backflip'.length);
}

export function sanitizeAttrName(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Emit the whole cluster for one partial: the module-level `bfif_<setId>` snapshot
 * consts (from every set in the tree), each `BackflipPatch_*` class depth-first, the
 * thin `export class BackflipMyElement` shell, and — for 'base' and 'full' — the
 * HTMLElement subclass that drives it, plus its `customElements.define` for 'full'.
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
): string | null {
	const patches = root.sites.length > 0 || root.sets.length > 0;
	if (!patches && mode === 'render') return null;

	const branches = allBranches(root);
	const consts = [
		// A snapshot names the sets nested in it, so each must come after those. The
		// depth-first set order, reversed, puts every set after its descendants.
		...branches.flatMap(b => b.sets).reverse().map(s => `const ${ifConstName(s.setId)} = ${s.snapshot};`),
		...genBcConsts(branches.flatMap(b => b.sites)),
	];
	const patchClasses = emitPatchBranch(root);
	const shell = genElementShell(partialName, root.className, bAttrs);

	const parts: string[] = [];
	if (consts.length) parts.push(consts.join('\n'), '');
	parts.push(patchClasses, '', shell);
	if (mode === 'base' || mode === 'full') {
		parts.push('', genCustomElementClass(partialName, bAttrs));
	}
	if (mode === 'full') {
		parts.push('', genDefine(partialName));
	}
	return parts.join('\n');
}

/**
 * A runtime file generated modules import. Every module sits flat at the dom-patch
 * output root with these files beside it, so each is imported as `./<file>`.
 */
export type RuntimeFile = 'render.js' | 'patch.js';

/** The runtime names a module uses, keyed by the file that exports them. */
export type RuntimeImports = Map<RuntimeFile, string[]>;

export function runtimeImportsFor(root: PatchBranch, mode: GenerateMode): RuntimeImports {
	const branches = allBranches(root);
	const hasSet = branches.some(b => b.sets.length > 0);
	const hasSite = branches.some(b => b.sites.length > 0);
	const hasPrint = branches.some(b => b.sites.some(s => s.backcode.site.kind === 'print'));

	const renderNames: string[] = [];
	if (hasSet) renderNames.push('render', 'activeBranchIndex');
	if (hasSite) renderNames.push('execFn');
	const patchNames: string[] = [];
	if (hasSet || hasPrint) patchNames.push('replaceBetween');
	if (mode === 'base' || mode === 'full') patchNames.push('BackflipElement');

	const imports: RuntimeImports = new Map();
	if (renderNames.length) imports.set('render.js', renderNames);
	if (patchNames.length) imports.set('patch.js', patchNames);
	return imports;
}

/** Assemble the module, importing each runtime name its classes call. */
export function generateFile(classes: (string | null)[], imports: RuntimeImports = new Map()): string {
	const kept = classes.filter((c): c is string => c !== null);
	if (kept.length === 0) return '';
	const header = '// Generated by BackflipHTML dom-patch — do not edit.';
	const importLines = [...imports].map(([file, names]) => `import { ${names.join(', ')} } from './${file}';`);
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

// One module-level `bc_*` expression per unique name, in the same `rfn` shape the
// snapshots use, evaluated with the runtime's `execFn`.
function genBcConsts(sites: BfidSite[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of sites) {
		const name = bcNameForSite(s);
		if (seen.has(name)) continue;
		seen.add(name);
		out.push(`const ${name} = ${backcodeToJS(s.backcode.parsed)};`);
	}
	return out;
}

// Emit this patch-branch class and, depth-first, every descendant branch class.
function emitPatchBranch(branch: PatchBranch): string {
	const chunks = [genPatchClass(branch)];
	for (const s of branch.sets) {
		for (const child of s.branches) {
			if (child) chunks.push(emitPatchBranch(child));
		}
	}
	return chunks.join('\n\n');
}

// --- the patch-branch class ------------------------------------------------

function genPatchClass(branch: PatchBranch): string {
	const { className, sites, sets, vars } = branch;

	// sel_ per unique bfid, across both site targets and set targets.
	const bfidOrder: string[] = [];
	const seenBfid = new Set<string>();
	const noteBfid = (t: PatchTarget) => {
		if (t.kind !== 'bfid-element' || seenBfid.has(t.bfid)) return;
		seenBfid.add(t.bfid);
		bfidOrder.push(t.bfid);
	};
	for (const s of sites) noteBfid(s.target);
	for (const s of sets) noteBfid(s.target);

	// Sites grouped per live var (a set contributes its condition + subtree vars).
	const sitesByVar = new Map<string, BfidSite[]>();
	for (const s of sites) {
		for (const v of s.backcode.liveVars) {
			if (!sitesByVar.has(v)) sitesByVar.set(v, []);
			sitesByVar.get(v)!.push(s);
		}
	}
	const setsByVar = new Map<string, IfSetPatchSite[]>();
	for (const s of sets) {
		for (const v of new Set([...s.ifSet.liveVars, ...s.subtreeVars])) {
			if (!setsByVar.has(v)) setsByVar.set(v, []);
			setsByVar.get(v)!.push(s);
		}
	}

	const selMethods = bfidOrder.map(genSelMethod);
	const getCreateMethods = sets.map(s => genGetCreateMethod(s));
	const renderIfMethods = sets.map(s => genRenderIfMethod(s, className));
	const mutateMethods = vars.map(v =>
		genMutateMethod(v, sitesByVar.get(v) ?? [], setsByVar.get(v) ?? [], className));

	const methods = [
		genConstructor(sets),
		'',
		...selMethods,
		...(selMethods.length ? [''] : []),
		...(getCreateMethods.length ? [...getCreateMethods, ''] : []),
		...(renderIfMethods.length ? [...renderIfMethods, ''] : []),
		...mutateMethods,
		...(mutateMethods.length ? [''] : []),
		genUpdate(vars),
	].join('\n');

	return `class ${className} {\n${methods}\n}`;
}

// The constructor keeps the ref element and seeds each owned set: it stores the
// active branch index (computed, not rendered — the server already emitted the
// right branch), a branch-index → child-instance map, and eagerly creates the
// child for the active branch.
function genConstructor(sets: IfSetPatchSite[]): string {
	const lines = ['\t\tthis.ref_elem = ref_elem;'];
	for (const s of sets) {
		lines.push(`\t\tthis.${activeIndexField(s.setId)} = ${activeBranchExpr(s.setId)};`);
		lines.push(`\t\tthis.${pbMapField(s.setId)} = new Map();`);
		lines.push(`\t\tthis.${getCreateFnName(s.setId)}(this.${activeIndexField(s.setId)}, data);`);
	}
	return `\tconstructor(ref_elem, data) {\n${lines.join('\n')}\n\t}`;
}

// Symbols an if-set owns, all keyed off its leading marker's bfid.
export function ifConstName(setId: string): string { return `bfif_${setId}`; }
function renderIfFnName(setId: string): string { return `renderIf_${setId}`; }
function getCreateFnName(setId: string): string { return `getCreatePatchBranch_${setId}`; }
function activeIndexField(setId: string): string { return `if_${setId}`; }
function pbMapField(setId: string): string { return `if_pb_${setId}`; }

function selFnName(bfid: string): string { return `sel_${bfid}`; }
function mutateFnName(varName: string): string { return `mutate_${varName}`; }

function genSelMethod(bfid: string): string {
	return `\t${selFnName(bfid)}() { return this.ref_elem.querySelector('[data-bfid="${bfid}"]'); }`;
}

// The JS expression that resolves a target element within this class.
function targetExpr(t: PatchTarget): string {
	return t.kind === 'ref-element' ? 'this.ref_elem' : `this.${selFnName(t.bfid)}()`;
}

// Stable grouping key for a patch target.
function targetKey(t: PatchTarget): string {
	return t.kind === 'ref-element' ? 'ref' : `bf:${t.bfid}`;
}

// The index of the set's winning branch, or -1 when none matches, chosen from its
// snapshot exactly as the renderer chooses.
function activeBranchExpr(setId: string): string {
	return `activeBranchIndex(${ifConstName(setId)}, data)`;
}

// Lazily construct (and memoize) the child patch-branch for a given branch index.
// Only branches with patchable content get a case; others leave `pb` undefined, so
// the caller (and `this.if_pb`) treats them as "no child".
function genGetCreateMethod(s: IfSetPatchSite): string {
	const map = pbMapField(s.setId);
	const ref = targetExpr(s.target);
	const cases: string[] = [];
	s.branches.forEach((child, i) => {
		if (child) cases.push(`\t\t\tcase ${i}: pb = new ${child.className}(${ref}, data); break;`);
	});
	return [
		`\t${getCreateFnName(s.setId)}(branch_i, data) {`,
		`\t\tif (this.${map}.has(branch_i)) return this.${map}.get(branch_i);`,
		'\t\tlet pb;',
		'\t\tswitch (branch_i) {',
		...cases,
		'\t\t}',
		`\t\tif (pb) this.${map}.set(branch_i, pb);`,
		'\t\treturn pb;',
		'\t}',
	].join('\n');
}

// Re-render the set only when the winning branch actually changed. Returns true if
// it re-rendered, false otherwise. On a real swap it evicts the old branch's child
// instance and creates the new one. The fragment is built with
// createContextualFragment against the target element so the branch HTML is parsed
// in its real parent context (a <tr> under a <tbody> survives).
function genRenderIfMethod(s: IfSetPatchSite, className: string): string {
	const idxField = activeIndexField(s.setId);
	const map = pbMapField(s.setId);
	return [
		`\t${renderIfFnName(s.setId)}(data) {`,
		`\t\tconst idx = ${activeBranchExpr(s.setId)};`,
		`\t\tif (idx === this.${idxField}) return false;`,
		`\t\tconst elem = ${targetExpr(s.target)};`,
		'\t\tif (!elem) {',
		`\t\t\t${genMissingElementError(s.target, className)}`,
		'\t\t\treturn false;',
		'\t\t}',
		`\t\tthis.${map}.delete(this.${idxField});`,
		`\t\tthis.${idxField} = idx;`,
		'\t\tconst range = document.createRange();',
		'\t\trange.selectNodeContents(elem);',
		`\t\tconst frag = range.createContextualFragment(render(${ifConstName(s.setId)}, data));`,
		`\t\treplaceBetween(elem, '${commentMarker(s.setId)}', '${commentMarker(s.endId)}', frag);`,
		`\t\tthis.${getCreateFnName(s.setId)}(idx, data);`,
		'\t\treturn true;',
		'\t}',
	].join('\n');
}

function genMutateMethod(
	varName: string,
	varSites: BfidSite[],
	varSets: IfSetPatchSite[],
	className: string,
): string {
	// Set handling runs first: a swap replaces whole subtrees, so any attr/print site
	// that lives in a branch must be patched against the DOM that results. For a set
	// driven by `varName`:
	//   - condition var only → re-render (fresh render already reflects the data).
	//   - subtree var only   → forward into the active child (branch cannot have moved).
	//   - both               → re-render *or* forward, never both.
	const setLines: string[] = [];
	for (const s of varSets) {
		const inCond = s.ifSet.liveVars.includes(varName);
		const inSub = s.subtreeVars.includes(varName);
		const map = pbMapField(s.setId);
		const idx = activeIndexField(s.setId);
		const forward = [
			`\t\t\tconst pb = this.${map}.get(this.${idx});`,
			`\t\t\tif (pb) pb.update('${varName}', data);`,
		];
		if (inCond && inSub) {
			setLines.push(`\t\tif (!this.${renderIfFnName(s.setId)}(data)) {`, ...forward, '\t\t}');
		} else if (inCond) {
			setLines.push(`\t\tthis.${renderIfFnName(s.setId)}(data);`);
		} else {
			setLines.push('\t\t{', ...forward, '\t\t}');
		}
	}

	if (varSites.length === 0) {
		return `\t${mutateFnName(varName)}(data) {\n${setLines.join('\n')}\n\t}`;
	}

	// Group sites by target element so each `elem = …` lookup and its null guard is
	// emitted once per mutate fn. A null lookup means the rendered DOM diverged from
	// the compiled template, so the guard logs instead of silently skipping.
	const byTarget = new Map<string, { target: PatchTarget; sites: BfidSite[] }>();
	for (const s of varSites) {
		const key = targetKey(s.target);
		let group = byTarget.get(key);
		if (!group) {
			group = { target: s.target, sites: [] };
			byTarget.set(key, group);
		}
		group.sites.push(s);
	}

	const body: string[] = [...setLines, '\t\tlet elem;'];
	for (const { target, sites } of byTarget.values()) {
		body.push(`\t\telem = ${targetExpr(target)};`);
		body.push('\t\tif (elem) {');
		for (const s of sites) body.push(genSiteUpdate(s));
		body.push('\t\t} else {');
		body.push(`\t\t\t${genMissingElementError(target, className)}`);
		body.push('\t\t}');
	}
	return `\t${mutateFnName(varName)}(data) {\n${body.join('\n')}\n\t}`;
}

function genMissingElementError(target: PatchTarget, className: string): string {
	if (target.kind === 'ref-element') {
		return `console.error('BackflipHTML ${className}: ref element not found; skipping update', this.ref_elem);`;
	}
	return `console.error('BackflipHTML ${className}: element [data-bfid="${target.bfid}"] not found; skipping update', this.ref_elem);`;
}

function bcNameForSite(s: BfidSite): string {
	const inner = s.backcode.site;
	switch (inner.kind) {
		case 'attr':
		case 'caller-attr-expr': {
			// Both patch a descendant element located by bfid (never the ref element):
			// an 'attr' site's own element, or a caller attr on a nested custom-element call.
			if (s.target.kind !== 'bfid-element') {
				throw new Error(`dom-patch codegen: '${inner.kind}' site must target a bfid element`);
			}
			return `bc_${s.target.bfid}_${sanitizeAttrName(inner.attr.name)}`;
		}
		case 'definition-root-attr':
			// ref-element target: no bfid, so use a fixed 'ce' infix. bfids are always
			// 'bf'-prefixed, so `bc_ce_…` can never collide with `bc_<bfid>_…`; two
			// def-root attrs with the same name are already rejected by the compiler.
			return `bc_ce_${sanitizeAttrName(inner.attr.name)}`;
		case 'print': {
			// Keyed off the (unique) leading marker id, so each print gets its own bc_.
			if (!s.comments) {
				throw new Error("dom-patch codegen: 'print' site is missing its comment markers");
			}
			return `bc_print_${sanitizeAttrName(s.comments.startId)}`;
		}
		default:
			throw new Error(`dom-patch codegen: unsupported site kind '${inner.kind}' — add a bc-name scheme when wiring this kind in.`);
	}
}

function genSiteUpdate(s: BfidSite): string {
	const inner = s.backcode.site;
	switch (inner.kind) {
		case 'attr':
		case 'definition-root-attr':
		case 'caller-attr-expr': {
			const fn = bcNameForSite(s);
			const dom = inner.attr.name;
			if (inner.attr.isBoolean) {
				return `\t\t\tif (execFn(${fn}, data)) elem.setAttribute('${dom}', ''); else elem.removeAttribute('${dom}');`;
			}
			return `\t\t\telem.setAttribute('${dom}', String(execFn(${fn}, data)));`;
		}
		case 'print': {
			if (!s.comments) {
				throw new Error("dom-patch codegen: 'print' site is missing its comment markers");
			}
			const fn = bcNameForSite(s);
			const start = commentMarker(s.comments.startId);
			const end = commentMarker(s.comments.endId);
			return `\t\t\treplaceBetween(elem, '${start}', '${end}', document.createTextNode(String(execFn(${fn}, data))));`;
		}
		default:
			throw new Error(`dom-patch codegen: unsupported site kind '${inner.kind}' — add an emit branch when wiring this kind in.`);
	}
}

function genUpdate(vars: string[]): string {
	const cases = vars.map(v =>
		`\t\t\tcase '${v}': this.${mutateFnName(v)}(data); break;`
	);
	return `\tupdate(varname, data) {\n\t\tswitch (varname) {\n${cases.join('\n')}\n\t\t}\n\t}`;
}

// --- the thin BackflipMyElement shell --------------------------------------

function genElementShell(
	partialName: string,
	rootPatchClass: string,
	bAttrs: { name: string; isBool: boolean }[],
): string {
	const className = classNameFor(partialName);
	const collectLines = bAttrs.map(b =>
		b.isBool
			? `\t\t\t${b.name}: this.ce.hasAttribute('${b.name}'),`
			: `\t\t\t${b.name}: this.ce.getAttribute('${b.name}') ?? '',`
	);
	return [
		`export class ${className} {`,
		'\tconstructor(ce) {',
		'\t\tthis.ce = ce;',
		`\t\tthis.pb = new ${rootPatchClass}(this.ce, this.collectData());`,
		'\t}',
		'\tcollectData() {',
		'\t\treturn {',
		...collectLines,
		'\t\t};',
		'\t}',
		'\tupdate(varname) {',
		'\t\tthis.pb.update(varname, this.collectData());',
		'\t}',
		'}',
	].join('\n');
}

// --- the custom element class ('base' and 'full') --------------------------

// `BackflipMyWidgetElement` — the lifecycle half, driving the shell above. The
// lifecycle itself lives in the runtime's `BackflipElement`; this subclass only
// names the shell and the declared attributes it observes.
function genCustomElementClass(
	partialName: string,
	bAttrs: { name: string; isBool: boolean }[],
): string {
	const lines = [
		`export class ${elementClassNameFor(partialName)} extends BackflipElement {`,
		`\tstatic bfShell = ${classNameFor(partialName)};`,
	];
	if (bAttrs.length > 0) {
		lines.push(`\tstatic bfDeclared = [${bAttrs.map(b => `'${b.name}'`).join(', ')}];`);
	}
	lines.push('}');
	return lines.join('\n');
}

// A name may be registered once. Two copies of one module (or an author module
// defining the same tag) would otherwise throw and take the rest of the module down.
function genDefine(partialName: string): string {
	const className = elementClassNameFor(partialName);
	return `if (!customElements.get('${partialName}')) customElements.define('${partialName}', ${className});`;
}
