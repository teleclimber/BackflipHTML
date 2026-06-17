<?php
declare(strict_types=1);

/**
 * BackflipHTML PHP runtime renderer.
 * Mirrors runtime/js/render.ts exactly.
 */

/**
 * Loads a generated PHP file with static caching.
 *
 * The file is expected to return an associative array of partials via
 * return compact(...). PHP's require_once returns 1 on repeat calls, so
 * we use a static cache keyed by resolved path.
 */
function backflip_require(string $path): array
{
    static $cache = [];

    $resolved = realpath($path);
    if ($resolved === false) {
        throw new \RuntimeException("backflip_require: file not found: $path");
    }

    if (!array_key_exists($resolved, $cache)) {
        $result = require $resolved;
        $cache[$resolved] = $result;
    }

    return $cache[$resolved];
}

/**
 * Matches JS truthiness, NOT PHP's native truthiness.
 *
 * Falsy:  null, false, 0, 0.0, '' (empty string), NaN floats
 * Truthy: "0" (truthy in JS!), [] (truthy in JS!), any non-empty string,
 *         any array, any object
 */
function backflip_isTruthy(mixed $val): bool
{
    if ($val === null || $val === false) {
        return false;
    }
    if (is_float($val) && is_nan($val)) {
        return false;
    }
    if ($val === 0 || $val === 0.0) {
        return false;
    }
    if ($val === '') {
        return false;
    }
    // "0", [], objects, non-empty strings, non-zero numbers are all truthy in JS
    return true;
}

/**
 * JS-style ToString conversion. Mirrors ECMAScript ToString for the value
 * types reachable from backcode (null/bool/number/string).
 *
 *   null  -> "null"   (PHP native would give "")
 *   true  -> "true"   (PHP native would give "1")
 *   false -> "false"  (PHP native would give "")
 *   NaN   -> "NaN"
 *   ±Inf  -> "Infinity" / "-Infinity"
 */
function backflip_jsToString(mixed $v): string
{
    if ($v === null) return 'null';
    if ($v === true) return 'true';
    if ($v === false) return 'false';
    if (is_float($v)) {
        if (is_nan($v)) return 'NaN';
        if (is_infinite($v)) return $v > 0 ? 'Infinity' : '-Infinity';
    }
    return (string) $v;
}

/**
 * JS-style ToNumber. Returns int when possible (to preserve int vs float
 * distinction across the wire format used by integration tests). Non-numeric
 * strings return NaN (mirrors JS `Number('abc')`).
 */
function backflip_jsToNumber(mixed $v): int|float
{
    if ($v === null) return 0;
    if ($v === true) return 1;
    if ($v === false) return 0;
    if (is_int($v) || is_float($v)) return $v;
    if (is_string($v)) {
        $trimmed = trim($v);
        if ($trimmed === '') return 0;
        if (is_numeric($trimmed)) {
            // +0 dispatches to int or float based on the string contents
            return $trimmed + 0;
        }
        return NAN;
    }
    return NAN;
}

/**
 * JS-style `+` operator. If either operand is a string after ToPrimitive,
 * concatenate (with JS ToString rules); otherwise add (with JS ToNumber rules).
 *
 * PHP's `.` would coerce null→"", true→"1", false→""; JS produces "null",
 * "true", "false". PHP's `+` would also fail on non-numeric strings under
 * strict_types. This helper bridges both gaps.
 */
function backflip_jsPlus(mixed $a, mixed $b): mixed
{
    if (is_string($a) || is_string($b)) {
        return backflip_jsToString($a) . backflip_jsToString($b);
    }
    return backflip_jsToNumber($a) + backflip_jsToNumber($b);
}

/**
 * JS-style loose equality (`==`). Simplified ECMAScript Abstract Equality
 * Comparison for the value set reachable from backcode (no undefined, no
 * objects beyond plain arrays). Notably divergent from PHP `==`:
 *   - null only loosely-equals itself (PHP: null == 0, null == '', etc.)
 *   - 0 == '' is true (PHP 8 made this false)
 *   - 'true' == true is false (PHP coerces 'true' to true)
 */
