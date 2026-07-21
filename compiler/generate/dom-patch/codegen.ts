import { generateStatement } from '../js/generatejs.js';
import { commentMarker } from './bfid.js';
import type { BackcodeSite, IfSetSite } from './collect.js';

/**
 * Which DOM node a patch site updates.
 *  - `bfid-element`: an element inside the partial body. Located at runtime via
 *    `querySelector('[data-bfid="<bfid>"]')`, so it carries the generated bfid.
 *  - `this-element`: the custom element itself. The runtime already holds a
 *    direct reference (`this.ce`), so there is no bfid and no querySelector.
 */
export type PatchTarget =
	| { kind: 'bfid-element'; bfid: string }
	| { kind: 'this-element' };

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
 * the module-level `bfif_<setId>` snapshot, `branch_<setId>`, `renderIf_<setId>`
 * and the `this.if_<setId>` active-index field. `snapshot` is the `nodeToJS`
 * literal of the whole `IfTNode`, taken *after* all AST mutation so it carries
 * the same bfids and print markers as the server-rendered HTML.
 */
export interface IfSetPatchSite {
	target: PatchTarget;
	ifSet: IfSetSite;
	setId: string;
	endId: string;
	snapshot: string;
}

export type PatchSite = BfidSite | IfSetPatchSite;

function isIfSetPatchSite(s: PatchSite): s is IfSetPatchSite {
	return 'ifSet' in s;
}

export function classNameFor(partialName: string): string {
	const parts = partialName.split('-').filter(s => s.length > 0);
	const camel = parts.map(s => s[0].toUpperCase() + s.slice(1)).join('');
	return 'Backflip' + camel;
}

export function sanitizeAttrName(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, '_');
}

export function generateClassForPartial(
	partialName: string,
	bAttrs: { name: string; isBool: boolean }[],
	sites: PatchSite[],
): string | null {
	if (sites.length === 0) return null;

	const className = classNameFor(partialName);
	const bcSites = sites.filter((s): s is BfidSite => !isIfSetPatchSite(s));
	const ifSites = sites.filter(isIfSetPatchSite);

	// One sel_ per unique bfid (preserving first-seen order). Sites that target
	// the custom element itself have no bfid and no sel_ method.
	const bfidOrder: string[] = [];
	const seenBfid = new Set<string>();
	for (const s of sites) {
		if (s.target.kind !== 'bfid-element') continue;
		if (!seenBfid.has(s.target.bfid)) {
			seenBfid.add(s.target.bfid);
			bfidOrder.push(s.target.bfid);
		}
	}

	// One bc_ per unique (bfid, kind-specific suffix). For attr sites the suffix
	// is the sanitized attr name; new kinds get their own suffix scheme.
	const bcKeys = new Set<string>();
	const bcMethods: string[] = [];
	for (const s of bcSites) {
		const fnName = bcFnNameForSite(s);
		if (bcKeys.has(fnName)) continue;
		bcKeys.add(fnName);
		bcMethods.push(genBcMethod(fnName, s));
	}

	// Group sites per live variable (order = first-seen across sites). An if-set is
	// driven only by the vars in its own branch conditions.
	const bcByVar = new Map<string, BfidSite[]>();
	const ifByVar = new Map<string, IfSetPatchSite[]>();
	const varOrder: string[] = [];
	const noteVar = (v: string) => { if (!varOrder.includes(v)) varOrder.push(v); };
	for (const s of bcSites) {
		for (const v of s.backcode.liveVars) {
			noteVar(v);
			if (!bcByVar.has(v)) bcByVar.set(v, []);
			bcByVar.get(v)!.push(s);
		}
	}
	for (const s of ifSites) {
		for (const v of s.ifSet.liveVars) {
			noteVar(v);
			if (!ifByVar.has(v)) ifByVar.set(v, []);
			ifByVar.get(v)!.push(s);
		}
	}

	const selMethods = bfidOrder.map(genSelMethod);
	const branchMethods = ifSites.map(genBranchMethod);
	const renderIfMethods = ifSites.map(s => genRenderIfMethod(s, className));
	const mutateMethods = varOrder.map(v =>
		genMutateMethod(v, bcByVar.get(v) ?? [], ifByVar.get(v) ?? [], className));
	const collect = genCollectData(bAttrs);
	const update = genUpdate(varOrder);

	// The child-range replace helper is needed by print sites and if-sets alike.
	const needsReplace = ifSites.length > 0 || bcSites.some(s => s.backcode.site.kind === 'print');
	const helperMethods = needsReplace ? [genReplaceBetweenMethod(className)] : [];

	const methods = [
		genConstructor(ifSites),
		'',
		...selMethods,
		'',
		...bcMethods,
		'',
		...(branchMethods.length ? [...branchMethods, ''] : []),
		...(renderIfMethods.length ? [...renderIfMethods, ''] : []),
		...mutateMethods,
		'',
		...(helperMethods.length ? [...helperMethods, ''] : []),
		collect,
		'',
		update,
	].join('\n');

	const cls = `export class ${className} {\n${methods}\n}`;
	// The if-set snapshots are module-level consts, so they precede the class.
	if (ifSites.length === 0) return cls;
	const consts = ifSites.map(s => `const ${ifConstName(s.setId)} = ${s.snapshot};`);
	return [...consts, '', cls].join('\n');
}

