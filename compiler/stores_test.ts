import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { readStoreFile, buildStoreTable, readStoreFiles } from './stores.ts';

const IMPORT = `import { BackflipStore } from '/bfdom/runtime/dom-patch/stores.js';\n`;

function read(src: string) {
	return readStoreFile(src, '/p/stores/s.js');
}

function onlyError(src: string): { message: string, line?: number, col?: number, endCol?: number, severity: string } {
	const { decl, errors } = read(src);
	assertEquals(decl, undefined);
	assertEquals(errors.length, 1, errors.map(e => e.message).join('\n'));
	return errors[0];
}

Deno.test("readStoreFile: new BackflipStore('name') declares the store", () => {
	const { decl, errors } = read(IMPORT + `export default new BackflipStore('widgets');\n`);
	assertEquals(errors, []);
	assertEquals(decl!.name, 'widgets');
	assertEquals(decl!.file, '/p/stores/s.js');
	assertEquals(decl!.nameLoc.startLine, 2);
	assertEquals(decl!.nameLoc.startCol, 34);
	assertEquals(decl!.nameLoc.endCol, 43);
});

Deno.test("readStoreFile: a subclass declared in the file declares the store", () => {
	const { decl, errors } = read(IMPORT + `class Widgets extends BackflipStore {
	ownedBy(owner) { return Object.values(this.data).filter((w) => w.owner === owner); }
}
export default new Widgets('widgets');\n`);
	assertEquals(errors, []);
	assertEquals(decl!.name, 'widgets');
});

Deno.test("readStoreFile: an exported subclass declares the store", () => {
	const { decl, errors } = read(IMPORT + `export class Widgets extends BackflipStore {}\nexport default new Widgets('widgets');\n`);
	assertEquals(errors, []);
	assertEquals(decl!.name, 'widgets');
});

Deno.test("readStoreFile: module-level code and other exports are allowed", () => {
	const { decl, errors } = read(IMPORT + `const x = 1;\nexport function helper() { return x; }\nexport default new BackflipStore('widgets');\n`);
	assertEquals(errors, []);
	assertEquals(decl!.name, 'widgets');
});

Deno.test("readStoreFile: a syntax error is reported at its position", () => {
	const e = onlyError(`export default new BackflipStore('widgets'\n`);
	assertStringIncludes(e.message, 'store file does not parse');
	assertEquals(e.line, 2);
});

Deno.test("readStoreFile: no default export", () => {
	const e = onlyError(IMPORT + `export const widgets = new BackflipStore('widgets');\n`);
	assertStringIncludes(e.message, 'store file has no default export');
	assertEquals(e.line, 1);
});

Deno.test("readStoreFile: a default export that is not a new expression", () => {
	const e = onlyError(IMPORT + `const w = new BackflipStore('widgets');\nexport default w;\n`);
	assertStringIncludes(e.message, 'the default export of a store file must be');
	assertEquals(e.line, 3);
	assertEquals(e.col, 16);
});

Deno.test("readStoreFile: a constructor that is not a class in the file", () => {
	const e = onlyError(IMPORT + `import { Widgets } from './w.js';\nexport default new Widgets('widgets');\n`);
	assertStringIncludes(e.message, 'Widgets is not a class declared in this store file');
	assertEquals(e.line, 3);
	assertEquals(e.col, 20);
});

Deno.test("readStoreFile: a class that does not extend BackflipStore", () => {
	const e = onlyError(`class Base {}\nclass Widgets extends Base {}\nexport default new Widgets('widgets');\n`);
	assertStringIncludes(e.message, 'class Widgets must extend BackflipStore');
	assertEquals(e.line, 2);
	assertEquals(e.col, 23);
});

Deno.test("readStoreFile: a class with no superclass", () => {
	const e = onlyError(`class Widgets {}\nexport default new Widgets('widgets');\n`);
	assertStringIncludes(e.message, 'class Widgets must extend BackflipStore');
	assertEquals(e.line, 1);
});

Deno.test("readStoreFile: the name must be a string literal", () => {
	for (const arg of [`name`, `'a' + 'b'`, `\`widgets\``, `42`]) {
		const e = onlyError(IMPORT + `const name = 'w';\nexport default new BackflipStore(${arg});\n`);
		assertStringIncludes(e.message, 'the store name must be the one argument to the constructor, as a string literal');
		assertEquals(e.line, 3);
		assertEquals(e.col, 34);
	}
});

