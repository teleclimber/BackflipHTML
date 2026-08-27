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
	definitionAttrs?: AttrPart[],    // attr-parts for the definition's wrapping tag. Renders the definition's attrs in childCtx at call sites.
	bAttrs?: { name: string; isBool: boolean; loc?: SourceLoc }[],  // declared b-attr:* directives on the custom element definition tag
	scripts?: PartialScript[],       // scripts the renderer auto-includes for this partial. 'entry' items come from b-script (an @name/... path until resolveAssetRefs rewrites it); 'dependency' items are the generated dom-patch module, stamped by applyDomPatch.
}

// A script the renderer auto-includes when a reactive custom-element partial is
// rendered. `kind` decides how it is injected:
//  - 'entry'      → <script type="module" src> (an executed module, e.g. the hand-coded web component)
//  - 'dependency' → <link rel="modulepreload" href> (a module imported by an entry, preloaded for performance)
// `url` may be an unresolved "@name/subpath" asset path until resolveAssetRefs rewrites it.
export interface PartialScript {
	url: string,
	kind: 'entry' | 'dependency',
}
export type RootTNode = NamedPartialRoot | CustomElementPartialRoot;
export interface RawTNode {
	type: 'raw',
	raw: string
}
export interface CommentTNode {	// an HTML comment <!--text-->, emitted verbatim
	type: 'comment',
	text: string,
	loc?: SourceLoc
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
}

export interface CustomElementCallTNode extends BasePartialCall {
	kind: 'custom-element',
	callerAttrs?: AttrPart[],   // the call-site attrs (rendered in caller ctx, merged with the definition's attrs into one tag)
	callerTagName?: string,     // the call-site tag name (= the partial name, but kept explicit for symmetry)
	callerAttrNames?: string[], // effective attribute names on the call-site tag (used for conflict validation)
	callerAttrInfos?: {
		name: string;             // effective attr name (after stripping b-bind: / : / trailing ~)
		kind: 'plain' | 'expr';   // plain = static HTML attr (bare or with literal value); expr = b-bind:/: with backcode
		value: string;            // raw value from the source ('' for bare boolean)
		bare?: boolean;           // kind='plain' written with no value at all (`premium`),
		                          // as opposed to an explicit empty value (`premium=""`)
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
	| { type: 'asset'; attrName: string; originalValue: string; refs: AssetRef[]; quote?: string; loc?: SourceLoc }

export interface ElementTNode {
	type: 'element',
	tagName: string,           // e.g. 'div'. Lowercase per HTML.
	attrs: AttrPart[],         // unified static + dynamic + asset
	tnodes: TNode[],           // body content (empty for void/self-closing)
	selfClosing?: boolean,     // emitted as ` />` when set on a void or XHTML self-close
	isVoid?: boolean,          // 'area', 'br', 'img', etc. (no close tag in output)
	loc?: SourceLoc,           // location of the full element (open through close)
	openTagLoc?: SourceLoc,    // location of just `<tagName ...>` for LSP
	closeTagLoc?: SourceLoc,   // location of just `</tagName>` (absent for void/self-closing)
}

// Produced by flattenStatics when an ElementTNode has dynamic attrs but its
// children are otherwise leaf-flat (raw / attr-bind). Represents just the
// attribute slot of an open tag — the surrounding `<tagName`, `>`/` />`, and
// `</tagName>` are emitted as separate RawTNode siblings, letting the parent's
// flattening coalesce static structure across the element boundary.
export interface AttrBindTNode {
	type: 'attr-bind',
	attrs: AttrPart[],   // both static and dynamic, rendered in order
	loc?: SourceLoc,
}

export type TNode = RawTNode | CommentTNode | PrintTNode | ForTNode | IfTNode | SlotTNode | PartialRefTNode | ElementTNode | AttrBindTNode;
export type ParentTNode = RootTNode | ForTNode | IfBranch | ElementTNode;

export interface AssetRef {
	name: string;    // the @name part
	subpath: string; // everything after @name/
	loc?: SourceLoc; // location of the full @name/subpath
	subpathLoc?: SourceLoc; // location of the subpath part
}

/**
 * Rebase deltas applied to every location the compiler emits, translating
 * slice-relative coordinates to file-relative ones. Columns are NOT shifted:
 * slices are complete lines, so column values are already file-correct.
 */
export interface LocBase {
	line: number;    // 0-based delta added to every startLine/endLine (def.loc.from - 1)
	offset: number;  // char delta added to every startOffset/endOffset
}

export interface CompileOptions {
	includeLocs?: boolean;
	locBase?: LocBase;                 // absent = {line: 0, offset: 0}: locations stay slice-relative
	assetMap?: Map<string, string>;    // @name -> replacement prefix
	assetDirs?: Map<string, string>;   // @name -> absolute dir path (for file existence checks)
}
