import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { generateSlotPlaceholders } from './slot-placeholders.ts';

Deno.test("generates placeholder for default slot", () => {
	const slotMap = generateSlotPlaceholders(['default']);
	assertEquals('default' in slotMap, true);
	assertEquals(slotMap.default.nodes.length, 1);
	const raw = slotMap.default.nodes[0];
	assertEquals(raw.type, 'raw');
	assertStringIncludes((raw as any).raw, 'default content');
});

Deno.test("generates placeholder for named slot", () => {
	const slotMap = generateSlotPlaceholders(['header']);
	assertEquals('header' in slotMap, true);
	const raw = slotMap.header.nodes[0];
	assertStringIncludes((raw as any).raw, 'slot: header');
});

Deno.test("generates multiple slots", () => {
	const slotMap = generateSlotPlaceholders(['default', 'header', 'footer']);
	assertEquals(Object.keys(slotMap).length, 3);
	assertStringIncludes((slotMap.default.nodes[0] as any).raw, 'default content');
	assertStringIncludes((slotMap.header.nodes[0] as any).raw, 'slot: header');
	assertStringIncludes((slotMap.footer.nodes[0] as any).raw, 'slot: footer');
});

Deno.test("slot placeholder has empty context", () => {
	const slotMap = generateSlotPlaceholders(['default']);
	assertEquals(slotMap.default.ctx, {});
});

Deno.test("empty slot names returns empty map", () => {
	const slotMap = generateSlotPlaceholders([]);
	assertEquals(Object.keys(slotMap).length, 0);
});

Deno.test("placeholder HTML has dashed border styling", () => {
	const slotMap = generateSlotPlaceholders(['default']);
	const raw = (slotMap.default.nodes[0] as any).raw;
	assertStringIncludes(raw, 'border:1px dashed');
	assertStringIncludes(raw, 'background:#e0e0e0');
});
