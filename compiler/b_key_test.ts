import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { compileFile, findElement } from "./test-helpers.ts";
import { inferDataShape, validateGeneratedPartialInputs } from "./data-shape.ts";
import type { CustomElementPartialRoot, ForTNode, RootTNode, TNode } from "./types.ts";

function fatal(errors: { severity?: string; message: string }[]): string[] {
	return errors.filter(e => e.severity !== 'warning').map(e => e.message);
}

function findFor(tnodes: TNode[]): ForTNode | undefined {
	for (const n of tnodes) {
		if (n.type === 'for') return n;
		if (n.type === 'element') {
			const found = findFor(n.tnodes);
			if (found) return found;
		}
	}
	return undefined;
}

const MISSING = 'needs a b-key';
const MISPLACED = 'b-key is only allowed with b-for';

// --- on the AST ---

Deno.test("b-key: is parsed onto the loop as an expression", async () => {
	const { compiled, errors } = await compileFile(`<ul b-name="p"><li b-for="w in ws" b-key="w.id">x</li></ul>`);
	assertEquals(fatal(errors), []);
	const loop = findFor(compiled.partials.get('p')!.tnodes)!;
	assert(loop.key);
	assertEquals(loop.key.vars, ['w']);
});

Deno.test("b-key: a loop without one has no key", async () => {
	const { compiled } = await compileFile(`<ul b-name="p"><li b-for="w in ws">x</li></ul>`);
	assertEquals(findFor(compiled.partials.get('p')!.tnodes)!.key, undefined);
});

Deno.test("b-key: is not a second flow directive", async () => {
	const { errors } = await compileFile(`<ul b-name="p"><li b-for="w in ws" b-key="w.id">x</li></ul>`);
	assert(!errors.some(e => e.message.includes('more than one b-attr')));
});

Deno.test("b-key: works on a b-unwrap loop", async () => {
	const { compiled, errors } = await compileFile(`<ul b-name="p"><b-unwrap b-for="w in ws" b-key="w.id"><li>a</li><li>b</li></b-unwrap></ul>`);
	assertEquals(fatal(errors), []);
	assertEquals(findFor(compiled.partials.get('p')!.tnodes)!.key!.vars, ['w']);
});

Deno.test("b-key: does not reach a rendered tag", async () => {
	const { compiled } = await compileFile(`<ul b-name="p"><li b-for="w in ws" b-key="w.id">x</li></ul>`);
	const li = findElement(findFor(compiled.partials.get('p')!.tnodes)!.tnodes, 'li')!;
	assert(!JSON.stringify(li.attrs).includes('b-key'), JSON.stringify(li.attrs));
});

Deno.test("b-key: does not reach a custom element call's attributes", async () => {
	const { compiled } = await compileFile(`<ul b-name="p"><my-card b-for="w in ws" b-key="w.id" :v="w"></my-card></ul>`);
	const call = findFor(compiled.partials.get('p')!.tnodes)!.tnodes.find(n => n.type === 'partial-ref')!;
	assert(call.type === 'partial-ref' && call.kind === 'custom-element');
	assert(!JSON.stringify(call.callerAttrs).includes('b-key'), JSON.stringify(call.callerAttrs));
	assertEquals(call.callerAttrInfos!.map(a => a.name), ['v']);
});

Deno.test("b-key: can use the loop's index", async () => {
	const { compiled, errors } = await compileFile(`<ul b-name="p"><li b-for="w, i in ws" b-key="i">x</li></ul>`);
	assertEquals(fatal(errors), []);
	assertEquals(findFor(compiled.partials.get('p')!.tnodes)!.key!.vars, ['i']);
});

// --- required in a partial that generates client JS ---

for (const mode of ['render', 'base', 'full']) {
	Deno.test(`b-key: missing with b-generate="${mode}" is an error`, async () => {
		const { errors } = await compileFile(`<my-widget b-generate="${mode}"><li b-for="w in ws">x</li></my-widget>`);
		assertStringIncludes(fatal(errors).join(' | '), MISSING);
	});
}

Deno.test("b-key: missing with b-script, which implies generation, is an error", async () => {
	const { errors } = await compileFile(`<my-widget b-script="@scripts/w.js"><li b-for="w in ws">x</li></my-widget>`);
	const missing = errors.find(e => e.message.includes(MISSING));
	assert(missing, errors.map(e => e.message).join(' | '));
});

Deno.test("b-key: the missing error points at the b-for", async () => {
	const { errors } = await compileFile(`<my-widget b-generate="full">\n\t<li b-for="w in ws">x</li>\n</my-widget>`);
	const missing = errors.find(e => e.message.includes(MISSING))!;
	assertEquals(missing.line, 2);
	assertEquals(missing.severity === 'warning', false);
});

