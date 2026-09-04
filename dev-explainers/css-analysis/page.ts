import type { ExplainPayload } from './collect.js';

/**
 * Render an `ExplainPayload` as a self-contained HTML page.
 *
 * `renderBody` emits title + style + markup + script with no document wrapper,
 * which is what an Artifact publish wants; `renderDocument` wraps that in a full
 * document for writing to a file.
 */

const STYLE = String.raw`
/* System faces only — no web font, so the page has no network dependency and
   renders identically offline. Sizes run a touch large because a system mono
   at 13px reads smaller than a designed one. */
:root {
  --ground: #f4f6f8;
  --surface: #ffffff;
  --sunken: #eaeef2;
  --ink: #10141b;
  --muted: #4b5462;
  --faint: #5e6673;
  --line: #d8dde4;
  --hair: #e8ecf0;
  --accent: #0a5f69;
  --accent-soft: #d6ebec;
  --definite: #1d6b3e;
  --conditional: #8a5406;
  --dynamic: #5a45b0;
  --shadow: 0 1px 2px rgba(16, 20, 27, .07), 0 8px 24px -16px rgba(16, 20, 27, .32);
  --sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0d1014;
    --surface: #161a20;
    --sunken: #1d232b;
    --ink: #e9edf3;
    --muted: #a3adbc;
    --faint: #8d97a8;
    --line: #2b323d;
    --hair: #232932;
    --accent: #4fd0d8;
    --accent-soft: #10353b;
    --definite: #62c98a;
    --conditional: #e0aa46;
    --dynamic: #b09ff0;
    --shadow: 0 1px 2px rgba(0, 0, 0, .5), 0 8px 24px -16px rgba(0, 0, 0, .8);
  }
}

:root[data-theme="dark"] {
  --ground: #0d1014;
  --surface: #161a20;
  --sunken: #1d232b;
  --ink: #e9edf3;
  --muted: #a3adbc;
  --faint: #8d97a8;
  --line: #2b323d;
  --hair: #232932;
  --accent: #4fd0d8;
  --accent-soft: #10353b;
  --definite: #62c98a;
  --conditional: #e0aa46;
  --dynamic: #b09ff0;
  --shadow: 0 1px 2px rgba(0, 0, 0, .5), 0 8px 24px -16px rgba(0, 0, 0, .8);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3 { text-wrap: balance; margin: 0; font-weight: 600; }
code, .mono { font-family: var(--mono); font-variant-ligatures: none; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}

/* --- header --- */

.chrome {
  position: sticky; top: 0; z-index: 20;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

.ident {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px;
  padding: 14px 20px 10px;
}
.ident h1 { font-size: 16px; letter-spacing: -.01em; }
.ident .path { font-family: var(--mono); font-size: 13.5px; color: var(--muted); }
.ident .stamp { margin-left: auto; font-size: 12.5px; color: var(--faint); }

.pipeline {
  display: flex; flex-wrap: wrap; gap: 0;
  padding: 0 20px 12px;
}
.stage {
  display: flex; align-items: baseline; gap: 8px;
  padding: 6px 18px 6px 0; margin-right: 18px;
  border-right: 1px solid var(--hair);
}
.stage:last-child { border-right: 0; }
.stage .n {
  font-family: var(--mono); font-size: 11.5px; font-weight: 700;
  color: var(--accent); letter-spacing: .06em;
}
.stage .lab {
  font-size: 11.5px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted);
}
.stage .val { font-family: var(--mono); font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stage .sub { font-family: var(--mono); font-size: 12px; color: var(--faint); }

.budgets { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 20px 12px; }
.chip {
  font-family: var(--mono); font-size: 12px; color: var(--muted);
  background: var(--sunken); border-radius: 3px; padding: 2px 7px;
}
.chip.warn { color: var(--conditional); background: transparent; border: 1px solid currentColor; }

/* Closed by default: on a large project the list is longer than the viewport,
   and the count in the summary is the part worth seeing every time. Open, it is
   capped and scrolls, so it never takes the page over again. */
.diags {
  margin: 0 20px 12px;
  border-left: 3px solid var(--conditional); background: var(--sunken); border-radius: 0 4px 4px 0;
}
.diags > summary {
  padding: 8px 12px; cursor: pointer; list-style: none;
  font-size: 11.5px; text-transform: uppercase; letter-spacing: .09em;
  color: var(--conditional);
}
.diags > summary::-webkit-details-marker { display: none; }
.diags > summary::before { content: '\25B8'; margin-right: 6px; font-size: 9px; vertical-align: 1px; }
.diags[open] > summary::before { content: '\25BE'; }
.diags > summary:hover { color: var(--ink); }
.diags > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.diags li { font-family: var(--mono); font-size: 12.5px; color: var(--muted); list-style: none; }
.diags ul { margin: 0; padding: 0 12px 10px; max-height: 32vh; overflow-y: auto; }

.tabs { display: flex; gap: 2px; padding: 0 20px; overflow-x: auto; }
.tab {
  appearance: none; border: 0; background: none; cursor: pointer;
  font-family: var(--sans); font-size: 13.5px; color: var(--muted);
  padding: 9px 12px; border-bottom: 2px solid transparent; white-space: nowrap;
}
.tab .idx { font-family: var(--mono); font-size: 11.5px; color: var(--faint); margin-right: 6px; }
.tab:hover { color: var(--ink); }
.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.tab[aria-selected="true"] .idx { color: var(--accent); }

/* --- working area --- */

.work {
  display: grid; grid-template-columns: minmax(0, 1fr) 370px;
  gap: 16px; padding: 16px 20px 40px; align-items: start;
}
@media (max-width: 1120px) { .work { grid-template-columns: minmax(0, 1fr); } }

.panel {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 6px; box-shadow: var(--shadow); overflow: hidden;
}
.panel + .panel { margin-top: 16px; }
.panel > header {
  display: flex; align-items: baseline; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--hair);
}
.panel > header h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); }
.panel > header .count { font-family: var(--mono); font-size: 12.5px; color: var(--faint); margin-left: auto; }
.panel .body { padding: 10px 14px 14px; }
.panel .scroll { max-height: 62vh; overflow: auto; }

.note { color: var(--muted); font-size: 13.5px; margin: 0 0 10px; max-width: 64ch; }

/* --- tables --- */

table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th {
  text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--faint); font-weight: 600; padding: 5px 8px; border-bottom: 1px solid var(--hair);
  position: sticky; top: 0; background: var(--surface);
}
td { padding: 5px 8px; border-bottom: 1px solid var(--hair); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; color: var(--muted); }
td.mono { font-family: var(--mono); }
tr.pick { cursor: pointer; }
tr.pick:hover td { background: var(--sunken); }
tr.on td { background: var(--accent-soft); }

.sel {
  font-family: var(--mono); font-size: 13.5px; cursor: pointer;
  background: none; border: 0; padding: 0; color: var(--ink); text-align: left;
}
.sel:hover { color: var(--accent); text-decoration: underline; }
.sel.dead { color: var(--faint); text-decoration: line-through; }

/* --- trees --- */

.tree { font-family: var(--mono); font-size: 13.5px; line-height: 1.75; }
.row {
  display: flex; align-items: baseline; gap: 8px;
  padding: 1px 8px 1px 0; border-radius: 3px; cursor: pointer;
  border-left: 2px solid transparent;
}
.row:hover { background: var(--sunken); }
.row.on { background: var(--accent-soft); border-left-color: var(--accent); }
.row.lit { box-shadow: inset 0 0 0 1px var(--accent); }
.gutter {
  flex: 0 0 84px; text-align: right; font-size: 11px; letter-spacing: .04em;
  color: var(--faint); text-transform: uppercase; user-select: none; white-space: nowrap;
}
.gutter.partial, .gutter.slot { color: var(--accent); }
.gutter.for, .gutter.if { color: var(--conditional); }
/* A partial definition is a boundary, not one of the rules that splices within
   one, so it reads as a heading rather than joining the accent/conditional
   vocabulary the splice gutters share. */
.gutter.b-name, .gutter.ce-partial { color: var(--ink); font-weight: 700; }
.row.def { margin-top: 10px; }
.row.def:first-child { margin-top: 0; }
.name { white-space: nowrap; }
.name .tag { color: var(--ink); }
.name .cls { color: var(--accent); }
.name .hash { color: var(--dynamic); }
.name .dir { color: var(--conditional); }
.name .pdef { color: var(--ink); font-weight: 600; }

/* A tree boundary. The forest is N isolated trees — no combinator crosses one —
   so running them together made two tops read as siblings when they are not. */
.treehead {
  display: flex; align-items: baseline; gap: 8px;
  margin: 14px 0 3px; padding-bottom: 3px; border-bottom: 1px solid var(--hair);
}
.treehead:first-child { margin-top: 0; }
.treehead .ord {
  flex: 0 0 84px; text-align: right; font-size: 11px; letter-spacing: .04em;
  color: var(--faint); text-transform: uppercase; white-space: nowrap;
}
.treehead .root { color: var(--ink); font-weight: 600; }
.treehead .rfile { color: var(--muted); font-weight: 400; font-family: var(--mono); font-size: 12.5px; }
.treehead .rsep { color: var(--faint); font-weight: 400; }
.treehead .why { color: var(--faint); font-size: 12px; }
.treehead .size { margin-left: auto; color: var(--faint); font-size: 12px; white-space: nowrap; }
.name .txt { color: var(--faint); font-style: italic; }
.trail { color: var(--faint); font-size: 12px; margin-left: auto; white-space: nowrap; padding-left: 12px; }

.badge {
  font-family: var(--mono); font-size: 11px; letter-spacing: .04em;
  padding: 0 5px; border-radius: 3px; border: 1px solid currentColor; white-space: nowrap;
}
.badge.definite { color: var(--definite); }
.badge.conditional { color: var(--conditional); }
.badge.dynamic { color: var(--dynamic); }
.badge.solid { color: var(--surface); background: var(--definite); border-color: var(--definite); }
.badge.cond { color: var(--surface); background: var(--conditional); border-color: var(--conditional); }
.badge.dyn { color: var(--surface); background: var(--dynamic); border-color: var(--dynamic); }

/* --- rail --- */

.rail { position: sticky; top: 140px; }
@media (max-width: 1120px) { .rail { position: static; } }
.rail dl { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; font-size: 13.5px; }
.rail dt { color: var(--faint); font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; padding-top: 3px; }
.rail dd { margin: 0; font-family: var(--mono); font-size: 13px; word-break: break-word; }
.rail h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); margin: 16px 0 6px; }
.rail .empty { color: var(--faint); font-size: 13.5px; }

.chain { font-family: var(--mono); font-size: 13px; line-height: 1.7; }
.chain li { list-style: none; }
.chain ol, .chain ul { margin: 0; padding: 0; }
.chain .step { color: var(--muted); }
.chain .step.self { color: var(--ink); font-weight: 600; }
.chain .step::before { content: '\2514 '; color: var(--faint); }
.chain > li:first-child .step::before { content: ''; }

.src {
  font-family: var(--mono); font-size: 12.5px; color: var(--muted);
  background: var(--sunken); border-radius: 3px; padding: 6px 8px;
  overflow-x: auto; white-space: pre; margin: 4px 0 0;
}

.act {
  appearance: none; cursor: pointer; font-family: var(--sans); font-size: 13px;
  background: var(--surface); color: var(--accent);
  border: 1px solid var(--line); border-radius: 4px; padding: 4px 9px; margin: 10px 6px 0 0;
}
.act:hover { border-color: var(--accent); }

/* --- trace --- */

.picker { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
input[type="search"], select {
  font-family: var(--mono); font-size: 13.5px; color: var(--ink);
  background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 5px 8px;
}
input[type="search"] { min-width: 220px; }
select { max-width: 100%; }

.steps { display: flex; flex-direction: column; gap: 0; margin: 0 0 18px; }
.step-row {
  display: grid; grid-template-columns: 24px minmax(0, 1fr) auto;
  gap: 12px; align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--hair);
}
.step-row:last-child { border-bottom: 0; }
.step-row .k { font-family: var(--mono); font-size: 11.5px; color: var(--faint); }
.step-row .s { font-family: var(--mono); font-size: 14px; }
.step-row .h { font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--muted); }
.step-row.drop .h { color: var(--conditional); }
.step-row.zero .s { color: var(--faint); }

.verdict { display: flex; align-items: baseline; gap: 8px; font-family: var(--mono); font-size: 13px; padding: 3px 0; }
.verdict .mark { flex: 0 0 14px; }
.verdict.yes .mark { color: var(--definite); }
.verdict.no .mark { color: var(--faint); }
.verdict.no { color: var(--faint); }
.ratio { font-family: var(--mono); font-variant-numeric: tabular-nums; }
`;