function backflip_jsLooseEq(mixed $a, mixed $b): bool
{
    // Both numbers: PHP == compares int/float symmetrically; NaN != anything.
    if ((is_int($a) || is_float($a)) && (is_int($b) || is_float($b))) {
        return $a == $b;
    }
    // Same type otherwise: strict equality.
    if (gettype($a) === gettype($b)) {
        return $a === $b;
    }
    // null is loosely equal only to null (handled above) and undefined (n/a).
    if ($a === null || $b === null) {
        return false;
    }
    // Booleans coerce to number first (kept above string-vs-number so that
    // 'true' == true reduces to 'true' == 1 → NaN == 1 → false).
    if (is_bool($a)) {
        return backflip_jsLooseEq($a ? 1 : 0, $b);
    }
    if (is_bool($b)) {
        return backflip_jsLooseEq($a, $b ? 1 : 0);
    }
    // Number vs String: convert the string to number, then recurse.
    if ((is_int($a) || is_float($a)) && is_string($b)) {
        return backflip_jsLooseEq($a, backflip_jsToNumber($b));
    }
    if (is_string($a) && (is_int($b) || is_float($b))) {
        return backflip_jsLooseEq(backflip_jsToNumber($a), $b);
    }
    return false;
}

/**
 * JS-style `<` (Abstract Relational Comparison). If both operands are strings
 * after ToPrimitive, compare lexicographically; otherwise convert both via
 * ToNumber and compare. NaN on either side yields false.
 *
 * Diverges from PHP `<`: PHP would compare null<'a' as ''<'a' (true), and
 * coerce non-numeric strings to 0 in mixed comparisons; JS produces NaN
 * (false) in those cases.
 */
function backflip_jsLessThan(mixed $a, mixed $b): bool
{
    if (is_string($a) && is_string($b)) {
        return strcmp($a, $b) < 0;
    }
    $na = backflip_jsToNumber($a);
    $nb = backflip_jsToNumber($b);
    if ((is_float($na) && is_nan($na)) || (is_float($nb) && is_nan($nb))) {
        return false;
    }
    return $na < $nb;
}

/**
 * JS-style `<=`. Per spec, `a <= b` is false if either side is NaN, else
 * `!(b < a)`. Written directly (not as `!backflip_jsLessThan($b, $a)`) so the
 * NaN branch returns false instead of true.
 */
function backflip_jsLessOrEq(mixed $a, mixed $b): bool
{
    if (is_string($a) && is_string($b)) {
        return strcmp($a, $b) <= 0;
    }
    $na = backflip_jsToNumber($a);
    $nb = backflip_jsToNumber($b);
    if ((is_float($na) && is_nan($na)) || (is_float($nb) && is_nan($nb))) {
        return false;
    }
    return $na <= $nb;
}

/**
 * Extract vars from ctx (null for missing keys), then call the closure.
 *
 * $fnData = ['fn' => Closure, 'vars' => ['user', 'post']]
 */
function backflip_execFn(array $fnData, array $ctx): mixed
{
    $args = array_map(fn($v) => $ctx[$v] ?? null, $fnData['vars']);
    return ($fnData['fn'])(...$args);
}

/**
 * Evaluate a partial-ref binding to produce the value placed in childCtx.
 *
 * Three shapes are supported:
 *   - literal: value as-is (string|bool, including false)
 *   - data only: evaluate expression in caller ctx
 *   - data + cast: evaluate then coerce to bool or string
 */
function backflip_evalBinding(array $binding, array $ctx): mixed
{
    if (array_key_exists('literal', $binding)) {
        return $binding['literal'];
    }
    $value = backflip_execFn($binding['data'], $ctx);
    $cast = $binding['cast'] ?? null;
    if ($cast === 'bool') {
        return backflip_isTruthy($value);
    }
    if ($cast === 'string') {
        return (string) $value;
    }
    return $value;
}

/**
 * Render all nodes in $node['nodes'], join and return.
 *
 * Collects the script URLs of every reactive custom-element partial actually
 * rendered (deduped, first-encounter order via array keys) and injects matching
 * <script> tags into the output (see backflip_injectScripts).
 */
function backflip_renderRoot(array $node, array $ctx, array $slots = []): string
{
    $scripts = [];
    if (isset($node['scriptUrl'])) {
        $scripts[$node['scriptUrl']] = true;
    }
    $body = implode('', iterator_to_array(backflip_streamRenderRoot($node, $ctx, $slots, $scripts), false));
    return backflip_injectScripts($body, $scripts);
}

/**
 * Build and place the auto-include <script> tags. Inserts immediately before the
 * first closing </body> (case-insensitive) when one exists, otherwise appends to
 * the end. Empty collector → body returned as-is. $scripts is an ordered set
 * (URL => true).
 */