for (const [where, body] of Object.entries({
	'inside an element': `<ul><li b-for="w in ws">x</li></ul>`,
	'on a b-unwrap': `<b-unwrap b-for="w in ws"><li>x</li></b-unwrap>`,
	'on a custom element call': `<my-card b-for="w in ws"></my-card>`,
	'in a b-if branch': `<div b-if="on"><li b-for="w in ws">x</li></div>`,
	'in slot content': `<my-card><li b-for="w in ws">x</li></my-card>`,
	'nested in a keyed loop': `<ul b-for="r in rs" b-key="r.id"><li b-for="w in r.ws">x</li></ul>`,
})) {
	Deno.test(`b-key: missing ${where} of a generating partial is an error`, async () => {
		const { errors } = await compileFile(`<my-widget b-generate="full">${body}</my-widget>`);
		assertStringIncludes(fatal(errors).join(' | '), MISSING);
	});
}

Deno.test("b-key: present in a generating partial reports nothing", async () => {
	const { errors } = await compileFile(`<my-widget b-generate="full"><ul b-for="r in rs" b-key="r.id"><li b-for="w in r.ws" b-key="w.id">x</li></ul></my-widget>`);
	assert(!errors.some(e => e.message.includes(MISSING)), errors.map(e => e.message).join(' | '));
});

for (const [where, html] of Object.entries({
	'a b-name partial': `<ul b-name="p"><li b-for="w in ws">x</li></ul>`,
	'a custom element partial that generates nothing': `<my-widget><li b-for="w in ws">x</li></my-widget>`,
})) {
	Deno.test(`b-key: not required in ${where}`, async () => {
		const { errors } = await compileFile(html);
		assertEquals(fatal(errors), []);
	});
}

// --- misplaced or malformed ---

for (const [where, html] of Object.entries({
	'with no flow directive': `<ul b-name="p"><li b-key="x">x</li></ul>`,
	'with b-if': `<ul b-name="p"><li b-if="x" b-key="x">x</li></ul>`,
	'on a custom element call': `<ul b-name="p"><my-card b-key="x"></my-card></ul>`,
	'on a slot-routing b-unwrap': `<ul b-name="p"><my-card><b-unwrap b-in="s" b-key="x"></b-unwrap></my-card></ul>`,
})) {
	Deno.test(`b-key: ${where} is an error`, async () => {
		const { errors } = await compileFile(html);
		assertStringIncludes(fatal(errors).join(' | '), MISPLACED);
	});
}

for (const [where, html] of Object.entries({
	'a b-name definition': `<ul b-name="p" b-key="x"></ul>`,
	'a custom element definition': `<my-widget b-key="x"></my-widget>`,
})) {
	Deno.test(`b-key: on ${where} is an error, reported once`, async () => {
		const { errors } = await compileFile(html);
		assertEquals(errors.filter(e => e.message.includes('b-key')).length, 1, errors.map(e => e.message).join(' | '));
	});
}

Deno.test("b-key: with no value is an error", async () => {
	const { errors } = await compileFile(`<ul b-name="p"><li b-for="w in ws" b-key>x</li></ul>`);
	assertStringIncludes(fatal(errors).join(' | '), 'b-key requires a value');
});

Deno.test("b-key: with an invalid expression is an error", async () => {
	const { errors } = await compileFile(`<ul b-name="p"><li b-for="w in ws" b-key="w.">x</li></ul>`);
	assert(fatal(errors).length > 0);
});

// --- the variables it reads ---

async function generatingRoot(html: string): Promise<RootTNode> {
	const { compiled } = await compileFile(html);
	return compiled.partials.get('my-widget') as CustomElementPartialRoot;
}

Deno.test("b-key: loop names are in scope, so they need no declaration", async () => {
	const root = await generatingRoot(`<my-widget b-attr:ws b-generate="full"><li b-for="w, i in ws" b-key="w.id + i">x</li></my-widget>`);
	assertEquals(validateGeneratedPartialInputs(root, 'my-widget', 'f.html'), []);
});

Deno.test("b-key: an undeclared variable in a generating partial is an error", async () => {
	const root = await generatingRoot(`<my-widget b-attr:ws b-generate="full"><li b-for="w in ws" b-key="w.id + other">x</li></my-widget>`);
	const errors = validateGeneratedPartialInputs(root, 'my-widget', 'f.html');
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'other');
});

Deno.test("b-key: what it reads off the item is part of the item's shape", async () => {
	const { compiled } = await compileFile(`<ul b-name="p"><li b-for="w in ws" b-key="w.id">x</li></ul>`);
	const shape = inferDataShape(compiled.partials.get('p')!).get('ws')!;
	assert(shape.elementShape?.properties?.has('id'), JSON.stringify(shape));
});
