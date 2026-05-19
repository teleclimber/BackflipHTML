import { assertEquals } from "jsr:@std/assert";

import type { ElementTNode, AttrPart, PrintTNode } from "../../types.ts";
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

Deno.test("rejects non-attr sites (v1: only attr kind is patchable)", () => {
	const printSite: BackcodeSite = {
		site: { kind: 'print', node: { type: 'print', data: interpretBackcode('x') } as PrintTNode },
		parsed: interpretBackcode('x'),
		liveVars: ['x'], otherVars: [], inForLoop: false,
	};
	assertEquals(qualifies(printSite), false);
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

Deno.test("composes with Array.prototype.filter for the standard use", () => {
	const ok = makeAttrSite('foo', ['foo'], []);
	const inFor = makeAttrSite('foo', ['foo'], [], true);
	const mixed = makeAttrSite('foo + bar', ['foo'], ['bar']);
	const filtered = [ok, inFor, mixed].filter(qualifies);
	assertEquals(filtered.length, 1);
	assertEquals(filtered[0], ok);
});
