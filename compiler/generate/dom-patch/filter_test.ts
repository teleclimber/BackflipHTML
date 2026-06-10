import { assertEquals } from "jsr:@std/assert";

import type { ElementTNode, AttrPart, PrintTNode, ForTNode } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import type { BackcodeSite } from "./collect.ts";
import { qualifies } from "./filter.ts";

function makeAttrSite(
	attrCode: string,
	liveVars: string[],
	otherVars: string[],
	inForLoop = false,
): BackcodeSite {
	const attr: AttrPart = { type: 'dynamic', name: 'title', expr: interpretBackcode(attrCode), isBoolean: false };
	const element: ElementTNode = { type: 'element', tagName: 'div', attrs: [attr], tnodes: [] };
	return {
		site: { kind: 'attr', element, attr: attr as any },
		parsed: attr.type === 'dynamic' ? attr.expr : interpretBackcode(attrCode),
		liveVars, otherVars, inForLoop,
	};
}

function makePrintSite(
	code: string,
	liveVars: string[],
	otherVars: string[],
	inForLoop = false,
): BackcodeSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const container: PrintTNode[] = [node];
	return {
		site: { kind: 'print', node, container, parentElement: null },
		parsed: interpretBackcode(code),
		liveVars, otherVars, inForLoop,
	};
}

Deno.test("accepts pure-live print sites", () => {
	assertEquals(qualifies(makePrintSite('x', ['x'], [])), true);
});

Deno.test("print sites obey the cross-kind rules (no-live / mixed / in-for rejected)", () => {
	assertEquals(qualifies(makePrintSite('x', [], ['x'])), false);
	assertEquals(qualifies(makePrintSite('x + y', ['x'], ['y'])), false);
	assertEquals(qualifies(makePrintSite('x', ['x'], [], true)), false);
});

Deno.test("rejects still-unsupported kinds (e.g. for-iterable)", () => {
	const node: ForTNode = { type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [] };
	const site: BackcodeSite = {
		site: { kind: 'for-iterable', node },
		parsed: interpretBackcode('items'),
		liveVars: ['items'], otherVars: [], inForLoop: false,
	};
	assertEquals(qualifies(site), false);
});

Deno.test("rejects sites with no live vars (any kind)", () => {
	assertEquals(qualifies(makeAttrSite('bar', [], ['bar'])), false);
});

Deno.test("rejects sites that mix live and non-live vars", () => {
	assertEquals(qualifies(makeAttrSite('foo + bar', ['foo'], ['bar'])), false);
});

Deno.test("rejects sites inside for loop", () => {
	assertEquals(qualifies(makeAttrSite('foo', ['foo'], [], true)), false);
});

Deno.test("accepts attr sites that are pure-live", () => {
	assertEquals(qualifies(makeAttrSite('foo', ['foo'], [])), true);
});

Deno.test("accepts attr sites with multiple live vars", () => {
	assertEquals(qualifies(makeAttrSite('foo + bar', ['foo', 'bar'], [])), true);
});

Deno.test("accepts definition-root-attr sites that are pure-live", () => {
	const attr: AttrPart = { type: 'dynamic', name: 'class', expr: interpretBackcode('foo'), isBoolean: false };
	const site: BackcodeSite = {
		site: { kind: 'definition-root-attr', attr: attr as any },
		parsed: interpretBackcode('foo'),
		liveVars: ['foo'], otherVars: [], inForLoop: false,
	};
	assertEquals(qualifies(site), true);
});

Deno.test("composes with Array.prototype.filter for the standard use", () => {
	const ok = makeAttrSite('foo', ['foo'], []);
	const inFor = makeAttrSite('foo', ['foo'], [], true);
	const mixed = makeAttrSite('foo + bar', ['foo'], ['bar']);
	const filtered = [ok, inFor, mixed].filter(qualifies);
	assertEquals(filtered.length, 1);
	assertEquals(filtered[0], ok);
});
