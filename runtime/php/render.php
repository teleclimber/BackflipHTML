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
    $parts = array_map(
        fn($child) => backflip_render($child, $ctx, $slots),
        $node['nodes']
    );
    return implode('', $parts);
}

/**
 * Dispatch on $node['type']. Throws RuntimeException for unknown types.
 */
function backflip_render(array $node, array $ctx, array $slots = []): string
{
    return match ($node['type']) {
        'raw'         => $node['raw'],
        'print'       => backflip_renderPrint($node, $ctx),
        'for'         => backflip_renderFor($node, $ctx, $slots),
        'if'          => backflip_renderIf($node, $ctx, $slots),
        'partial-ref' => backflip_renderPartialRef($node, $ctx),
        'slot'        => backflip_renderSlot($node, $slots),
        default       => throw new \RuntimeException(
            "backflip_render: unhandled node type: " . $node['type']
        ),
    };
}

/**
 * Render a for-loop node.
 *
 * Evaluates the iterable expression, then renders child nodes once per item
 * with an inner context that adds the loop variable.
 */
function backflip_renderFor(array $node, array $ctx, array $slots): string
{
    $iterable = backflip_execFn($node['iterable'], $ctx);

    if (!is_array($iterable) && !($iterable instanceof \Traversable)) {
        throw new \RuntimeException(
            "backflip_renderFor: iterable is not an array or Traversable"
        );
    }

    $out = '';
    foreach ($iterable as $item) {
        $innerCtx = array_merge($ctx, [$node['valName'] => $item]);
        foreach ($node['nodes'] as $child) {
            $out .= backflip_render($child, $innerCtx, $slots);
        }
    }

    return $out;
}

/**
 * Render an if/elseif/else node.
 *
 * Iterates branches; the first branch whose condition is null (else) or
 * evaluates as JS-truthy is rendered and returned immediately.
 */
function backflip_renderIf(array $node, array $ctx, array $slots): string
{
    foreach ($node['branches'] as $branch) {
        $condition = $branch['condition'] ?? null;
        if ($condition === null || backflip_isTruthy(backflip_execFn($condition, $ctx))) {
            $parts = array_map(
                fn($child) => backflip_render($child, $ctx, $slots),
                $branch['nodes']
            );
            return implode('', $parts);
        }
    }
    return '';
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
 * Render a partial-ref node.
 *
 * 1. Build childCtx from caller ctx plus evaluated bindings.
 * 2. Build slotMap capturing nodes together with the CALLER's ctx (not childCtx).
 * 3. Render the partial root with childCtx and slotMap.
 * 4. Wrap with open/close tags if a wrapper is present.
 */
function backflip_renderPartialRef(array $node, array $ctx): string
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

    // 3. Render the partial
    $rendered = backflip_renderRoot($node['partial'], $childCtx, $slotMap);

    // 4. Apply wrapper if present
    if ($node['wrapper'] !== null) {
        $rendered = $node['wrapper']['open'] . $rendered . $node['wrapper']['close'];
    }

    return $rendered;
}

/**
 * Render a slot node.
 *
 * Uses the slot's captured ctx (the caller's ctx at the time the partial-ref
 * was invoked), not the current partial's ctx. Slots do not inherit inward.
 */
function backflip_renderSlot(array $node, array $slots): string
{
    $slotName = $node['name'] ?? 'default';

    if (!isset($slots[$slotName])) {
        return '';
    }

    $slotEntry = $slots[$slotName];
    $out = '';
    foreach ($slotEntry['nodes'] as $child) {
        // Render with the caller's ctx; pass empty slots so they don't leak inward
        $out .= backflip_render($child, $slotEntry['ctx'], []);
    }
    return $out;
}