const SCRIPT = String.raw`
(function () {
  var P = JSON.parse(document.getElementById('explain-data').textContent);
  var state = { tab: 0, instance: null, authoring: null, partial: null, selector: null, filter: '' };

  /* Served pages are re-generated on every reload, so keep the reader roughly
     where they were. Instance ids move when a template changes; a selector's
     text does not, so that is what gets stored. Storage can be unavailable
     (private windows, blocked site data), which is not worth failing over. */
  var STORE = 'backflip-css-trace';
  var diagsEl = document.getElementById('diags');
  try {
    var saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (saved) {
      state.tab = Math.min(Math.max(saved.tab | 0, 0), 3);
      state.filter = typeof saved.filter === 'string' ? saved.filter : '';
      if (saved.selector) {
        for (var si = 0; si < P.selectors.length; si++) {
          if (P.selectors[si].text === saved.selector) { state.selector = si; break; }
        }
      }
      /* Having opened the diagnostics, you are working through them; a reload
         mid-fix should not close them again. */
      if (diagsEl && saved.diagsOpen) diagsEl.open = true;
    }
  } catch (e) { /* no stored state; start fresh */ }

  function remember() {
    try {
      sessionStorage.setItem(STORE, JSON.stringify({
        tab: state.tab,
        filter: state.filter,
        selector: state.selector == null ? null : P.selectors[state.selector].text,
        diagsOpen: !!(diagsEl && diagsEl.open)
      }));
    } catch (e) { /* storage unavailable; the page works without it */ }
  }
  if (diagsEl) diagsEl.addEventListener('toggle', remember);

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function frag() { return document.createDocumentFragment(); }
  function num(n) { return n.toLocaleString('en-US'); }

  /* A tag name with its id and classes, coloured like a selector. */
  function nameOf(tag, id, classes) {
    var n = h('span', 'name');
    n.appendChild(h('span', 'tag', tag));
    if (id) n.appendChild(h('span', 'hash', '#' + id));
    (classes || []).forEach(function (c) { n.appendChild(h('span', 'cls', '.' + c)); });
    return n;
  }

  function pick(kind, id) {
    state[kind] = id;
    if (kind === 'authoring' || kind === 'instance') state.partial = null;
    render();
  }

  /* --- rail ------------------------------------------------------------ */

  function defList(pairs) {
    var dl = h('dl');
    pairs.forEach(function (p) {
      if (p[1] == null || p[1] === '') return;
      dl.appendChild(h('dt', null, p[0]));
      var dd = h('dd');
      if (typeof p[1] === 'string' || typeof p[1] === 'number') dd.textContent = String(p[1]);
      else dd.appendChild(p[1]);
      dl.appendChild(dd);
    });
    return dl;
  }

  function ancestryOf(instance) {
    var chain = [], cur = instance;
    while (cur) { chain.unshift(cur); cur = cur.parent == null ? null : P.instances[cur.parent]; }
    var ol = h('ol', 'chain');
    chain.forEach(function (node, i) {
      var li = h('li');
      var step = h('span', 'step' + (i === chain.length - 1 ? ' self' : ''));
      step.appendChild(nameOf(node.tag, node.elementId, node.classes));
      li.appendChild(step);
      ol.appendChild(li);
    });
    return ol;
  }

  function railForInstance(id) {
    var inst = P.instances[id];
    var src = P.authoring[inst.authoringId];
    var box = frag();
    box.appendChild(defList([
      ['node', nameOf(inst.tag, inst.elementId, inst.classes)],
      ['source', inst.file + ' · ' + inst.partial + (src && src.line ? ':' + src.line : '')],
      ['depth', String(inst.depth)],
      ['origin', inst.via],
      ['renders', inst.conditional ? 'only in a b-if branch' : 'always'],
    ]));

    box.appendChild(h('h3', null, 'Ancestry'));
    box.appendChild(ancestryOf(inst));

    if (inst.slots.length) {
      box.appendChild(h('h3', null, 'Slots in scope'));
      var ul = h('ul', 'chain');
      inst.slots.forEach(function (s) {
        var li = h('li');
        li.appendChild(h('span', 'step', s.name + ' · ' + s.fills + ' node' + (s.fills === 1 ? '' : 's') + ' from ' + s.from));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }

    var known = inst.attrs.filter(function (a) { return a.value !== null; });
    var bound = inst.attrs.filter(function (a) { return a.value === null; });
    if (known.length || bound.length) {
      box.appendChild(h('h3', null, 'Attributes'));
      box.appendChild(defList(
        known.map(function (a) { return [a.name, a.value === '' ? '(bare)' : a.value]; })
          .concat(bound.map(function (a) { return [a.name, 'bound at runtime']; }))
      ));
    }

    box.appendChild(h('h3', null, 'Selectors matching this instance'));
    if (!inst.matched.length) box.appendChild(h('p', 'empty', 'None.'));
    else inst.matched.forEach(function (sid) {
      var b = h('button', 'sel');
      b.textContent = P.selectors[sid].text;
      b.onclick = function () { pick('selector', sid); };
      box.appendChild(b);
      box.appendChild(h('br'));
    });
    return box;
  }

  function railForAuthoring(id) {
    var node = P.authoring[id];
    var partial = P.partials[node.partialId];
    var box = frag();
    box.appendChild(defList([
      ['node', node.label],
      ['kind', node.kind],
      ['written in', partial.file + ' · ' + partial.name + (node.line ? ':' + node.line : '')],
      ['expansion', node.rule],
      ['target', node.targetPartialId == null ? null :
        P.partials[node.targetPartialId].name + ' · ' + P.partials[node.targetPartialId].file],
      ['fills', node.fills.length ? node.fills.join(', ') : null],
    ]));
    if (node.source) box.appendChild(h('pre', 'src', node.source));

    box.appendChild(h('h3', null, 'Instances produced (' + node.instances.length + ')'));
    if (!node.instances.length) {
      box.appendChild(h('p', 'empty',
        node.kind === 'b-name'
          ? 'None. A definition is a heading; its own b-name tag is the element below, and the instances are counted there.'
        : node.kind === 'ce-partial'
          ? 'None. This partial’s tag is rendered by the call site, so its instances are counted on the call.'
        : node.kind === 'element' || node.kind === 'custom-element'
          ? 'None — nothing reached this node.'
          : 'None. This node renders no element of its own; it places what it contains.'));
    } else {
      node.instances.slice(0, 40).forEach(function (iid) {
        var inst = P.instances[iid];
        var b = h('button', 'sel');
        b.textContent = '#' + iid + '  depth ' + inst.depth + '  via ' + inst.via;
        b.onclick = function () { state.tab = 2; pick('instance', iid); };
        box.appendChild(b);
        box.appendChild(h('br'));
      });
      if (node.instances.length > 40) box.appendChild(h('p', 'empty', '… and ' + (node.instances.length - 40) + ' more'));
    }
    return box;
  }

  function railForPartial(id) {
    var p = P.partials[id];
    var box = frag();
    box.appendChild(defList([
      ['partial', p.name],
      ['file', p.file],
      ['kind', p.kind],
      ['instances', num(p.instanceCount)],
      ['expansion', p.rootReason === 'entry' ? 'entry point — nothing calls it'
        : p.rootReason === 'unreached' ? 'grown standalone — only reachable through a cycle'
        : 'reached from ' + p.calledFrom.length + ' call site' + (p.calledFrom.length === 1 ? '' : 's')],
    ]));
    box.appendChild(h('h3', null, 'Called from'));
    if (!p.calledFrom.length) box.appendChild(h('p', 'empty', 'Nothing calls this partial.'));
    else {
      var ul = h('ul', 'chain');
      p.calledFrom.forEach(function (c) {
        var li = h('li');
        li.appendChild(h('span', 'step', c.label + '  ' + c.file + ' · ' + c.partial + (c.line ? ':' + c.line : '')));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    return box;
  }

  function railForSelector(id) {
    var s = P.selectors[id];
    var rule = P.rules[s.ruleId];
    var box = frag();
    box.appendChild(defList([
      ['selector', s.text],
      ['rule', 'line ' + rule.line],
      ['specificity', s.specificity.join(', ')],
      ['media', rule.media.length ? rule.media.join(' and ') : null],
      ['instances hit', num(s.hits.length) + ' of ' + num(P.meta.counts.instances)],
    ]));
    if (rule.properties.length) {
      box.appendChild(h('h3', null, 'Declarations'));
      box.appendChild(defList(rule.properties.map(function (d) { return [d.name, d.value]; })));
    }
    var go = h('button', 'act', 'Trace this selector');
    go.onclick = function () { state.tab = 3; render(); };
    box.appendChild(go);
    var lite = h('button', 'act', 'Highlight in forest');
    lite.onclick = function () { state.tab = 2; render(); };
    box.appendChild(lite);
    return box;
  }

  function renderRail() {
    var panel = h('div', 'panel');
    var head = h('header');
    var title = 'Nothing selected';
    var body = h('div', 'body');
    if (state.instance != null) { title = 'Instance #' + state.instance; body.appendChild(railForInstance(state.instance)); }
    else if (state.authoring != null) { title = 'Authoring node'; body.appendChild(railForAuthoring(state.authoring)); }
    else if (state.partial != null) { title = 'Partial'; body.appendChild(railForPartial(state.partial)); }
    else if (state.selector != null) { title = 'Selector'; body.appendChild(railForSelector(state.selector)); }
    else body.appendChild(h('p', 'empty', 'Click a rule, a partial, an authoring node or an instance. What you pick opens here.'));
    head.appendChild(h('h2', null, title));
    panel.appendChild(head);
    panel.appendChild(body);
    return panel;
  }

  /* --- tab 1: parse & roots -------------------------------------------- */

  function viewParse() {
    var out = frag();

    var rules = h('div', 'panel');
    var rh = h('header');
    rh.appendChild(h('h2', null, 'Step 1 · Parsed rules'));
    rh.appendChild(h('span', 'count', num(P.rules.length) + ' rules · ' + num(P.selectors.length) + ' selectors'));
    rules.appendChild(rh);
    var rb = h('div', 'body scroll');
    rb.appendChild(h('p', 'note', 'css-tree normalises what it parses, so a selector reads back as ' +
      '.a>.b rather than the .a > .b you wrote. Click one to inspect or trace it.'));
    var t = h('table');
    var thead = h('thead');
    var hr = h('tr');
    ['Line', 'Selector', 'Declarations', 'Media', 'Hits'].forEach(function (c, i) {
      var th = h('th', i === 4 ? 'num' : null, c); hr.appendChild(th);
    });
    thead.appendChild(hr); t.appendChild(thead);
    var tb = h('tbody');
    P.selectors.forEach(function (s) {
      var rule = P.rules[s.ruleId];
      var tr = h('tr', 'pick' + (state.selector === s.id ? ' on' : ''));
      tr.onclick = function () { pick('selector', s.id); };
      tr.appendChild(h('td', 'num', String(rule.line)));
      var td = h('td');
      var b = h('button', 'sel' + (s.valid ? '' : ' dead'), s.text);
      b.onclick = function (e) { e.stopPropagation(); pick('selector', s.id); };
      td.appendChild(b);
      tr.appendChild(td);
      tr.appendChild(h('td', null, rule.properties.map(function (d) { return d.name; }).join(', ')));
      tr.appendChild(h('td', null, rule.media.join(' and ')));
      tr.appendChild(h('td', 'num', num(s.hits.length)));
      tb.appendChild(tr);
    });
    t.appendChild(tb); rb.appendChild(t); rules.appendChild(rb);
    out.appendChild(rules);

    var roots = h('div', 'panel');
    var ph = h('header');
    ph.appendChild(h('h2', null, 'Step 2 · Roots'));
    var entries = P.partials.filter(function (p) { return p.rootReason; }).length;
    ph.appendChild(h('span', 'count', entries + ' of ' + P.partials.length + ' partials started an expansion'));
    roots.appendChild(ph);
    var pb = h('div', 'body scroll');
    pb.appendChild(h('p', 'note', 'Expansion starts from the partials nothing calls; every other partial is ' +
      'reached through one of them. A partial left with no instances is grown standalone afterwards, which ' +
      'catches the ones only reachable through a reference cycle.'));
    var pt = h('table');
    var pthead = h('thead'); var phr = h('tr');
    ['Partial', 'File', 'Kind', 'Role', 'Call sites', 'Instances'].forEach(function (c, i) {
      phr.appendChild(h('th', i >= 4 ? 'num' : null, c));
    });
    pthead.appendChild(phr); pt.appendChild(pthead);
    var ptb = h('tbody');
    P.partials.forEach(function (p) {
      var tr = h('tr', 'pick' + (state.partial === p.id ? ' on' : ''));
      tr.onclick = function () { state.instance = null; state.authoring = null; pick('partial', p.id); };
      tr.appendChild(h('td', 'mono', p.name));
      tr.appendChild(h('td', 'mono', p.file));
      tr.appendChild(h('td', null, p.kind));
      var role = h('td');
      if (p.rootReason === 'entry') role.appendChild(h('span', 'badge definite', 'entry root'));
      else if (p.rootReason === 'unreached') role.appendChild(h('span', 'badge conditional', 'cycle · standalone'));
      else role.appendChild(h('span', 'badge', 'reached'));
      tr.appendChild(role);
      tr.appendChild(h('td', 'num', String(p.calledFrom.length)));
      tr.appendChild(h('td', 'num', num(p.instanceCount)));
      ptb.appendChild(tr);
    });
    pt.appendChild(ptb); pb.appendChild(pt); roots.appendChild(pb);
    out.appendChild(roots);
    return out;
  }

  /* --- tab 2: expansion ------------------------------------------------ */

  /* The gutter names the authoring construct, so it reads as the thing you
     wrote: b-part for a call, b-name for the definition it resolves to. */
  var KIND_GUTTER = {
    'b-name': 'b-name', 'ce-partial': 'ce-partial',
    'b-part': 'part', 'custom-element': 'call', 'slot': 'slot',
    'for': 'for', 'if': 'if', 'branch': 'branch', 'print': 'text', 'text': 'text', 'element': ''
  };
  function isDefinition(kind) { return kind === 'b-name' || kind === 'ce-partial'; }

  function authoringRow(id, depth) {
    var node = P.authoring[id];
    var row = h('div', 'row' + (state.authoring === id ? ' on' : '') +
      (isDefinition(node.kind) ? ' def' : ''));
    row.tabIndex = 0;
    row.onclick = function () { pick('authoring', id); };
    row.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick('authoring', id); } };
    row.appendChild(h('span', 'gutter ' + node.kind, KIND_GUTTER[node.kind] || ''));
    var name = h('span', 'name');
    name.style.paddingLeft = (depth * 14) + 'px';
    if (isDefinition(node.kind)) {
      name.appendChild(h('span', 'pdef', node.label));
    } else if (node.kind === 'element' || node.kind === 'custom-element') {
      var parts = node.label.split(/(?=[.#])/);
      name.appendChild(h('span', 'tag', parts[0]));
      parts.slice(1).forEach(function (p) {
        name.appendChild(h('span', p[0] === '#' ? 'hash' : 'cls', p));
      });
    } else if (node.kind === 'text' || node.kind === 'print') {
      name.appendChild(h('span', 'txt', node.label));
    } else {
      name.appendChild(h('span', 'dir', node.label));
    }
    row.appendChild(name);
    var trail = h('span', 'trail');
    if (node.instances.length) trail.textContent = node.instances.length + '×';
    else if (node.targetPartialId != null) trail.textContent = '→ ' + P.partials[node.targetPartialId].name;
    row.appendChild(trail);
    return row;
  }

  function viewExpansion() {
    var out = frag();
    var panel = h('div', 'panel');
    var head = h('header');
    head.appendChild(h('h2', null, 'Step 3 · Authoring tree → instances'));
    head.appendChild(h('span', 'count', num(P.authoring.length) + ' authoring nodes'));
    panel.appendChild(head);
    var body = h('div', 'body scroll');
    body.appendChild(h('p', 'note', 'The compiler’s tree, every node kind included — one tree per partial, ' +
      'each headed by its definition (b-name, or ce-partial where the call site renders the tag). The trailing ' +
      'number is how many instances that node produced; a container shows the partial it splices instead, ' +
      'because it renders no element of its own. Click any node for the rule that applies to it.'));
    var tree = h('div', 'tree');
    P.partials.forEach(function (p) {
      if (p.authoringId == null) return;
      var walk = function (id, depth) {
        tree.appendChild(authoringRow(id, depth));
        P.authoring[id].children.forEach(function (c) { walk(c, depth + 1); });
      };
      walk(p.authoringId, 0);
    });
    body.appendChild(tree);
    panel.appendChild(body);
    out.appendChild(panel);
    return out;
  }

  /* --- tab 3: forest --------------------------------------------------- */

  var ELEMENT_BY_NODE = {};
  P.elements.forEach(function (e) { ELEMENT_BY_NODE[e.authoringId] = e; });

  function bestMatch(instanceId) {
    var inst = P.instances[instanceId];
    if (!inst.matched.length) return null;
    var el = ELEMENT_BY_NODE[inst.authoringId];
    if (!el) return null;
    var order = { definite: 0, conditional: 1, dynamic: 2 };
    var best = null;
    el.matches.forEach(function (m) {
      if (inst.matched.indexOf(m.selectorId) === -1) return;
      if (!best || order[m.matchType] < order[best.matchType]) best = m;
    });
    return best;
  }

  function viewForest() {
    var out = frag();
    var panel = h('div', 'panel');
    var head = h('header');
    head.appendChild(h('h2', null, 'Step 4 · Render forest'));
    head.appendChild(h('span', 'count', num(P.instances.length) + ' instances'));
    panel.appendChild(head);
    var body = h('div', 'body');

    var picker = h('div', 'picker');
    var search = h('input');
    search.type = 'search';
    search.placeholder = 'filter by tag or class';
    search.value = state.filter;
    search.oninput = function () { state.filter = search.value.toLowerCase(); render(); requestAnimationFrame(function () {
      var again = document.querySelector('.view input[type="search"]');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }); };
    picker.appendChild(search);
    if (state.selector != null) {
      var lit = h('span', 'chip');
      lit.textContent = 'highlighting ' + P.selectors[state.selector].text +
        ' · ' + P.selectors[state.selector].hits.length + ' instances';
      picker.appendChild(lit);
      var clear = h('button', 'act', 'clear');
      clear.onclick = function () { state.selector = null; render(); };
      picker.appendChild(clear);
    }
    body.appendChild(picker);

    body.appendChild(h('p', 'note', 'The trees a browser would match against — one per expansion root, and they ' +
      'are sealed off from each other: a combinator never crosses a boundary, so the last element of one tree is ' +
      'not a sibling of the first element of the next. The gutter says how each instance got where it is: an ' +
      'element written in place, a partial spliced in, a slot fill, a loop repetition, a branch.'));

    var hits = state.selector == null ? null : new Set(P.selectors[state.selector].hits);
    var scroll = h('div', 'scroll');
    var tree = h('div', 'tree');
    var shown = 0, LIMIT = 4000;
    var bucket = null;   /* rows of the tree being walked, held until it is known to be non-empty */
    var inTree = 0;

    function treeHead(t) {
      var head = h('div', 'treehead');
      head.appendChild(h('span', 'ord', 'tree ' + (t.id + 1) + ' of ' + P.trees.length));
      var name = h('span', 'root');
      if (t.rootPartialId == null) {
        name.textContent = 'root not attributable';
      } else {
        /* The partial name alone does not locate it — a project can hold several
           partials of one name across files. */
        var root = P.partials[t.rootPartialId];
        name.appendChild(h('span', 'rfile', root.file));
        name.appendChild(h('span', 'rsep', ' · '));
        name.appendChild(h('span', 'rname', root.name));
      }
      head.appendChild(name);
      head.appendChild(h('span', 'why',
        t.rootPartialId == null
          ? '— a root rendered no element, so the trees and the roots do not line up'
          : t.reason === 'unreached'
            ? '— grown standalone; only reachable through a cycle'
            : '— entry point'));
      head.appendChild(h('span', 'size', num(t.size) + (t.size === 1 ? ' element' : ' elements')));
      return head;
    }

    var walk = function (id) {
      if (shown >= LIMIT) return;
      var inst = P.instances[id];
      var text = (inst.tag + ' ' + inst.classes.join(' ')).toLowerCase();
      if (!state.filter || text.indexOf(state.filter) !== -1) {
        shown++;
        var row = h('div', 'row' + (state.instance === id ? ' on' : '') + (hits && hits.has(id) ? ' lit' : ''));
        row.tabIndex = 0;
        row.onclick = function () { pick('instance', id); };
        row.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick('instance', id); } };
        row.appendChild(h('span', 'gutter ' + inst.via, inst.via === 'element' ? '' : inst.via));
        var name = nameOf(inst.tag, inst.elementId, inst.classes);
        name.style.paddingLeft = (inst.depth * 14) + 'px';
        row.appendChild(name);
        var trail = h('span', 'trail');
        if (inst.conditional) trail.appendChild(h('span', 'badge conditional', 'conditional'));
        var best = bestMatch(id);
        if (best) {
          var b = h('span', 'badge ' + (best.matchType === 'definite' ? 'solid' : best.matchType === 'dynamic' ? 'dyn' : 'cond'));
          b.textContent = inst.matched.length + ' · ' + best.matchType;
          trail.appendChild(b);
        }
        row.appendChild(trail);
        bucket.appendChild(row);
        inTree++;
      }
      inst.children.forEach(walk);
    };
    P.trees.forEach(function (t) {
      bucket = frag();
      inTree = 0;
      t.tops.forEach(walk);
      /* A filter can empty a whole tree; heading nothing would be a lie. */
      if (inTree === 0) return;
      tree.appendChild(treeHead(t));
      tree.appendChild(bucket);
    });
    if (!shown) tree.appendChild(h('p', 'empty', 'Nothing matches that filter.'));
    if (shown >= LIMIT) tree.appendChild(h('p', 'empty', 'Showing the first ' + LIMIT + ' rows.'));
    scroll.appendChild(tree);
    body.appendChild(scroll);
    panel.appendChild(body);
    out.appendChild(panel);
    return out;
  }

  /* --- tab 4: trace ---------------------------------------------------- */

  function viewTrace() {
    var out = frag();
    var panel = h('div', 'panel');
    var head = h('header');
    head.appendChild(h('h2', null, 'Step 5 · Selector trace'));
    panel.appendChild(head);
    var body = h('div', 'body');

    var picker = h('div', 'picker');
    var choose = h('select');
    P.selectors.forEach(function (s) {
      var o = h('option', null, s.text + '  (' + s.hits.length + ' hits, line ' + P.rules[s.ruleId].line + ')');
      o.value = String(s.id);
      if (state.selector === s.id) o.selected = true;
      choose.appendChild(o);
    });
    choose.onchange = function () { pick('selector', Number(choose.value)); };
    picker.appendChild(choose);
    body.appendChild(picker);

    if (state.selector == null) state.selector = P.selectors.length ? 0 : null;
    if (state.selector == null) {
      body.appendChild(h('p', 'empty', 'No selectors were parsed.'));
      panel.appendChild(body); out.appendChild(panel); return out;
    }
    var s = P.selectors[state.selector];

    body.appendChild(h('h3', null, 'Compound steps'));
    body.appendChild(h('p', 'note', 'Each step is compiled and run for real, rightmost compound first. ' +
      'Where the count drops is where the selector stops reaching — that step’s constraint is the one doing the work.'));
    var steps = h('div', 'steps');
    var prev = null;
    s.steps.forEach(function (step, i) {
      var row = h('div', 'step-row' + (prev !== null && step.hits < prev ? ' drop' : '') + (step.hits === 0 ? ' zero' : ''));
      row.appendChild(h('span', 'k', String(i + 1)));
      row.appendChild(h('span', 's', step.text));
      var hh = h('span', 'h');
      hh.textContent = num(step.hits) + ' instance' + (step.hits === 1 ? '' : 's') +
        (prev !== null && step.hits < prev ? '   −' + num(prev - step.hits) : '');
      row.appendChild(hh);
      steps.appendChild(row);
      prev = step.hits;
    });
    body.appendChild(steps);

    body.appendChild(h('h3', null, 'Per element'));
    var owners = P.elements.filter(function (e) {
      return e.matches.some(function (m) { return m.selectorId === s.id; });
    });
    if (!owners.length) {
      body.appendChild(h('p', 'empty', 'This selector matched no element.'));
    }
    owners.forEach(function (el) {
      var m = el.matches.find(function (x) { return x.selectorId === s.id; });
      var card = h('div', 'panel');
      var ch = h('header');
      var lab = h('h2');
      lab.style.textTransform = 'none';
      lab.style.letterSpacing = '0';
      lab.style.fontFamily = 'var(--mono)';
      lab.style.color = 'var(--ink)';
      lab.textContent = el.label;
      ch.appendChild(lab);
      ch.appendChild(h('span', 'count', el.file + ' · ' + el.partial + ':' + el.line));
      card.appendChild(ch);
      var cb = h('div', 'body');
      var summary = h('p', 'ratio');
      summary.appendChild(document.createTextNode(m.hits + ' of ' + m.total + ' instances matched → '));
      summary.appendChild(h('span', 'badge ' + m.matchType, m.matchType));
      if (m.matchType === 'dynamic') summary.appendChild(document.createTextNode('  (class or id is bound at runtime)'));
      else if (m.conditionalHit) summary.appendChild(document.createTextNode('  (a matching instance sits in a b-if branch)'));
      cb.appendChild(summary);
      var hitSet = new Set(s.hits);
      el.instances.slice(0, 24).forEach(function (iid) {
        var inst = P.instances[iid];
        var hit = hitSet.has(iid);
        var v = h('div', 'verdict ' + (hit ? 'yes' : 'no'));
        v.appendChild(h('span', 'mark', hit ? '●' : '○'));
        var chain = [], cur = inst;
        while (cur) { chain.unshift(cur.tag + cur.classes.map(function (c) { return '.' + c; }).join('')); cur = cur.parent == null ? null : P.instances[cur.parent]; }
        var link = h('button', 'sel');
        link.textContent = chain.join(' › ');
        link.onclick = function () { state.tab = 2; pick('instance', iid); };
        v.appendChild(link);
        cb.appendChild(v);
      });
      if (el.instances.length > 24) cb.appendChild(h('p', 'empty', '… and ' + (el.instances.length - 24) + ' more instances'));
      card.appendChild(cb);
      body.appendChild(card);
    });

    panel.appendChild(body);
    out.appendChild(panel);
    return out;
  }

  /* --- shell ----------------------------------------------------------- */

  var TABS = [
    ['Parse & roots', viewParse],
    ['Expansion', viewExpansion],
    ['Forest', viewForest],
    ['Trace', viewTrace]
  ];

  /* Every render replaces the whole view, so its scroll boxes come back as new
     elements sitting at the top — which threw the reader back to the top of a
     long tree on every click. The offsets are carried across by index (tab 1 has
     two boxes), and only within one tab: switching tabs is a move, not a return. */
  var scrollMemory = {};
  var renderedTab = null;

  function scrollBoxes() {
    return document.getElementById('view').querySelectorAll('.scroll');
  }

  function saveScroll() {
    if (renderedTab == null) return;
    var boxes = scrollBoxes(), tops = [];
    for (var i = 0; i < boxes.length; i++) tops.push(boxes[i].scrollTop);
    scrollMemory[renderedTab] = tops;
  }

  function restoreScroll() {
    var tops = scrollMemory[state.tab];
    if (!tops) return;
    var boxes = scrollBoxes();
    for (var i = 0; i < boxes.length && i < tops.length; i++) boxes[i].scrollTop = tops[i];
  }

  function render() {
    saveScroll();
    var tabs = document.getElementById('tabs');
    tabs.textContent = '';
    TABS.forEach(function (t, i) {
      var b = h('button', 'tab');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === state.tab));
      b.appendChild(h('span', 'idx', String(i + 1)));
      b.appendChild(document.createTextNode(t[0]));
      b.onclick = function () { state.tab = i; render(); };
      tabs.appendChild(b);
    });
    var view = document.getElementById('view');
    view.textContent = '';
    view.appendChild(TABS[state.tab][1]());
    restoreScroll();
    renderedTab = state.tab;
    var rail = document.getElementById('rail');
    rail.textContent = '';
    rail.appendChild(renderRail());
    remember();
  }

  render();
})();
`;

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stage(n: number, label: string, value: string, sub: string): string {
	return `<div class="stage"><span class="n">${n}</span><div><div class="lab">${escapeHtml(label)}</div>` +
		`<div class="val">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div></div></div>`;
}

