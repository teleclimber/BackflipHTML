import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { compileFiles, type StoreTable, type CompiledFile } from '@backflip/html';
import { storeAtCursor, variableAt } from './stores.js';
import { getHover } from './hover.js';
import { findStoreDefinition } from './definition.js';
import { getStoreCompletions } from './completion.js';
import { errorsToDiagnostics } from './diagnostics.js';
import { makeDoc, makeIndex } from './test-helpers.js';

const STORE_FILES = new Map([
	['/ws/static/stores/widgets.js', `export default new BackflipStore('widgets');\n`],
	['/ws/server/stores/users.js', `export default new BackflipStore('users');\n`],
]);

const LINES = [
	'<my-widget b-store:widgets b-attr:widget_id b-generate="full">',
	'\t<h3 :title="widgets.data.title">{{ widgets.data[widget_id].name }}</h3>',
	'</my-widget>',
	'<b-unwrap b-name="page" b-store:users>',
	'\t<p>{{ users.data.ann }} {{ "widgets" }} {{ x.widgets }}</p>',
	'\t<my-widget widget_id="1"></my-widget>',
	'</b-unwrap>',
];

async function compile(lines: string[]): Promise<{ file: CompiledFile; stores: StoreTable }> {
	const { directory, errors } = await compileFiles(new Map([['page.html', lines.join('\n')]]), {
		storeFiles: STORE_FILES, assetDirs: new Map([['static', '/ws/static']]), includeLocs: true,
	});
	const fatal = errors.filter(e => e.severity !== 'warning' && !e.message.includes('variable x'));
	strictEqual(fatal.length, 0, fatal.map(e => e.message).join('\n'));
	return { file: directory.files.get('page.html')!, stores: directory.stores };
}

function hoverText(hover: ReturnType<typeof getHover>): string {
	return hover ? decodeURIComponent((hover.contents as { value: string }).value) : '';
}

describe('variableAt', () => {
	it('finds a root identifier in an interpolation or an expression attribute', () => {
		strictEqual(variableAt('{{ widgets.data.a }}', 4), 'widgets');
		strictEqual(variableAt('<h3 :title="widgets.data">', 14), 'widgets');
		strictEqual(variableAt('<p b-if="on && widgets">', 18), 'widgets');
		strictEqual(variableAt('{{ m[widget_id] }}', 8), 'widget_id');
	});

	it('ignores properties, strings and text outside expressions', () => {
		strictEqual(variableAt('{{ x.widgets }}', 7), null);
		strictEqual(variableAt('{{ "widgets" }}', 6), null);
		strictEqual(variableAt('<p>widgets</p>', 5), null);
		strictEqual(variableAt('<p title="widgets">', 12), null);
	});
});

describe('storeAtCursor', () => {
	it('finds a b-store: attribute', async () => {
		const { file, stores } = await compile(LINES);
		const at = storeAtCursor(makeDoc(LINES), { line: 0, character: 15 }, file, stores)!;
		strictEqual(at.kind, 'declaration');
		strictEqual(at.name, 'widgets');
		strictEqual(at.partialName, 'my-widget');
		strictEqual(at.store!.file, '/ws/static/stores/widgets.js');
	});

	it('finds a store variable in a partial that declares it', async () => {
		const { file, stores } = await compile(LINES);
		const doc = makeDoc(LINES);
		strictEqual(storeAtCursor(doc, { line: 1, character: 15 }, file, stores)!.kind, 'variable');
		strictEqual(storeAtCursor(doc, { line: 1, character: 40 }, file, stores)!.name, 'widgets');
		strictEqual(storeAtCursor(doc, { line: 4, character: 8 }, file, stores)!.name, 'users');
	});

	it('ignores a name the enclosing partial does not declare as a store', async () => {
		const { file, stores } = await compile(LINES);
		const doc = makeDoc(LINES);
		strictEqual(storeAtCursor(doc, { line: 1, character: 55 }, file, stores), null);   // widget_id, a b-attr
		strictEqual(storeAtCursor(doc, { line: 4, character: 30 }, file, stores), null);   // "widgets", a string
		strictEqual(storeAtCursor(doc, { line: 4, character: 47 }, file, stores), null);   // x.widgets, a property
	});
});

