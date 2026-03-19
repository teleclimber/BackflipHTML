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
 * Render all nodes in $node['nodes'], join and return.
 */
function backflip_renderRoot(array $node, array $ctx, array $slots = []): string
{
    return implode('', iterator_to_array(backflip_streamRenderRoot($node, $ctx, $slots), false));
}

/**
 * Streaming render of a root node. Yields string chunks.
 */
function backflip_streamRenderRoot(array $node, array $ctx, array $slots = []): Generator
{
    foreach ($node['nodes'] as $child) {
        yield from backflip_streamRender($child, $ctx, $slots);
    }
}

/**
 * Dispatch on $node['type']. Yields string chunks.
 */
function backflip_streamRender(array $node, array $ctx, array $slots = []): Generator
{
    switch ($node['type']) {
        case 'raw':
            yield $node['raw'];
            break;
        case 'print':
            yield backflip_renderPrint($node, $ctx);
            break;
        case 'for':
            yield from backflip_streamRenderFor($node, $ctx, $slots);
            break;
        case 'if':
            yield from backflip_streamRenderIf($node, $ctx, $slots);
            break;
        case 'partial-ref':
            yield from backflip_streamRenderPartialRef($node, $ctx);
            break;
        case 'slot':
            yield from backflip_streamRenderSlot($node, $slots);
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
function backflip_streamRenderFor(array $node, array $ctx, array $slots): Generator
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
            yield from backflip_streamRender($child, $innerCtx, $slots);
        }
    }
}

/**
 * Streaming render of an if/elseif/else node.
 */
function backflip_streamRenderIf(array $node, array $ctx, array $slots): Generator
{
    foreach ($node['branches'] as $branch) {
        $condition = $branch['condition'] ?? null;
        if ($condition === null || backflip_isTruthy(backflip_execFn($condition, $ctx))) {
            foreach ($branch['nodes'] as $child) {
                yield from backflip_streamRender($child, $ctx, $slots);
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
function backflip_streamRenderPartialRef(array $node, array $ctx): Generator
{
    // 1. Build child context: start with caller ctx, overlay bindings evaluated in caller ctx
    $childCtx = $ctx;
    foreach ($node['bindings'] as $binding) {
        $childCtx[$binding['name']] = backflip_execFn($binding['data'], $ctx);
    }

    // 2. Build slot map: capture nodes + caller ctx (NOT childCtx)
    $slotMap = [];
    foreach ($node['slots'] as $slotName => $nodes) {
        $slotMap[$slotName] = ['nodes' => $nodes, 'ctx' => $ctx];
    }

    // 3. Render the partial, with wrapper if present
    if ($node['wrapper'] !== null) {
        yield $node['wrapper']['open'];
        yield from backflip_streamRenderRoot($node['partial'], $childCtx, $slotMap);
        yield $node['wrapper']['close'];
    } else {
        yield from backflip_streamRenderRoot($node['partial'], $childCtx, $slotMap);
    }
}

/**
 * Render an attr-bind node (returns string, not streaming — produces a single chunk).
 */
function backflip_renderAttrBind(array $node, array $ctx): string
{
    $out = $node['tagOpen'];
    foreach ($node['parts'] as $p) {
        if ($p['type'] === 'static') {
            $out .= $p['raw'];
        } else {
            $val = backflip_execFn($p['expr'], $ctx);
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
    return $out . '>';
}

/**
 * Streaming render of a slot node.
 */
function backflip_streamRenderSlot(array $node, array $slots): Generator
{
    $slotName = $node['name'] ?? 'default';

    if (!isset($slots[$slotName])) {
        return;
    }

    $slotEntry = $slots[$slotName];
    foreach ($slotEntry['nodes'] as $child) {
        // Render with the caller's ctx; pass empty slots so they don't leak inward
        yield from backflip_streamRender($child, $slotEntry['ctx'], []);
    }
}