/**
 * Assemble the module. `renderImportPath` is the specifier for the JS runtime's
 * `render.js`; pass it only when a class in this file actually uses an if-set.
 */
export function generateFile(classes: (string | null)[], renderImportPath?: string): string {
	const kept = classes.filter((c): c is string => c !== null);
	if (kept.length === 0) return '';
	const header = '// Generated by BackflipHTML dom-patch — do not edit.';
	const imports = renderImportPath !== undefined
		? [`import { render } from '${renderImportPath}';`, '']
		: [];
	return [header, '', ...imports, ...kept.flatMap(c => [c, ''])].join('\n').trimEnd() + '\n';
}

function bcFnNameForSite(s: BfidSite): string {
	const inner = s.backcode.site;
	switch (inner.kind) {
		case 'attr': {
			// An 'attr' site always patches a body element (target assigned in nodes2patch.ts).
			if (s.target.kind !== 'bfid-element') {
				throw new Error("dom-patch codegen: 'attr' site must target a body element");
			}
			return `bc_${s.target.bfid}_${sanitizeAttrName(inner.attr.name)}`;
		}
		case 'definition-root-attr':
			// this-element target: no bfid, so use a fixed 'ce' infix instead.
			// `bc_ce_<attr>` shares a namespace with bfid-element names `bc_<bfid>_<attr>`
			// but cannot collide with them: bfids are generated with the 'bf' prefix
			// (see makeBfidGen in bfid.ts), so a `bc_bf…` name is never a `bc_ce…` name.
			// The only remaining collision source — two def-root attrs with the same
			// name — is already rejected by the compiler.
			return `bc_ce_${sanitizeAttrName(inner.attr.name)}`;
		case 'print': {
			// Keyed off the (unique) leading marker id, so each print gets its own bc fn.
			if (!s.comments) {
				throw new Error("dom-patch codegen: 'print' site is missing its comment markers");
			}
			return `bc_print_${sanitizeAttrName(s.comments.startId)}`;
		}
		default:
			throw new Error(`dom-patch codegen: unsupported site kind '${inner.kind}' — add a bc-name scheme when wiring this kind in.`);
	}
}

function selFnName(bfid: string): string {
	return `sel_${bfid}`;
}

// Stable grouping key for a patch target. bfid-element keys are namespaced with
// 'bf:' so they can never equal the this-element key 'ce'.
function targetKey(t: PatchTarget): string {
	return t.kind === 'this-element' ? 'ce' : `bf:${t.bfid}`;
}

function mutateFnName(varName: string): string {
	return `mutate_${varName}`;
}

function genSelMethod(bfid: string): string {
	return `\t${selFnName(bfid)}() { return this.ce.querySelector('[data-bfid="${bfid}"]'); }`;
}

// Symbols an if-set owns, all keyed off its leading marker's bfid.
function ifConstName(setId: string): string { return `bfif_${setId}`; }
function branchFnName(setId: string): string { return `branch_${setId}`; }
function renderIfFnName(setId: string): string { return `renderIf_${setId}`; }
function activeIndexField(setId: string): string { return `if_${setId}`; }