function backflip_injectScripts(string $body, array $scripts): string
{
    if (count($scripts) === 0) {
        return $body;
    }
    $tags = [];
    foreach (array_keys($scripts) as $url) {
        $escaped = htmlspecialchars((string)$url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $tags[] = '<script src="' . $escaped . '" defer></script>';
    }
    $block = implode("\n", $tags);
    if (preg_match('/<\/body>/i', $body, $m, PREG_OFFSET_CAPTURE)) {
        $pos = $m[0][1];
        return substr($body, 0, $pos) . $block . substr($body, $pos);
    }
    return $body . $block;
}

/**
 * Streaming render of a root node. Yields string chunks.
 */
function backflip_streamRenderRoot(array $node, array $ctx, array $slots = [], array &$scripts = []): Generator
{
    foreach ($node['nodes'] as $child) {
        yield from backflip_streamRender($child, $ctx, $slots, $scripts);
    }
}

/**
 * Dispatch on $node['type']. Yields string chunks.
 */
function backflip_streamRender(array $node, array $ctx, array $slots = [], array &$scripts = []): Generator
{
    switch ($node['type']) {
        case 'raw':
            yield $node['raw'];
            break;
        case 'comment':
            yield '<!--' . $node['text'] . '-->';
            break;
        case 'print':
            yield backflip_renderPrint($node, $ctx);
            break;
        case 'for':
            yield from backflip_streamRenderFor($node, $ctx, $slots, $scripts);
            break;
        case 'if':
            yield from backflip_streamRenderIf($node, $ctx, $slots, $scripts);
            break;
        case 'partial-ref':
            yield from backflip_streamRenderPartialRef($node, $ctx, $scripts);
            break;
        case 'slot':
            yield from backflip_streamRenderSlot($node, $slots, $scripts);
            break;
        case 'attr-bind':
            yield backflip_renderAttrBind($node, $ctx);
            break;
        default:
            throw new \RuntimeException(
                "backflip_streamRender: unhandled node type: " . $node['type']
            );
    }
}

/**
 * Streaming render of a for-loop node.
 */
function backflip_streamRenderFor(array $node, array $ctx, array $slots, array &$scripts = []): Generator
{
    $iterable = backflip_execFn($node['iterable'], $ctx);

    if (!is_array($iterable) && !($iterable instanceof \Traversable)) {
        throw new \RuntimeException(
            "backflip_streamRenderFor: iterable is not an array or Traversable"
        );
    }

    foreach ($iterable as $item) {
        $innerCtx = array_merge($ctx, [$node['valName'] => $item]);
        foreach ($node['nodes'] as $child) {
            yield from backflip_streamRender($child, $innerCtx, $slots, $scripts);
        }
    }
}

/**
 * Streaming render of an if/elseif/else node.
 */
function backflip_streamRenderIf(array $node, array $ctx, array $slots, array &$scripts = []): Generator
{
    foreach ($node['branches'] as $branch) {
        $condition = $branch['condition'] ?? null;
        if ($condition === null || backflip_isTruthy(backflip_execFn($condition, $ctx))) {
            foreach ($branch['nodes'] as $child) {
                yield from backflip_streamRender($child, $ctx, $slots, $scripts);
            }
            return;
        }
    }
}

/**
 * Render a print (expression output) node.
 *
 * HTML-escapes the evaluated value to prevent XSS.
 */
function backflip_renderPrint(array $node, array $ctx): string
{
    $value = (string) backflip_execFn($node['data'], $ctx);
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/**
 * Streaming render of a partial-ref node.
 */
function backflip_streamRenderPartialRef(array $node, array $ctx, array &$scripts = []): Generator
{
    if (!empty($node['customElement'])) {
        yield from backflip_streamRenderCustomElementRef($node, $ctx, $scripts);
        return;
    }

    // 1. Build child context: start with caller ctx, overlay bindings evaluated in caller ctx
    $childCtx = $ctx;
    foreach ($node['bindings'] as $binding) {
        $childCtx[$binding['name']] = backflip_evalBinding($binding, $ctx);
    }

    // 2. Build slot map: capture nodes + caller ctx (NOT childCtx)
    $slotMap = [];
    foreach ($node['slots'] as $slotName => $nodes) {
        $slotMap[$slotName] = ['nodes' => $nodes, 'ctx' => $ctx];
    }

    // 3. Render the partial, with wrapper if present
    $wrapper = $node['wrapper'] ?? null;
    if ($wrapper !== null) {
        yield $wrapper['open'];
        yield from backflip_streamRenderRoot($node['partial'], $childCtx, $slotMap, $scripts);
        yield $wrapper['close'];
    } else {
        yield from backflip_streamRenderRoot($node['partial'], $childCtx, $slotMap, $scripts);
    }
}

/**
 * Streaming render of a custom-element partial-ref. Produces a single merged tag
 * with caller-side attrs (caller ctx) and definition-side attrs (childCtx) interleaved.
 */
function backflip_streamRenderCustomElementRef(array $node, array $ctx, array &$scripts = []): Generator
{
    $tagName = $node['callerTagName'];

    if (!empty($node['unresolved'])) {
        // Fallback: render as plain HTML — caller-side attrs only, default slot in caller ctx.
        yield '<' . $tagName;
        foreach (($node['callerOpenTag'] ?? []) as $n) {
            yield from backflip_streamRender($n, $ctx, [], $scripts);
        }
        yield '>';
        $def = $node['slots']['default'] ?? null;
        if ($def !== null) {
            foreach ($def as $n) {
                yield from backflip_streamRender($n, $ctx, [], $scripts);
            }
        }
        yield '</' . $tagName . '>';
        return;
    }

    // This reactive partial actually rendered — record its script for auto-inclusion.
    if (isset($node['partial']['scriptUrl'])) {
        $scripts[$node['partial']['scriptUrl']] = true;
    }

    // Bindings evaluated in caller ctx, applied to childCtx for body and definition attrs.
    $childCtx = $ctx;
    foreach ($node['bindings'] as $binding) {
        $childCtx[$binding['name']] = backflip_evalBinding($binding, $ctx);
    }
    $slotMap = [];
    foreach ($node['slots'] as $slotName => $nodes) {
        $slotMap[$slotName] = ['nodes' => $nodes, 'ctx' => $ctx];
    }

    // Single merged open tag: caller-side attrs in caller ctx, definition-side attrs in childCtx.
    yield '<' . $tagName;
    foreach (($node['callerOpenTag'] ?? []) as $n) {
        yield from backflip_streamRender($n, $ctx, [], $scripts);
    }
    foreach (($node['partial']['definitionAttrNodes'] ?? []) as $n) {
        yield from backflip_streamRender($n, $childCtx, [], $scripts);
    }
    yield '>';
    foreach ($node['partial']['nodes'] as $n) {
        yield from backflip_streamRender($n, $childCtx, $slotMap, $scripts);
    }
    yield '</' . $tagName . '>';
}

/**
 * Render an attr-bind node (returns string, not streaming — produces a single chunk).
 */
function backflip_replaceAssetPaths(string $value, array $assetMap): string
{
    foreach ($assetMap as $name => $prefix) {
        $value = str_replace("@{$name}/", $prefix, $value);
    }
    return $value;
}

function backflip_renderAttrBind(array $node, array $ctx): string
{
    $attrsOnly = !empty($node['attrsOnly']);
    $out = $attrsOnly ? '' : $node['tagOpen'];
    $assetMap = $node['assetMap'] ?? null;
    foreach ($node['parts'] as $p) {
        if ($p['type'] === 'static') {
            $out .= $p['raw'];
        } else {
            $val = backflip_execFn($p['expr'], $ctx);
            if (!empty($p['isAsset']) && $assetMap !== null && $val !== null && $val !== false) {
                $val = backflip_replaceAssetPaths((string)$val, $assetMap);
            }
            if ($p['isBoolean']) {
                if (backflip_isTruthy($val)) {
                    $out .= ' ' . $p['name'];
                }
            } else {
                if ($val !== null && $val !== false) {
                    $out .= ' ' . $p['name'] . '="' . htmlspecialchars((string)$val, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '"';
                }
            }
        }
    }
    if ($attrsOnly) {
        return $out;
    }
    return $out . (($node['selfClosing'] ?? false) ? ' />' : '>');
}

/**
 * Streaming render of a slot node.
 */
function backflip_streamRenderSlot(array $node, array $slots, array &$scripts = []): Generator
{
    $slotName = $node['name'] ?? 'default';

    if (!isset($slots[$slotName])) {
        return;
    }

    $slotEntry = $slots[$slotName];
    foreach ($slotEntry['nodes'] as $child) {
        // Render with the caller's ctx; pass empty slots so they don't leak inward
        yield from backflip_streamRender($child, $slotEntry['ctx'], [], $scripts);
    }
}
