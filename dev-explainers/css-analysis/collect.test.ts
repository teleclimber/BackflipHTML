import { describe, it, before } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { compileFiles } from '@backflip/html';
import { collectExplain, type ExplainPayload } from './collect.js';
import { renderDocument } from './page.js';
import { summarize } from './summary.js';

/**
 * The `demo/` project is built to exercise every expansion rule at once:
 * a carrying tag, an unwrapped call, a forwarded slot, a b-for, both arms of a
 * b-if, and a custom element. Its expected numbers are therefore also a
 * readable summary of the model.
 */
const FIXTURE = path.join(import.meta.dirname!, 'demo');

let payload: ExplainPayload;

before(async () => {
	const dir = path.join(FIXTURE, 'templates');
	const sources = new Map<string, string>();
	for (const name of fs.readdirSync(dir)) {
		if (name.endsWith('.html')) sources.set(name, fs.readFileSync(path.join(dir, name), 'utf-8'));
	}
	const { directory, errors } = await compileFiles(sources);
	strictEqual(errors.length, 0, `fixture should compile cleanly: ${errors.map(e => e.message).join('; ')}`);
	payload = collectExplain({
		project: 'explain-demo',
		compiled: directory.files,
		sources,
		cssContent: fs.readFileSync(path.join(FIXTURE, 'styles.css'), 'utf-8'),
		cssFiles: ['styles.css'],
	});
});