Deno.test("readStoreFile: the constructor takes exactly one argument", () => {
	const none = onlyError(IMPORT + `export default new BackflipStore();\n`);
	assertStringIncludes(none.message, 'as a string literal');
	assertEquals(none.col, 16);
	const two = onlyError(IMPORT + `export default new BackflipStore('a', 'b');\n`);
	assertStringIncludes(two.message, 'as a string literal');
});

Deno.test("readStoreFile: a method overriding a BackflipStore member", () => {
	for (const member of [`data() { return 1; }`, `get data() { return 1; }`, `data = 1;`]) {
		const { decl, errors } = read(IMPORT + `class Widgets extends BackflipStore {\n\t${member}\n}\nexport default new Widgets('widgets');\n`);
		assertEquals(decl!.name, 'widgets');
		assertEquals(errors.length, 1);
		assertStringIncludes(errors[0].message, 'Widgets.data overrides a BackflipStore member');
		assertEquals(errors[0].line, 3);
	}
});

Deno.test("readStoreFile: static and other members are not overrides", () => {
	const { errors } = read(IMPORT + `class Widgets extends BackflipStore {\n\tstatic data = 1;\n\tdatum() {}\n}\nexport default new Widgets('widgets');\n`);
	assertEquals(errors, []);
});

Deno.test("readStoreFile: a name that is not a valid identifier", () => {
	for (const name of ['my-widgets', '1widgets', 'class', 'true', 'this', '']) {
		const e = onlyError(IMPORT + `export default new BackflipStore('${name}');\n`);
		assertStringIncludes(e.message, `store name "${name}" is not a valid identifier`);
		assertEquals(e.line, 2);
	}
});

Deno.test("readStoreFile: uppercase letters in the name are a warning", () => {
	const { decl, errors } = read(IMPORT + `export default new BackflipStore('myWidgets');\n`);
	assertEquals(decl!.name, 'myWidgets');
	assertEquals(errors.length, 1);
	assertEquals(errors[0].severity, 'warning');
	assertStringIncludes(errors[0].message, 'contains uppercase letters');
});

Deno.test("buildStoreTable: maps names to files, with src for served files", () => {
	const files = new Map([
		['/p/static/stores/widgets.js', IMPORT + `export default new BackflipStore('widgets');\n`],
		['/p/server/stores/users.js', IMPORT + `export default new BackflipStore('users');\n`],
	]);
	const { stores, errors } = buildStoreTable(files, new Map([['static', '/p/static'], ['st', '/p/static/stores']]));
	assertEquals(errors, []);
	assertEquals(stores.get('widgets')!.file, '/p/static/stores/widgets.js');
	assertEquals(stores.get('widgets')!.src, '@st/widgets.js');
	assertEquals(stores.get('users')!.src, undefined);
});

Deno.test("buildStoreTable: two files declaring the same name are an error on both", () => {
	const files = new Map([
		['/p/stores/a.js', IMPORT + `export default new BackflipStore('widgets');\n`],
		['/p/stores/b.js', `\n` + IMPORT + `export default new BackflipStore('widgets');\n`],
	]);
	const { stores, errors } = buildStoreTable(files);
	assertEquals(stores.size, 0);
	assertEquals(errors.length, 2);
	assertEquals(errors.map(e => [e.filename, e.line]), [['/p/stores/a.js', 2], ['/p/stores/b.js', 3]]);
	assertStringIncludes(errors[0].message, 'store "widgets" is also declared in /p/stores/b.js');
	assertStringIncludes(errors[1].message, 'store "widgets" is also declared in /p/stores/a.js');
});

Deno.test("readStoreFiles: finds *.js files under each dir, recursively", async () => {
	const dir = path.join('/tmp/claude-1000', `stores_test_${Date.now()}`);
	await fs.mkdir(path.join(dir, 'a/sub'), { recursive: true });
	await fs.mkdir(path.join(dir, 'b'), { recursive: true });
	await fs.writeFile(path.join(dir, 'a/one.js'), 'one');
	await fs.writeFile(path.join(dir, 'a/sub/two.js'), 'two');
	await fs.writeFile(path.join(dir, 'a/notes.txt'), 'x');
	await fs.writeFile(path.join(dir, 'b/three.js'), 'three');
	const files = await readStoreFiles([path.join(dir, 'a'), path.join(dir, 'b'), path.join(dir, 'missing')]);
	assertEquals([...files.keys()].map(f => path.relative(dir, f)).sort(), ['a/one.js', 'a/sub/two.js', 'b/three.js']);
	assertEquals(files.get(path.join(dir, 'a/sub/two.js')), 'two');
});