function renderHead(): string {
	return `<title>Backflip CSS Trace</title>\n<style>${STYLE}</style>`;
}

function renderMarkup(payload: ExplainPayload): string {
	const { meta } = payload;
	const c = meta.counts;
	const entryRoots = payload.partials.filter(p => p.rootReason === 'entry').length;

	const budgets = [
		`FOR_REPS ${meta.forReps}`,
		`MAX_DEPTH ${meta.maxDepth}`,
		`MAX_INSTANCES ${meta.maxInstances.toLocaleString('en-US')}`,
		...meta.timings.map(t => `${t.label} ${t.ms}ms`),
	].map(text => `<span class="chip">${escapeHtml(text)}</span>`).join('');

	const warning = meta.truncated
		? '<span class="chip warn">instance budget exhausted — the forest is incomplete</span>'
		: '';

	// What the templates were compiled against. Without asset dirs the compiler
	// drops every `src~` attribute and says so once per use, so stating which ones
	// were configured turns a wall of diagnostics into a one-line explanation.
	// Stated, not alarmed about: a project with no asset attributes is fine, and
	// one that has them is already shouting in the band below.
	const assets = `<span class="chip">${escapeHtml(
		meta.assetDirs.length > 0
			? `assets ${meta.assetDirs.map(n => `@${n}`).join(' ')}`
			: meta.configDir !== undefined
				? 'no asset dirs in backflip.json — src~ will not compile'
				: 'no backflip.json found — src~ will not compile',
	)}</span>`;

	// A <details>, so it closes without script and stays closed until asked for.
	const diagnostics = meta.warnings.length === 0 ? '' :
		`<details class="diags" id="diags"><summary>${meta.warnings.length} compile diagnostic${meta.warnings.length === 1 ? '' : 's'}</summary><ul>` +
		meta.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('') +
		'</ul></details>';

	// The payload is inert data; escaping `<` keeps it from closing the script early.
	const data = JSON.stringify(payload).replace(/</g, '\\u003c');

	return `<div class="chrome">
  <div class="ident">
    <h1>CSS analysis, step by step</h1>
    <span class="path">${escapeHtml(meta.project)}</span>
    <span class="stamp">${escapeHtml(meta.cssFiles.join(', ') || 'inline CSS')}</span>
  </div>
  <div class="pipeline">
    ${stage(1, 'parse css', `${c.rules}`, `${c.selectors} selectors`)}
    ${stage(2, 'roots', `${entryRoots}`, `of ${c.partials} partials`)}
    ${stage(3, 'expand', c.instances.toLocaleString('en-US'), `from ${c.files} files`)}
    ${stage(4, 'match', `${c.matchedElements}`, 'elements with rules')}
  </div>
  <div class="budgets">${budgets}${assets}${warning}</div>
  ${diagnostics}
  <div class="tabs" id="tabs" role="tablist"></div>
</div>
<div class="work">
  <div class="view" id="view"></div>
  <div class="rail" id="rail"></div>
</div>
<script type="application/json" id="explain-data">${data}</script>
<script>${SCRIPT}</script>`;
}

/** Title, style and markup with no document wrapper — what an Artifact publish takes. */
export function renderBody(payload: ExplainPayload): string {
	return `${renderHead()}\n${renderMarkup(payload)}`;
}

/** A complete standalone document, for writing to a file. */
export function renderDocument(payload: ExplainPayload): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${renderHead()}
</head>
<body>
${renderMarkup(payload)}
</body>
</html>`;
}