/** The aggregate for the element carrying `class="<cls>"`. */
function element(cls: string) {
	const found = payload.elements.find(e => e.label.split(/(?=[.#])/).includes(`.${cls}`));
	ok(found, `no matched element carries class="${cls}"`);
	return found!;
}

function match(cls: string, selector: string) {
	const found = element(cls).matches.find(m => payload.selectors[m.selectorId].text === selector);
	ok(found, `${selector} did not match .${cls}`);
	return found!;
}

function selector(text: string) {
	const found = payload.selectors.find(s => s.text === text);
	ok(found, `no selector ${text}`);
	return found!;
}

describe('collectExplain: roots', () => {
	it('reports one entry root and the reason each partial was or was not one', () => {
		const roots = payload.partials.filter(p => p.rootReason);
		deepStrictEqual(roots.map(p => `${p.name}:${p.rootReason}`), ['article:entry']);
		const card = payload.partials.find(p => p.name === 'card')!;
		strictEqual(card.rootReason, null);
		strictEqual(card.calledFrom.length, 2, 'card is called from two sites in the page');
	});
});

describe('collectExplain: partial definitions', () => {
	/**
	 * Each partial's tree in the Expansion tab is headed by a synthesized row for
	 * the definition itself. It used to be `kind: 'element'`, which gave it a
	 * blank gutter and tag styling — indistinguishable from a real element, so
	 * `card` and the `div.card` below it read as the same kind of thing.
	 */
	it('marks a b-name definition with its own kind', () => {
		const card = payload.partials.find(p => p.name === 'card')!;
		const head = payload.authoring[card.authoringId!];
		strictEqual(head.kind, 'b-name');
		strictEqual(head.label, 'card');
		strictEqual(head.instances.length, 0, 'the definition renders nothing; its b-name tag below does');
	});

	it('distinguishes a custom-element definition, whose tag the call site renders', () => {
		const chip = payload.partials.find(p => p.name === 'my-chip')!;
		const head = payload.authoring[chip.authoringId!];
		strictEqual(head.kind, 'ce-partial');
		strictEqual(head.instances.length, 0);
	});

	it('heads every partial and nothing else', () => {
		const heads = payload.authoring.filter(n => n.kind === 'b-name' || n.kind === 'ce-partial');
		deepStrictEqual(heads.map(n => n.label).sort(), ['article', 'card', 'my-chip', 'shell', 'tag-list']);
		deepStrictEqual(
			payload.partials.map(p => payload.authoring[p.authoringId!].kind).sort(),
			['b-name', 'b-name', 'b-name', 'b-name', 'ce-partial'],
		);
	});

	it('gives the page a gutter for each, styled apart from the splice rules', () => {
		const html = renderDocument(payload);
		ok(html.includes("'b-name': 'b-name'"), 'the gutter map names b-name');
		ok(html.includes("'ce-partial': 'ce-partial'"), 'the gutter map names ce-partial');
		ok(/\.gutter\.b-name,\s*\.gutter\.ce-partial/.test(html), 'both share one gutter style');
		ok(!/\.gutter\.slot[^{]*\.gutter\.b-name/.test(html), 'that style is not the slot/for one');
	});
});

describe('collectExplain: trees', () => {
	/**
	 * The forest is one tree per expansion root, and they are isolated: a
	 * combinator cannot cross from one into another. The rendered list used to
	 * run them together, so two tops from different trees read as siblings.
	 */
	it('groups the demo into one tree, named for the root it grew from', () => {
		strictEqual(payload.trees.length, 1);
		const [tree] = payload.trees;
		strictEqual(payload.partials[tree.rootPartialId!].name, 'article');
		strictEqual(tree.reason, 'entry');
		strictEqual(tree.size, payload.instances.length);
		deepStrictEqual(tree.tops, payload.instances.filter(i => i.parent === null).map(i => i.id));
	});

	it('stamps every instance with the tree it belongs to', () => {
		ok(payload.instances.every(i => i.treeId === 0));
	});

	it('separates the trees of a project with two entry points', async () => {
		const sources = new Map([
			['a.html', '<b-unwrap b-name="pageA"><div class="a1"></div><div class="a2"></div></b-unwrap>'],
			['b.html', '<b-unwrap b-name="pageB"><div class="b1"></div></b-unwrap>'],
		]);
		const { directory } = await compileFiles(sources);
		const two = collectExplain({
			project: 'two', compiled: directory.files, sources,
			cssContent: '.a1 { color: red }', cssFiles: ['x.css'],
		});
		strictEqual(two.trees.length, 2);
		deepStrictEqual(two.trees.map(t => two.partials[t.rootPartialId!].name), ['pageA', 'pageB']);
		deepStrictEqual(two.trees.map(t => t.size), [2, 1]);
		// The boundary is the point of the whole thing: a2 and b1 are adjacent
		// rows but belong to different trees.
		const a2 = two.instances.find(i => i.classes.includes('a2'))!;
		const b1 = two.instances.find(i => i.classes.includes('b1'))!;
		strictEqual(b1.id, a2.id + 1, 'they are neighbours in the rendered order');
		ok(a2.treeId !== b1.treeId, 'but they are not in the same tree');
	});

	it('leaves a tree unattributed rather than guessing when a root renders nothing', async () => {
		// `textonly` is a root that yields no element, so the roots and the trees
		// no longer line up and no root name can be pinned on the one tree.
		const sources = new Map([
			['a.html', '<b-unwrap b-name="textonly">just text</b-unwrap>'],
			['b.html', '<div b-name="real" class="r"></div>'],
		]);
		const { directory } = await compileFiles(sources);
		const odd = collectExplain({
			project: 'odd', compiled: directory.files, sources,
			cssContent: '.r { color: red }', cssFiles: ['x.css'],
		});
		strictEqual(odd.trees.length, 1);
		strictEqual(odd.trees[0].rootPartialId, null);
		strictEqual(odd.trees[0].reason, null);
		strictEqual(odd.trees[0].size, 1);
	});

	it('heads each tree with the file and partial its root lives in', () => {
		const errors: unknown[] = [];
		const virtualConsole = new VirtualConsole();
		virtualConsole.on('jsdomError', e => errors.push(e));
		const dom = new JSDOM(renderDocument(payload), { runScripts: 'dangerously', virtualConsole });
		const doc = dom.window.document;
		([...doc.querySelectorAll('.tab')].find(t => t.textContent!.includes('Forest')) as any).click();
		deepStrictEqual(errors, [], 'the page script must not throw');

		const heads = [...doc.querySelectorAll('.treehead')];
		strictEqual(heads.length, 1, 'the demo is one tree');
		const text = heads[0].textContent!;
		// The partial name alone does not say where to look; a project can have
		// several partials of one name across files.
		ok(text.includes('page.html'), `the header names the file: ${text}`);
		ok(text.includes('article'), 'and the partial');
		ok(text.includes('entry point'), 'and why it is a root');
		ok(!text.includes('nothing calls it'), 'without spelling out the definition');
	});
});

describe('collectExplain: expansion', () => {
	it('gives a b-part call no instance of its own, and names the partial it splices', () => {
		const call = payload.authoring.find(n => n.kind === 'b-part' && n.label.includes('#card'))!;
		ok(call, 'the card call is in the authoring tree');
		strictEqual(call.instances.length, 0, 'the ref renders nothing; the target body is spliced in');
		strictEqual(payload.partials[call.targetPartialId!].name, 'card');
	});

	it('stamps each instance with the rule that placed it', () => {
		const cardRoots = payload.instances.filter(i => i.classes.includes('card'));
		strictEqual(cardRoots.length, 2);
		ok(cardRoots.every(i => i.via === 'partial'), 'a card root arrives by a partial splice');

		const fills = payload.instances.filter(i => i.classes.includes('label'));
		strictEqual(fills.length, 2);
		ok(fills.every(i => i.via === 'slot'), 'b-in content arrives through a slot');
		ok(fills.every(i => i.partial === 'article'), 'a fill stays in the partial that wrote it');

		const tags = payload.instances.filter(i => i.classes.includes('tag'));
		strictEqual(tags.length, payload.meta.forReps, 'a b-for body is modelled FOR_REPS times');
		ok(tags.every(i => i.via === 'for'));

		const notices = payload.instances.filter(i => i.classes.includes('notice'));
		strictEqual(notices.length, 2, 'both b-if branches are present');
		ok(notices.every(i => i.via === 'if' && i.conditional));
	});

	it('puts the carrying tag between the caller and the partial it calls', () => {
		const featured = payload.instances.find(i => i.classes.includes('featured'))!;
		const card = payload.instances.find(i => i.parent === featured.id)!;
		ok(card.classes.includes('card'), 'the card root hangs off the tag carrying the call');
	});

	it('merges caller and definition attributes onto one custom-element tag', () => {
		const chip = payload.instances.find(i => i.tag === 'my-chip')!;
		const names = Object.fromEntries(chip.attrs.map(a => [a.name, a.value]));
		strictEqual(names['class'], 'chip-call', 'call-site attrs come first');
		strictEqual(names['data-role'], 'chip', 'definition attrs are on the same tag');
	});
});

describe('collectExplain: match types', () => {
	it('is definite when every instance of the element matches', () => {
		strictEqual(match('card', '.card').matchType, 'definite');
		strictEqual(match('card', '.card').hits, 2);
		strictEqual(match('card', '.card').total, 2);
	});

	it('is conditional when only some uses of a partial match', () => {
		const m = match('card-title', '.featured .card-title');
		strictEqual(m.matchType, 'conditional');
		strictEqual(m.hits, 1);
		strictEqual(m.total, 2);
	});

	it('is conditional for a positional selector over a b-for body', () => {
		strictEqual(match('tag', '.tag:first-child').hits, 1);
		strictEqual(match('tag', '.tag+.tag').hits, 2);
		strictEqual(match('tag', '.tag:first-child').matchType, 'conditional');
	});

	it('is conditional for an element inside a b-if branch', () => {
		strictEqual(match('notice', '.notice').matchType, 'conditional');
	});

	it('resolves :has() into slot content across the partial boundary', () => {
		strictEqual(match('card', '.card:has(.label)').matchType, 'definite');
	});
});

describe('collectExplain: selector steps', () => {
	it('splits a selector into compounds and runs each one for real', () => {
		const s = selector('.featured .card-title');
		deepStrictEqual(s.steps.map(x => x.text), ['.card-title', '.featured .card-title']);
		strictEqual(s.steps[0].hits, 2, 'both card titles match the rightmost compound');
		strictEqual(s.steps[1].hits, 1, 'only one of them has a .featured ancestor');
	});

	it('leaves a single-compound selector as its own only step', () => {
		deepStrictEqual(selector('.card').steps.map(x => x.text), ['.card']);
	});
});

describe('renderDocument', () => {
	it('writes a standalone document carrying the payload', () => {
		const html = renderDocument(payload);
		ok(html.startsWith('<!doctype html>'));
		ok(html.includes('<title>Backflip CSS Trace</title>'));
		ok(html.includes('id="explain-data"'));
		ok(!html.includes('</script><'), 'payload braces are escaped, not raw');
		// The embedded payload must survive a round trip out of the page.
		const json = html.slice(html.indexOf('id="explain-data">') + 'id="explain-data">'.length);
		const parsed = JSON.parse(json.slice(0, json.indexOf('</script>')).replace(/\\u003c/g, '<'));
		strictEqual(parsed.meta.counts.instances, payload.meta.counts.instances);
	});
});

describe('the generated page', () => {
	it('renders its tabs, tree and rail without the inline script throwing', () => {
		const errors: unknown[] = [];
		const virtualConsole = new VirtualConsole();
		virtualConsole.on('jsdomError', e => errors.push(e));
		const dom = new JSDOM(renderDocument(payload), {
			runScripts: 'dangerously',
			// The page loads a Google Fonts stylesheet; nothing else is external.
			resources: undefined,
			virtualConsole,
		});
		const doc = dom.window.document;

		deepStrictEqual(errors, [], 'the page script must not throw');
		deepStrictEqual(
			[...doc.querySelectorAll('.tab')].map(t => t.textContent?.replace(/^\d/, '').trim()),
			['Parse & roots', 'Expansion', 'Forest', 'Trace'],
		);
		strictEqual(doc.querySelector('.tab[aria-selected="true"]')?.textContent?.includes('Parse & roots'), true);

		// Tab 1 lists every parsed selector and every partial.
		strictEqual(doc.querySelectorAll('.panel')[0].querySelectorAll('tbody tr').length, payload.selectors.length);

		// The rail starts empty and fills when something is picked.
		ok(doc.getElementById('rail')!.textContent!.includes('Nothing selected'));
		(doc.querySelectorAll('.sel')[0] as any).click();
		ok(doc.getElementById('rail')!.textContent!.includes('Selector'));

		// The forest tab draws one row per instance.
		const forestTab = [...doc.querySelectorAll('.tab')].find(t => t.textContent!.includes('Forest'))! as any;
		forestTab.click();
		strictEqual(doc.querySelectorAll('#view .tree .row').length, payload.instances.length);

		dom.window.close();
	});
});

describe('summarize', () => {
	it('leads with the entry root and reports each match as hits of total', () => {
		const lines = summarize(payload).split('\n');
		const roots = lines.indexOf('ROOTS');
		ok(roots > 0);
		ok(lines[roots + 1].includes('article'), 'the entry root comes first');
		ok(lines[roots + 1].includes('entry point'));
		ok(lines.some(l => /card\b.*reached from 2 call sites/.test(l)));

		const text = lines.join('\n');
		ok(text.includes('.featured .card-title'));
		ok(/\.tag:first-child\s+conditional 1\/3/.test(text), 'a b-for positional match reads 1 of 3');
		ok(/\.card\s+definite\s+2\/2/.test(text));
	});

	it('names selectors that matched nothing', () => {
		const withMiss = { ...payload, selectors: payload.selectors.map((s, i) =>
			i === 0 ? { ...s, hits: [] } : s) };
		const text = summarize(withMiss);
		ok(text.includes('UNMATCHED SELECTORS (1)'));
		ok(text.includes(payload.selectors[0].text));
	});
});

describe('compile diagnostics', () => {
	/** The payload a run over a project the compiler complains about produces. */
	async function withWarnings() {
		const sources = new Map([
			['page.html', '<div b-name="page"><b-unwrap b-part="#missing" /></div>'],
		]);
		const { directory, errors } = await compileFiles(sources);
		ok(errors.length > 0, 'the fixture is meant to produce a diagnostic');
		return collectExplain({
			project: 'broken', compiled: directory.files, sources,
			cssContent: '.page { color: red }', cssFiles: ['x.css'],
			warnings: errors.map(e => e.message),
		});
	}

	it('carries them onto the page and into the summary', async () => {
		const broken = await withWarnings();
		ok(broken.meta.warnings.length > 0);
		const html = renderDocument(broken);
		ok(html.includes('compile diagnostic'), 'the page shows a diagnostics band');
		ok(html.includes(broken.meta.warnings[0].replace(/</g, '&lt;').replace(/&/g, '&amp;')) ||
			html.includes(broken.meta.warnings[0]), 'the message itself is on the page');
		ok(summarize(broken).includes('COMPILE DIAGNOSTICS'));
	});

	it('folds them away, so a long list does not take the page', async () => {
		// On a real project this list runs to hundreds of lines. Closed, the count
		// is still visible; open, the list is capped and scrolls.
		const broken = await withWarnings();
		const errors: unknown[] = [];
		const virtualConsole = new VirtualConsole();
		virtualConsole.on('jsdomError', e => errors.push(e));
		const dom = new JSDOM(renderDocument(broken), { runScripts: 'dangerously', virtualConsole });
		deepStrictEqual(errors, [], 'the page script must not throw');

		const band = dom.window.document.getElementById('diags') as HTMLDetailsElement | null;
		ok(band, 'the diagnostics band is there');
		strictEqual(band.tagName, 'DETAILS');
		strictEqual(band.open, false, 'it starts closed');
		const summaryEl = band.querySelector('summary');
		ok(summaryEl, 'closed, it still says how many there are');
		ok(summaryEl.textContent!.includes(`${broken.meta.warnings.length} compile diagnostic`));
		strictEqual(band.querySelectorAll('li').length, broken.meta.warnings.length);

		// Opening it is what the reader does; the script records that and must
		// not fall over doing so.
		band.open = true;
		band.dispatchEvent(new dom.window.Event('toggle'));
		deepStrictEqual(errors, [], 'toggling must not throw');
	});

	it('caps how many reach the terminal', () => {
		const many = {
			...payload,
			meta: { ...payload.meta, warnings: Array.from({ length: 50 }, (_, i) => `problem ${i}`) },
		};
		const text = summarize(many);
		ok(text.includes('COMPILE DIAGNOSTICS (50)'), 'the real count is still reported');
		ok(text.includes('problem 0'));
		ok(!text.includes('problem 49'));
		ok(text.includes('and 30 more'));
	});

	it('still analyses what did compile', async () => {
		const broken = await withWarnings();
		strictEqual(broken.meta.counts.instances, 1, 'the page div still expands');
	});

	it('says nothing when a project compiles cleanly', () => {
		deepStrictEqual(payload.meta.warnings, []);
		ok(!renderDocument(payload).includes('compile diagnostic'));
		ok(!summarize(payload).includes('COMPILE DIAGNOSTICS'));
	});
});
