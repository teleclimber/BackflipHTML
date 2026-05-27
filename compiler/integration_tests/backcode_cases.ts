/**
 * Test cases for cross-language backcode runtime equivalence.
 *
 * JS is the reference language: every `expected` value is what JS produces.
 * Other languages must match. Adding cases here automatically extends coverage
 * for every registered runtime adapter in backcode_test.ts.
 *
 * Inputs are keyed by variable name; the harness reorders them to match
 * `parsed.vars` from interpretBackcode().
 *
 * Excluded by design (for now): `undefined` and `NaN` inputs — they don't
 * survive JSON transport and have no portable PHP equivalent.
 */

export type TestCase = {
	name: string;
	code: string;
	inputs: Record<string, unknown>;
	expected: unknown;
};

export const cases: TestCase[] = [
	// -----------------------------------------------------------------
	// == / != with type mixing
	// -----------------------------------------------------------------
	{ name: "eq: 2 == '2'",                  code: "a == b", inputs: { a: 2, b: "2" },        expected: true  },
	{ name: "neq: 2 != '2'",                 code: "a != b", inputs: { a: 2, b: "2" },        expected: false },
	{ name: "eq: '5' == 5",                  code: "a == b", inputs: { a: "5", b: 5 },        expected: true  },
	{ name: "eq: null == null",              code: "a == b", inputs: { a: null, b: null },    expected: true  },
	{ name: "eq: null == 0 (JS false)",      code: "a == b", inputs: { a: null, b: 0 },       expected: false },
	{ name: "eq: null == '' (JS false)",     code: "a == b", inputs: { a: null, b: "" },      expected: false },
	{ name: "eq: false == 0",                code: "a == b", inputs: { a: false, b: 0 },      expected: true  },
	{ name: "eq: true == 1",                 code: "a == b", inputs: { a: true, b: 1 },       expected: true  },
	{ name: "eq: 0 == ''",                   code: "a == b", inputs: { a: 0, b: "" },         expected: true  },
	{ name: "eq: 'abc' == 0 (JS false)",     code: "a == b", inputs: { a: "abc", b: 0 },      expected: false },
	{ name: "eq: 'true' == true (JS false)", code: "a == b", inputs: { a: "true", b: true },  expected: false },
	{ name: "eq: '1' == true",               code: "a == b", inputs: { a: "1", b: true },     expected: true  },
	{ name: "eq: '5' == 5.0",                code: "a == b", inputs: { a: "5", b: 5.0 },      expected: true  },

	// -----------------------------------------------------------------
	// + (concat vs add) across primitive pairings
	// -----------------------------------------------------------------
	{ name: "add: 1 + 2",                    code: "a + b", inputs: { a: 1, b: 2 },           expected: 3        },
	{ name: "add: 'x' + 'y'",                code: "a + b", inputs: { a: "x", b: "y" },       expected: "xy"     },
	{ name: "add: 1 + '2' (concat)",         code: "a + b", inputs: { a: 1, b: "2" },         expected: "12"     },
	{ name: "add: '1' + 2 (concat)",         code: "a + b", inputs: { a: "1", b: 2 },         expected: "12"     },
	{ name: "add: '5' + '3' (concat)",       code: "a + b", inputs: { a: "5", b: "3" },       expected: "53"     },
	{ name: "add: null + 'x' (JS 'nullx')",  code: "a + b", inputs: { a: null, b: "x" },      expected: "nullx"  },
	{ name: "add: null + 1 (JS 1)",          code: "a + b", inputs: { a: null, b: 1 },        expected: 1        },
	{ name: "add: true + 'x' (JS 'truex')",  code: "a + b", inputs: { a: true, b: "x" },      expected: "truex"  },
	{ name: "add: false + 'x' (JS 'falsex')",code: "a + b", inputs: { a: false, b: "x" },     expected: "falsex" },
	{ name: "add: true + 1 (JS 2)",          code: "a + b", inputs: { a: true, b: 1 },        expected: 2        },
	{ name: "add: false + 1 (JS 1)",         code: "a + b", inputs: { a: false, b: 1 },       expected: 1        },
	{ name: "add: null + null (JS 0)",       code: "a + b", inputs: { a: null, b: null },     expected: 0        },
	{ name: "add: 'abc' + 5 (JS 'abc5')",    code: "a + b", inputs: { a: "abc", b: 5 },       expected: "abc5"   },
	{ name: "add: literal 'pre' + n",        code: "'pre' + n",     inputs: { n: 5 },         expected: "pre5"   },
	{ name: "add: literal 'count: ' + n",    code: "'count: ' + n", inputs: { n: 5 },         expected: "count: 5" },

	// -----------------------------------------------------------------
	// Truthiness via ! and ternary test
	// -----------------------------------------------------------------
	{ name: "truthy: '0' ? T : F (JS T)",    code: "a ? b : c", inputs: { a: "0",  b: "T", c: "F" }, expected: "T" },
	{ name: "truthy: 0 ? T : F",             code: "a ? b : c", inputs: { a: 0,    b: "T", c: "F" }, expected: "F" },
	{ name: "truthy: '' ? T : F",            code: "a ? b : c", inputs: { a: "",   b: "T", c: "F" }, expected: "F" },
	{ name: "truthy: null ? T : F",          code: "a ? b : c", inputs: { a: null, b: "T", c: "F" }, expected: "F" },
	{ name: "truthy: 'x' ? T : F",           code: "a ? b : c", inputs: { a: "x",  b: "T", c: "F" }, expected: "T" },
	{ name: "truthy: 1 ? T : F",             code: "a ? b : c", inputs: { a: 1,    b: "T", c: "F" }, expected: "T" },
	{ name: "not: !'0' (JS false)",          code: "!a",  inputs: { a: "0" },  expected: false },
	{ name: "not: !'' (JS true)",            code: "!a",  inputs: { a: "" },   expected: true  },
	{ name: "not: !0 (JS true)",             code: "!a",  inputs: { a: 0 },    expected: true  },
	{ name: "not: !1 (JS false)",            code: "!a",  inputs: { a: 1 },    expected: false },
	{ name: "not: !null (JS true)",          code: "!a",  inputs: { a: null }, expected: true  },
	{ name: "not: !'x' (JS false)",          code: "!a",  inputs: { a: "x" },  expected: false },
	{ name: "not: !!'0' (JS true)",          code: "!!a", inputs: { a: "0" },  expected: true  },

	// -----------------------------------------------------------------
	// Unary + / -
	// -----------------------------------------------------------------
	{ name: "unary: +'5'",                   code: "+a", inputs: { a: "5" },   expected: 5  },
	{ name: "unary: -'5'",                   code: "-a", inputs: { a: "5" },   expected: -5 },
	{ name: "unary: +null (JS 0)",           code: "+a", inputs: { a: null },  expected: 0  },
	{ name: "unary: +true (JS 1)",           code: "+a", inputs: { a: true },  expected: 1  },
	{ name: "unary: +false (JS 0)",          code: "+a", inputs: { a: false }, expected: 0  },

	// -----------------------------------------------------------------
	// Relational: < > <= >= across primitive pairings
	// -----------------------------------------------------------------
	// numbers
	{ name: "lt: 1 < 2",                      code: "a < b",  inputs: { a: 1, b: 2 },           expected: true  },
	{ name: "lt: 2 < 1",                      code: "a < b",  inputs: { a: 2, b: 1 },           expected: false },
	{ name: "lt: 1 < 1",                      code: "a < b",  inputs: { a: 1, b: 1 },           expected: false },
	{ name: "gt: 2 > 1",                      code: "a > b",  inputs: { a: 2, b: 1 },           expected: true  },
	{ name: "gt: 1 > 1",                      code: "a > b",  inputs: { a: 1, b: 1 },           expected: false },
	{ name: "lte: 1 <= 1",                    code: "a <= b", inputs: { a: 1, b: 1 },           expected: true  },
	{ name: "lte: 2 <= 1",                    code: "a <= b", inputs: { a: 2, b: 1 },           expected: false },
	{ name: "gte: 1 >= 1",                    code: "a >= b", inputs: { a: 1, b: 1 },           expected: true  },
	{ name: "gte: 1 >= 2",                    code: "a >= b", inputs: { a: 1, b: 2 },           expected: false },
	// floats
	{ name: "lt: 1.5 < 2",                    code: "a < b",  inputs: { a: 1.5, b: 2 },         expected: true  },
	{ name: "gte: 2.0 >= 2",                  code: "a >= b", inputs: { a: 2.0, b: 2 },         expected: true  },
	// strings (lexicographic)
	{ name: "lt: 'a' < 'b'",                  code: "a < b",  inputs: { a: "a",  b: "b" },      expected: true  },
	{ name: "lt: 'b' < 'a'",                  code: "a < b",  inputs: { a: "b",  b: "a" },      expected: false },
	{ name: "lt: 'apple' < 'banana'",         code: "a < b",  inputs: { a: "apple", b: "banana" }, expected: true },
	{ name: "lt: '5' < '10' (lex)",           code: "a < b",  inputs: { a: "5",  b: "10" },     expected: false },
	{ name: "lte: 'abc' <= 'abc'",            code: "a <= b", inputs: { a: "abc", b: "abc" },   expected: true  },
	{ name: "gt: 'b' > 'a'",                  code: "a > b",  inputs: { a: "b",  b: "a" },      expected: true  },
	// numeric string vs number (JS ToNumber on string side)
	{ name: "lt: '5' < 10 (numeric str)",     code: "a < b",  inputs: { a: "5",  b: 10 },       expected: true  },
	{ name: "gt: '10' > 5 (numeric str)",     code: "a > b",  inputs: { a: "10", b: 5 },        expected: true  },
	// non-numeric string vs number — JS: NaN → false (PHP `<` would say true)
	{ name: "lt: 'abc' < 10 (JS false, NaN)", code: "a < b",  inputs: { a: "abc", b: 10 },      expected: false },
	{ name: "lt: 10 < 'abc' (JS false, NaN)", code: "a < b",  inputs: { a: 10, b: "abc" },      expected: false },
	{ name: "lte: 'abc' <= 10 (JS false)",    code: "a <= b", inputs: { a: "abc", b: 10 },      expected: false },
	{ name: "gte: 'abc' >= 10 (JS false)",    code: "a >= b", inputs: { a: "abc", b: 10 },      expected: false },
	// null handling
	{ name: "lt: null < 1 (JS true, 0<1)",    code: "a < b",  inputs: { a: null, b: 1 },        expected: true  },
	{ name: "lt: null < 0 (JS false, 0<0)",   code: "a < b",  inputs: { a: null, b: 0 },        expected: false },
	{ name: "lte: null <= 0 (JS true)",       code: "a <= b", inputs: { a: null, b: 0 },        expected: true  },
	// null vs non-numeric string — JS: NaN → false (PHP would lex '' < 'a' → true)
	{ name: "lt: null < 'a' (JS false, NaN)", code: "a < b",  inputs: { a: null, b: "a" },      expected: false },
	{ name: "gt: 'a' > null (JS false, NaN)", code: "a > b",  inputs: { a: "a", b: null },      expected: false },
	// booleans coerce to numbers
	{ name: "lt: false < 1 (JS true)",        code: "a < b",  inputs: { a: false, b: 1 },       expected: true  },
	{ name: "lt: true < 2 (JS true)",         code: "a < b",  inputs: { a: true, b: 2 },        expected: true  },
	{ name: "lte: true <= 1 (JS true)",       code: "a <= b", inputs: { a: true, b: 1 },        expected: true  },
	{ name: "gt: true > 0 (JS true)",         code: "a > b",  inputs: { a: true, b: 0 },        expected: true  },

	// -----------------------------------------------------------------
	// Composed expressions: each test pokes multiple operators / member access
	// -----------------------------------------------------------------
	{ name: "compose: u.name + '!'",         code: "u.name + '!'",           inputs: { u: { name: "hi" } },                          expected: "hi!"  },
	{ name: "compose: a[k] (computed)",      code: "a[k]",                   inputs: { a: { x: 42 }, k: "x" },                       expected: 42     },
	{ name: "compose: a + b + c (string)",   code: "a + b + c",              inputs: { a: "x", b: "y", c: "z" },                     expected: "xyz"  },
	{ name: "compose: a + b + c (mixed)",    code: "a + b + c",              inputs: { a: 1, b: "y", c: 2 },                         expected: "1y2"  },
	{ name: "compose: !(a == b)",            code: "!(a == b)",              inputs: { a: 1, b: 2 },                                 expected: true   },
	{ name: "compose: !(a == b) ? c : d",    code: "!(a == b) ? c : d",      inputs: { a: 1, b: 1, c: "x", d: "y" },                 expected: "y"    },
	{ name: "compose: a + b == c (number)",  code: "a + b == c",             inputs: { a: 1, b: 2, c: 3 },                           expected: true   },
	{ name: "compose: a + b == 'xy'",        code: "a + b == 'xy'",          inputs: { a: "x", b: "y" },                             expected: true   },
	{ name: "compose: u.profile.name",       code: "u.profile.name",         inputs: { u: { profile: { name: "A" } } },              expected: "A"    },
	{ name: "compose: a[b[c]]",              code: "a[b[c]]",                inputs: { a: { x: 1, y: 2 }, b: { k: "y" }, c: "k" },   expected: 2      },
	{ name: "compose: ternary in concat",    code: "ok ? 'yes:' + n : 'no'", inputs: { ok: true, n: 5 },                             expected: "yes:5"},
	{ name: "compose: ternary else branch",  code: "ok ? 'yes:' + n : 'no'", inputs: { ok: false, n: 5 },                            expected: "no"   },
	{ name: "compose: u.role == 'admin'",    code: "u.role == 'admin'",      inputs: { u: { role: "admin" } },                       expected: true   },
	{ name: "compose: !u.active (0)",        code: "!u.active",              inputs: { u: { active: 0 } },                           expected: true   },
	{ name: "compose: !u.active ('0')",      code: "!u.active",              inputs: { u: { active: "0" } },                         expected: false  },
	{ name: "compose: u.age >= 18 (adult)",  code: "u.age >= 18",            inputs: { u: { age: 21 } },                             expected: true   },
	{ name: "compose: u.age >= 18 (minor)",  code: "u.age >= 18",            inputs: { u: { age: 17 } },                             expected: false  },
	{ name: "compose: a + b < c",            code: "a + b < c",              inputs: { a: 1, b: 2, c: 4 },                           expected: true   },
	{ name: "compose: !(a < b)",             code: "!(a < b)",               inputs: { a: 1, b: 2 },                                 expected: false  },
	{ name: "compose: a < b ? 'lo' : 'hi'",  code: "a < b ? 'lo' : 'hi'",    inputs: { a: 1, b: 2 },                                 expected: "lo"   },
];