// The constructor seeds each if-set's active-branch index from the current
// attributes without rendering: the server already emitted the right branch.
function genConstructor(ifSites: IfSetPatchSite[]): string {
	if (ifSites.length === 0) return '\tconstructor(ce) { this.ce = ce; }';
	const lines = ifSites.map(s =>
		`\t\tthis.${activeIndexField(s.setId)} = this.${branchFnName(s.setId)}(this.collectData());`);
	return [`\tconstructor(ce) {`, '\t\tthis.ce = ce;', ...lines, '\t}'].join('\n');
}

// Returns the index of the winning branch, or -1 when none matches (a set with
// no b-else whose conditions are all falsy renders nothing).
function genBranchMethod(s: IfSetPatchSite): string {
	const vars = s.ifSet.liveVars;
	const destructure = vars.length === 0 ? '' : `\t\tconst { ${vars.join(', ')} } = data;\n`;
	const lines: string[] = [];
	let hasElse = false;
	s.ifSet.node.branches.forEach((b, i) => {
		if (hasElse) return;   // nothing can follow a b-else
		if (b.condition) {
			lines.push(`\t\tif (${generateStatement(b.condition.expr!)}) return ${i};`);
		} else {
			lines.push(`\t\treturn ${i};`);   // b-else — always wins if reached
			hasElse = true;
		}
	});
	if (!hasElse) lines.push('\t\treturn -1;');
	return `\t${branchFnName(s.setId)}(data) {\n${destructure}${lines.join('\n')}\n\t}`;
}

// Re-render the set only when the winning branch actually changed. The fragment is
// built with createContextualFragment against the target element so the branch HTML
// is parsed in its real parent context (a <tr> under a <tbody> survives).
function genRenderIfMethod(s: IfSetPatchSite, className: string): string {
	const idxField = activeIndexField(s.setId);
	const lookup = s.target.kind === 'this-element'
		? '\t\tconst elem = this.ce;'
		: `\t\tconst elem = this.${selFnName(s.target.bfid)}();`;
	return [
		`\t${renderIfFnName(s.setId)}(data) {`,
		`\t\tconst idx = this.${branchFnName(s.setId)}(data);`,
		`\t\tif (idx === this.${idxField}) return;`,
		`\t\tthis.${idxField} = idx;`,
		lookup,
		'\t\tif (!elem) {',
		`\t\t\t${genMissingElementError(s.target, className)}`,
		'\t\t\treturn;',
		'\t\t}',
		'\t\tconst range = document.createRange();',
		'\t\trange.selectNodeContents(elem);',
		`\t\tconst frag = range.createContextualFragment(render(${ifConstName(s.setId)}, data));`,
		`\t\tthis.replaceBetween(elem, '${commentMarker(s.setId)}', '${commentMarker(s.endId)}', frag);`,
		'\t}',
	].join('\n');
}

function genBcMethod(fnName: string, s: BfidSite): string {
	const expr = generateStatement(s.backcode.parsed.expr!);
	const vars = s.backcode.parsed.vars;
	const destructure = vars.length === 0 ? '' : `\t\tconst { ${vars.join(', ')} } = data;\n`;
	return `\t${fnName}(data) {\n${destructure}\t\treturn ${expr};\n\t}`;
}

function genMutateMethod(
	varName: string,
	varSites: BfidSite[],
	varIfSites: IfSetPatchSite[],
	className: string,
): string {
	// If-set swaps run first: they replace whole subtrees, so any attr/print site
	// that lives in a branch must be patched against the DOM that results.
	const ifLines = varIfSites.map(s => `\t\tthis.${renderIfFnName(s.setId)}(data);`);
	if (varSites.length === 0) {
		return `\t${mutateFnName(varName)}(data) {\n${ifLines.join('\n')}\n\t}`;
	}

	// Group sites by target element so each `elem = …` lookup and its null guard is
	// emitted once per mutate fn. All this-element sites land in one group (there is
	// only one ce). A null lookup means the rendered DOM diverged from the compiled
	// template, so the guard logs instead of silently skipping the update.
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

	const body: string[] = [...ifLines, '\t\tlet elem;'];
	for (const { target, sites } of byTarget.values()) {
		body.push(target.kind === 'this-element'
			? `\t\telem = this.ce;`
			: `\t\telem = this.${selFnName(target.bfid)}();`);
		body.push('\t\tif (elem) {');
		for (const s of sites) {
			body.push(genSiteUpdate(s));
		}
		body.push('\t\t} else {');
		body.push(`\t\t\t${genMissingElementError(target, className)}`);
		body.push('\t\t}');
	}
	return `\t${mutateFnName(varName)}(data) {\n${body.join('\n')}\n\t}`;
}

