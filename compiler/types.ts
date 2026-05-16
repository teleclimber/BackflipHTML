import type { Parsed } from './backcode.js';

export interface SourceLoc {
	startLine: number;    // 1-based
	startCol: number;     // 1-based
	startOffset: number;  // 0-based char index into the source file
	endLine: number;
	endCol: number;
	endOffset: number;    // points directly after the last character
}

export interface PartialMeta {
	startOffset: number;   // 0-based, start of opening tag '<'
	endOffset: number;     // 0-based, just past closing tag '>'
	startLine: number;     // 1-based
	startCol: number;      // 1-based
	isDocumentLevel: boolean;  // true if partial contains/is html, head, or body
}

interface BaseRoot {
	type: 'root',
	tnodes: TNode[],
	loc?: SourceLoc,
	exported?: boolean,
	meta?: PartialMeta,
}
export interface NamedPartialRoot extends BaseRoot {
	kind: 'named',
}
export interface CustomElementPartialRoot extends BaseRoot {
	kind: 'custom-element',
	definitionAttrNames?: string[],  // effective attribute names on the definition's wrapping tag
	definitionAttrNodes?: TNode[],   // attrs-only TNodes for the definition's wrapping tag. Excludes the leading `<tagName` and trailing `>`. Renders the definition's attrs in childCtx at call sites.
	bAttrs?: { name: string; isBool: boolean; loc?: SourceLoc }[],  // declared b-attr:* directives on the custom element definition tag
}
export type RootTNode = NamedPartialRoot | CustomElementPartialRoot;
export interface RawTNode {
	type: 'raw',
	raw: string
}
export interface PrintTNode {	// for outputing {{ foo }} into HTML (do escaping)
	type: 'print',
	data: Parsed,
	loc?: SourceLoc
}
export interface ForTNode {
	type: 'for',
	iterable: Parsed,
	valName: string,
	tnodes: TNode[],
	loc?: SourceLoc
}
export interface IfBranch {
	condition?: Parsed,
	tnodes: TNode[],
	loc?: SourceLoc
}
export interface IfTNode {
	type: 'if',
	branches: IfBranch[]
}

export interface SlotTNode {
	type: 'slot',
	name: string | undefined,   // undefined = default slot
	loc?: SourceLoc
}
export type PartialBinding =
	| { kind: 'expr'; name: string; data: Parsed; cast?: 'bool' | 'string'; nameLoc?: SourceLoc }
	| { kind: 'literal'; name: string; value: string | boolean; nameLoc?: SourceLoc };
interface BasePartialCall {
	type: 'partial-ref',
	file: string | null,        // null = same-file reference (b-part="#name")
	partialName: string,
	slots: { [slotName: string]: TNode[] },            // 'default' for unnamed
	slotLocs?: { [slotName: string]: SourceLoc },       // source locations for b-in attributes
	bindings: PartialBinding[],
	loc?: SourceLoc,
}

export interface BPartCallTNode extends BasePartialCall {
	kind: 'b-part',
	wrapper: { open: string, close: string } | null,  // null if <b-unwrap b-part>
}

export interface CustomElementCallTNode extends BasePartialCall {
	kind: 'custom-element',
	callerOpenTag?: TNode[],    // the call-site opening tag broken into TNodes (rendered in caller ctx).
	callerTagName?: string,     // the call-site tag name (= the partial name, but kept explicit for symmetry)
	callerAttrNames?: string[], // effective attribute names on the call-site tag (used for conflict validation)
	callerAttrInfos?: {
		name: string;             // effective attr name (after stripping b-bind: / : / trailing ~)
		kind: 'plain' | 'expr';   // plain = static HTML attr (bare or with literal value); expr = b-bind:/: with backcode
		value: string;            // raw value from the source ('' for bare boolean)
		expr?: Parsed;            // parsed backcode for kind='expr'
		loc?: SourceLoc;
	}[],                          // rich per-attribute info used for b-attr resolution and conflict checks
	unresolvedRaw?: string,     // raw text of the call-site open tag, used as fallback if the partial can't be resolved
}

export type PartialRefTNode = BPartCallTNode | CustomElementCallTNode;

export interface CompiledFile {
	partials: Map<string, RootTNode>  // partialName → compiled tree
}

export interface PartialDef {
	name: string;            // partial name (b-name value, or hyphenated tag name for custom element partials)
	exported: boolean;       // has b-export attribute
	customElement: boolean;  // true when defined as a top-level hyphenated tag (custom element partial)
	loc: {
		filename: string;    // relative path of the file that defines this partial
		from: number;        // 1-based line number of the opening tag
		to: number;          // 1-based line number of the closing tag
	};
}

export type PartialRegistry = Map<string, PartialDef[]>
// key: relative file path e.g. "graphics/charts.html"
// value: list of partials (both b-name and custom-element) defined in that file

export type AttrPart =
	| { type: 'static'; raw: string }
	| { type: 'dynamic'; name: string; expr: Parsed; isBoolean: boolean; isAsset?: boolean; loc?: SourceLoc }
	| { type: 'asset'; attrName: string; originalValue: string; refs: AssetRef[]; loc?: SourceLoc }

export interface AttrBindTNode {
	type: 'attr-bind'
	tagOpen: string   // e.g. `<a`
	parts: AttrPart[]
	selfClosing?: boolean
	attrsOnly?: boolean   // when true, suppress tagOpen prefix and the trailing `>`/` />`. Used by custom element partials so their open-tag attrs can be merged into a single rendered tag.
}

export interface AssetRefTNode {
	type: 'asset-ref'
	attrName: string          // e.g. "src", "srcset"
	originalValue: string     // e.g. "@images/photo.jpg"
	refs: AssetRef[]          // parsed refs (1 for src~, N for srcset~)
	loc?: SourceLoc
}

export type TNode = RawTNode | PrintTNode | ForTNode | IfTNode | SlotTNode | PartialRefTNode | AttrBindTNode | AssetRefTNode;
export type ParentTNode = RootTNode | ForTNode | IfBranch;

export interface AssetRef {
	name: string;    // the @name part
	subpath: string; // everything after @name/
	loc?: SourceLoc; // location of the full @name/subpath
	subpathLoc?: SourceLoc; // location of the subpath part
}

export interface CompileOptions {
	includeLocs?: boolean;
	assetMap?: Map<string, string>;    // @name -> replacement prefix
	assetDirs?: Map<string, string>;   // @name -> absolute dir path (for file existence checks)
}
