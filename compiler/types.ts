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

export interface ChildTNode {
	parent: ParentTNode
}
export interface RootTNode {
	type: 'root',
	tnodes: TNode[],
	loc?: SourceLoc,
	exported?: boolean,
	customElement?: boolean,
	definitionAttrNames?: string[],  // effective attribute names on the definition's wrapping tag (custom element partials only)
	definitionAttrNodes?: TNode[],   // attrs-only TNodes for the definition's wrapping tag (custom element partials only). Excludes the leading `<tagName` and trailing `>`. Renders the definition's attrs in childCtx at call sites.
	bAttrs?: { name: string; isBool: boolean; loc?: SourceLoc }[],  // declared b-attr:* directives on the custom element definition tag (custom element partials only)
	meta?: PartialMeta
}
export interface RawTNode extends ChildTNode {
	type: 'raw',
	raw: string
}
export interface PrintTNode extends ChildTNode {	// for outputing {{ foo }} into HTML (do escaping)
	type: 'print',
	data: Parsed,
	loc?: SourceLoc
}
export interface ForTNode extends ChildTNode {
	type: 'for',
	iterable: Parsed,
	valName: string,
	tnodes: TNode[],
	loc?: SourceLoc
}
export interface IfBranch {
	condition?: Parsed,
	tnodes: TNode[],
	ifNode: IfTNode,
	loc?: SourceLoc
}
export interface IfTNode extends ChildTNode {
	type: 'if',
	branches: IfBranch[]
}

export interface SlotTNode extends ChildTNode {
	type: 'slot',
	name: string | undefined,   // undefined = default slot
	loc?: SourceLoc
}
export interface PartialBinding {
	name: string,
	data?: Parsed,                  // present for expression bindings (b-data, or b-attr expression form)
	literal?: string | boolean,     // present for literal-value bindings (b-attr plain attribute or bare boolean)
	cast?: 'bool' | 'string',       // applied at runtime to evaluated `data` (for b-attr expression bindings)
	nameLoc?: SourceLoc,             // location of just the NAME portion in `b-data:NAME` (excludes the `b-data:` prefix)
}
export interface PartialRefTNode extends ChildTNode {
	type: 'partial-ref',
	file: string | null,        // null = same-file reference (b-part="#name")
	partialName: string,
	wrapper: { open: string, close: string } | null,  // null if <b-unwrap b-part>
	slots: { [slotName: string]: TNode[] },            // 'default' for unnamed
	slotLocs?: { [slotName: string]: SourceLoc },       // source locations for b-in attributes
	bindings: PartialBinding[],
	loc?: SourceLoc,
	customElement?: boolean,    // true when this came from a custom element call site (e.g. <my-card>)
	callerOpenTag?: TNode[],    // for customElement calls: the call-site opening tag broken into TNodes (rendered in caller ctx).
	callerTagName?: string,     // for customElement calls: the call-site tag name (= the partial name, but kept explicit for symmetry)
	callerAttrNames?: string[], // for customElement calls: effective attribute names on the call-site tag (used for conflict validation)
	callerAttrInfos?: {
		name: string;             // effective attr name (after stripping b-bind: / : / trailing ~)
		kind: 'plain' | 'expr';   // plain = static HTML attr (bare or with literal value); expr = b-bind:/: with backcode
		value: string;            // raw value from the source ('' for bare boolean)
		expr?: Parsed;            // parsed backcode for kind='expr'
		loc?: SourceLoc;
	}[],                          // for customElement calls: rich per-attribute info used for b-attr resolution and conflict checks
	unresolvedRaw?: string      // for customElement calls: the raw text of the call-site open tag, used as fallback if the partial can't be resolved
}

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

export interface AttrBindTNode extends ChildTNode {
	type: 'attr-bind'
	tagOpen: string   // e.g. `<a`
	parts: AttrPart[]
	selfClosing?: boolean
	attrsOnly?: boolean   // when true, suppress tagOpen prefix and the trailing `>`/` />`. Used by custom element partials so their open-tag attrs can be merged into a single rendered tag.
}

export interface AssetRefTNode extends ChildTNode {
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