// Per-class marker-range replace, shared by 'print' sites and if-sets. Finds the
// two marker comments among `parent`'s direct children, removes every node strictly
// between them, and inserts `node` before the closing marker. Prints pass a text
// node (never innerText/innerHTML) so a value containing markup stays literal;
// if-sets pass a DocumentFragment of the freshly rendered branch. Either way the
// markers survive, so the range stays patchable.
function genReplaceBetweenMethod(className: string): string {
	return [
		'\treplaceBetween(parent, startMarker, endMarker, node) {',
		'\t\tlet start = null, end = null;',
		'\t\tfor (const child of parent.childNodes) {',
		'\t\t\tif (child.nodeType !== 8) continue;',
		'\t\t\tif (child.nodeValue === startMarker) start = child;',
		'\t\t\telse if (child.nodeValue === endMarker) end = child;',
		'\t\t}',
		'\t\tif (!start || !end) {',
		`\t\t\tconsole.error('BackflipHTML ${className}: comment markers not found; skipping update', parent);`,
		'\t\t\treturn;',
		'\t\t}',
		'\t\tlet n = start.nextSibling;',
		'\t\twhile (n && n !== end) {',
		'\t\t\tconst next = n.nextSibling;',
		'\t\t\tparent.removeChild(n);',
		'\t\t\tn = next;',
		'\t\t}',
		'\t\tparent.insertBefore(node, end);',
		'\t}',
	].join('\n');
}

function genMissingElementError(target: PatchTarget, className: string): string {
	if (target.kind === 'this-element') {
		return `console.error('BackflipHTML ${className}: host element not found; skipping update');`;
	}
	return `console.error('BackflipHTML ${className}: element [data-bfid="${target.bfid}"] not found; skipping update', this.ce);`;
}

function genSiteUpdate(s: BfidSite): string {
	const inner = s.backcode.site;
	switch (inner.kind) {
		case 'attr':
		case 'definition-root-attr': {
			const fn = bcFnNameForSite(s);
			const dom = inner.attr.name;
			if (inner.attr.isBoolean) {
				return `\t\t\tif (this.${fn}(data)) elem.setAttribute('${dom}', ''); else elem.removeAttribute('${dom}');`;
			}
			return `\t\t\telem.setAttribute('${dom}', String(this.${fn}(data)));`;
		}
		case 'print': {
			if (!s.comments) {
				throw new Error("dom-patch codegen: 'print' site is missing its comment markers");
			}
			const fn = bcFnNameForSite(s);
			const start = commentMarker(s.comments.startId);
			const end = commentMarker(s.comments.endId);
			return `\t\t\tthis.replaceBetween(elem, '${start}', '${end}', document.createTextNode(String(this.${fn}(data))));`;
		}
		default:
			throw new Error(`dom-patch codegen: unsupported site kind '${inner.kind}' — add an emit branch when wiring this kind in.`);
	}
}

function genCollectData(bAttrs: { name: string; isBool: boolean }[]): string {
	const lines = bAttrs.map(b =>
		b.isBool
			? `\t\t\t${b.name}: this.ce.hasAttribute('${b.name}'),`
			: `\t\t\t${b.name}: this.ce.getAttribute('${b.name}') ?? '',`
	);
	return `\tcollectData() {\n\t\treturn {\n${lines.join('\n')}\n\t\t};\n\t}`;
}

function genUpdate(varOrder: string[]): string {
	const cases = varOrder.map(v =>
		`\t\t\tcase '${v}': this.${mutateFnName(v)}(this.collectData()); break;`
	);
	return `\tupdate(varname) {\n\t\tswitch (varname) {\n${cases.join('\n')}\n\t\t}\n\t}`;
}