describe('store hover', () => {
	it('shows that a variable is a store, with its declaration and file', async () => {
		const { file, stores } = await compile(LINES);
		const text = hoverText(getHover(makeDoc(LINES), { line: 1, character: 40 }, 'page.html', makeIndex([], []), null, null, '/ws/templates', null, file, stores));
		ok(text.includes('**Store** `widgets` — declared with `b-store:widgets` on `my-widget`'), text);
		ok(text.includes('Read its data as `widgets.data`.'), text);
		ok(text.includes('"path":"/ws/static/stores/widgets.js"'), text);
	});

	it('describes a b-store: attribute and whether the store is served', async () => {
		const { file, stores } = await compile(LINES);
		const doc = makeDoc(LINES);
		const served = hoverText(getHover(doc, { line: 0, character: 15 }, 'page.html', makeIndex([], []), null, null, '/ws/templates', null, file, stores));
		ok(served.includes('**`b-store:widgets`**'), served);
		ok(served.includes('Served as `@static/stores/widgets.js`.'), served);
		const unserved = hoverText(getHover(doc, { line: 3, character: 30 }, 'page.html', makeIndex([], []), null, null, '/ws/templates', null, file, stores));
		ok(unserved.includes('Not served'), unserved);
	});
});

describe('store definition', () => {
	it('goes from a variable to its b-store: attribute, and from there to the store file', async () => {
		const { file, stores } = await compile(LINES);
		const doc = makeDoc(LINES);
		const fromVar = findStoreDefinition(storeAtCursor(doc, { line: 1, character: 40 }, file, stores)!, 'file:///ws/templates/page.html');
		deepStrictEqual(fromVar, { uri: 'file:///ws/templates/page.html', range: { start: { line: 0, character: 11 }, end: { line: 0, character: 26 } } });
		const fromAttr = findStoreDefinition(storeAtCursor(doc, { line: 0, character: 15 }, file, stores)!, 'file:///ws/templates/page.html');
		deepStrictEqual(fromAttr, { uri: 'file:///ws/static/stores/widgets.js', range: { start: { line: 0, character: 33 }, end: { line: 0, character: 42 } } });
	});
});

describe('b-store: completion', () => {
	const STORES: StoreTable = new Map(['widgets', 'users'].map(name => [name, {
		name, file: `/ws/${name}.js`, nameLoc: { startLine: 1, startCol: 1, startOffset: 0, endLine: 1, endCol: 1, endOffset: 0 },
	}]));

	function labels(lines: string[], line: number, character: number): string[] {
		return getStoreCompletions(makeDoc(lines), { line, character }, STORES).map(i => i.label);
	}

	it('offers every declared store on a definition tag', () => {
		deepStrictEqual(labels(['<b-unwrap b-name="page" b-st'], 0, 28), ['b-store:widgets', 'b-store:users']);
		deepStrictEqual(labels(['<my-widget b-'], 0, 13), ['b-store:widgets', 'b-store:users']);
	});

	it('leaves out a store the tag already declares', () => {
		deepStrictEqual(labels(['<my-widget b-store:users b-st'], 0, 29), ['b-store:widgets']);
	});

	it('replaces the attribute name typed so far', () => {
		const items = getStoreCompletions(makeDoc(['<my-widget b-st']), { line: 0, character: 15 }, STORES);
		deepStrictEqual((items[0].textEdit as { range: unknown }).range, { start: { line: 0, character: 11 }, end: { line: 0, character: 15 } });
	});

	it('offers nothing on a call site, a nested element or inside a value', () => {
		deepStrictEqual(labels(['<b-unwrap b-name="page">', '\t<my-widget b-st'], 1, 16), []);
		deepStrictEqual(labels(['<b-unwrap b-name="page">', '\t<div b-st'], 1, 10), []);
		deepStrictEqual(labels(['<my-widget title="b-st'], 0, 22), []);
	});
});

describe('store file diagnostics', () => {
	it('are keyed by the store file\'s absolute path', async () => {
		const { errors } = await compileFiles(new Map(), { storeFiles: new Map([['/ws/stores/bad.js', 'export default 1;\n']]) });
		const diags = errorsToDiagnostics(errors);
		deepStrictEqual([...diags.keys()], ['/ws/stores/bad.js']);
		deepStrictEqual(diags.get('/ws/stores/bad.js')![0].range, { start: { line: 0, character: 15 }, end: { line: 0, character: 16 } });
	});
});
