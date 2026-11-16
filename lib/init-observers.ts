/**
 * In-page instrumentation, installed with addInitScript before any site code runs.
 *
 *  - web-vitals (attribution build, inlined from node_modules) -> window.__perf.vitals
 *  - capture-phase pointerdown / click / keydown probe (epoch timestamp + target of each interaction)
 *  - MutationObserver on document: first DOM mutation after each interaction (= first visual feedback)
 *  - PerformanceObservers: event (durationThreshold 16), first-input, longtask, long-animation-frame,
 *    layout-shift, largest-contentful-paint, paint, soft-navigation
 *
 * All timestamps are epoch milliseconds: performance.timeOrigin + <DOMHighResTimeStamp>, so they line up
 * with Playwright's request.timing().startTime on the node side.
 *
 * The probe is kept as a plain-JS string (not a TS function) so no transpiler helper can leak into the page.
 * It must not contain backticks or template placeholders.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from '@playwright/test';

const PROBE_SOURCE = String.raw`
(function () {
  if (window.top !== window) return;            // top frame only (skip recaptcha / ad iframes)
  if (window.__perf && window.__perf.installed) return;

  var TO = performance.timeOrigin;
  function epoch(t) { return TO + (t == null ? performance.now() : t); }
  function r1(n) { return Math.round(n * 10) / 10; }

  var P = (window.__perf = {
    installed: true,
    timeOrigin: TO,
    seq: 0,
    interactions: [],
    events: [],
    longTasks: [],
    loafs: [],
    shifts: [],
    lcp: [],
    paints: {},
    softNavs: [],
    vitals: {},
    mutationBatches: [],
    errors: [],
    supported: (window.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || []
  });

  // ---- element -> short selector (ids from Radix are unstable and skipped) -------------------------
  function pathOf(node) {
    try {
      if (!node) return null;
      if (node.nodeType === 3) node = node.parentElement;
      if (!node || node.nodeType !== 1) return node === document ? 'document' : null;
      var parts = [];
      var el = node;
      for (var depth = 0; el && el.nodeType === 1 && depth < 4; depth++) {
        var s = el.tagName.toLowerCase();
        if (el.id && !/radix|^:|:r/.test(el.id)) { s += '#' + el.id; parts.unshift(s); break; }
        var role = el.getAttribute('role');
        if (role) s += '[role=' + role + ']';
        var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += '.' + cls.join('.');
        parts.unshift(s);
        el = el.parentElement;
      }
      return parts.join(' > ');
    } catch (e) { return null; }
  }
  function sel(node) {
    try {
      var out = pathOf(node);
      if (!out || out === 'document') return out;
      if (node.nodeType === 3) node = node.parentElement;
      var label = node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('alt') || '';
      if (!label) {
        var txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt && txt.length <= 40) label = txt;
      }
      if (label) out += ' "' + label.slice(0, 40) + '"';
      return out.slice(0, 220);
    } catch (e) { return null; }
  }
  P.sel = sel;

  // ---- interaction probe ---------------------------------------------------------------------------
  // Ambient learning: while the harness declares the page idle (P.learn(true)), every element that
  // mutates is, by construction, changing on its own (live tickers, clocks, "2m ago" labels). Those
  // elements are ignored when looking for the first mutation caused by an interaction. Learning stops
  // by itself at the next trusted interaction.
  var pending = [];
  var learning = false;
  var learnSince = 0;
  var ambientNodes = new WeakSet();
  var targetEls = new WeakMap();      // interaction record -> the element that was clicked / typed into
  var ambientTextPaths = {};
  var ambientPathCount = 0;
  P.learn = function (on) {
    if (on && !learning) learnSince = epoch();
    learning = !!on;
    return { learning: learning, since: learnSince, now: epoch(), textPaths: ambientPathCount };
  };
  function onInteraction(e) {
    try {
      if (!e.isTrusted) return;
      learning = false;
      var rec = {
        seq: ++P.seq,
        type: e.type,
        t: epoch(e.timeStamp),          // when the input happened (hardware/dispatch timestamp)
        tHandler: epoch(),              // when the main thread got to it
        target: sel(e.target),
        key: e.type === 'keydown' ? (e.key && e.key.length === 1 ? 'char' : e.key) : undefined,
        firstMutation: null,            // first mutation that is not on an ambient element
        mutationTarget: null,
        mutationKind: null,
        firstAnyMutation: null,         // first visual mutation of any kind (may be a ticker)
        ambientSkipped: 0
      };
      if (e.target && e.target.nodeType === 1) targetEls.set(rec, e.target);
      P.interactions.push(rec);
      pending.push(rec);
      if (pending.length > 60) pending.shift();
      if (P.interactions.length > 2000) P.interactions.splice(0, 500);
    } catch (err) { P.errors.push('interaction: ' + err); }
  }
  ['pointerdown', 'click', 'keydown'].forEach(function (type) {
    window.addEventListener(type, onInteraction, { capture: true, passive: true });
  });

  // ---- mutation probe ------------------------------------------------------------------------------
  var NON_VISUAL = { SCRIPT: 1, LINK: 1, STYLE: 1, META: 1, TITLE: 1, HEAD: 1, NOSCRIPT: 1 };
  function elOf(m) { var t = m.target; return t ? (t.nodeType === 1 ? t : t.parentElement) : null; }
  function visualRecord(m) {
    var el = elOf(m);
    if (!el) return false;
    if (NON_VISUAL[el.tagName]) return false;
    if (document.head && document.head.contains(el)) return false;
    if (m.type === 'childList') {
      var nodes = [];
      var i;
      for (i = 0; i < m.addedNodes.length; i++) nodes.push(m.addedNodes[i]);
      for (i = 0; i < m.removedNodes.length; i++) nodes.push(m.removedNodes[i]);
      if (nodes.length) {
        var anyVisual = false;
        for (i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.nodeType === 3 || (n.nodeType === 1 && !NON_VISUAL[n.tagName])) { anyVisual = true; break; }
        }
        if (!anyVisual) return false;
      }
    }
    return true;
  }
  // a text-only update: characterData, or a childList change that only swaps text nodes
  function isTextUpdate(m) {
    if (m.type === 'characterData') return true;
    if (m.type !== 'childList') return false;
    var i;
    for (i = 0; i < m.addedNodes.length; i++) if (m.addedNodes[i].nodeType !== 3) return false;
    for (i = 0; i < m.removedNodes.length; i++) if (m.removedNodes[i].nodeType !== 3) return false;
    return true;
  }
  // "3m ago" -> "4m ago", "2,945.30" -> "2,946.05", "+0.3%" -> "-0.1%": only the numbers changed
  var NUMERIC = /[\d.,:+\-−%▲▼△▽\s]/g;
  function numericOnlyChange(m) {
    try {
      var before = null, after = null;
      if (m.type === 'characterData') { before = m.oldValue; after = m.target.nodeValue; }
      else if (m.type === 'childList' && m.addedNodes.length === 1 && m.removedNodes.length === 1) { before = m.removedNodes[0].nodeValue; after = m.addedNodes[0].nodeValue; }
      if (before == null || after == null || before === after) return false;
      return before.replace(NUMERIC, '') === after.replace(NUMERIC, '');
    } catch (err) { return false; }
  }
  function relatedToInteraction(el) {
    for (var i = 0; i < pending.length; i++) {
      var t = targetEls.get(pending[i]);
      if (t && (t === el || t.contains(el) || el.contains(t))) return true;
    }
    return false;
  }
  // A mutation is "ambient" (not feedback for the pending interaction) when
  //  - the element is not rendered (e.g. a sidebar that is display:none at this viewport), or
  //  - the element was seen changing on its own while the page was idle (learned), or
  //  - it is a text update on a structure that was seen ticking (learned path), or
  //  - only numbers changed in a text node that is not part of the element the user acted on.
  function isAmbient(m) {
    var el = elOf(m);
    if (!el) return false;
    try { if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return true; } catch (err) {}
    if (ambientNodes.has(el)) return true;
    if (!isTextUpdate(m)) return false;
    if (ambientTextPaths[pathOf(el)] === 1) return true;
    return numericOnlyChange(m) && !relatedToInteraction(el);
  }
  function startMutationObserver() {
    try {
      new MutationObserver(function (records) {
        var now = epoch();
        var visual = [];
        var i;
        for (i = 0; i < records.length; i++) if (visualRecord(records[i])) visual.push(records[i]);
        if (!visual.length) return;
        P.mutationBatches.push(now);
        if (P.mutationBatches.length > 600) P.mutationBatches.splice(0, 200);
        if (learning) {
          for (i = 0; i < visual.length; i++) {
            var el = elOf(visual[i]);
            if (!el) continue;
            ambientNodes.add(el);
            if (isTextUpdate(visual[i]) && ambientPathCount < 300) {
              var pth = pathOf(el);
              if (pth && ambientTextPaths[pth] !== 1) { ambientTextPaths[pth] = 1; ambientPathCount++; }
            }
          }
          return;
        }
        if (!pending.length) return;
        var first = null;
        for (i = 0; i < visual.length; i++) { if (!isAmbient(visual[i])) { first = visual[i]; break; } }
        var target = first ? sel(first.target) : null;
        var still = [];
        for (var j = 0; j < pending.length; j++) {
          var it = pending[j];
          if (it.firstAnyMutation == null) it.firstAnyMutation = now;
          if (first) {
            it.firstMutation = now;
            it.mutationTarget = target;
            it.mutationKind = first.type + (first.attributeName ? ':' + first.attributeName : '');
          } else {
            it.ambientSkipped++;
            still.push(it);
          }
        }
        pending = still;
      }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true, characterDataOldValue: true });
    } catch (err) { P.errors.push('mutation: ' + err); }
  }
  startMutationObserver();

  // ---- performance observers -----------------------------------------------------------------------
  function observe(type, cb, extra) {
    try {
      if (P.supported.indexOf(type) === -1) return false;
      var opts = { type: type, buffered: true };
      if (extra) for (var k in extra) opts[k] = extra[k];
      new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) { try { cb(entries[i]); } catch (err) { P.errors.push(type + ': ' + err); } }
      }).observe(opts);
      return true;
    } catch (err) { P.errors.push('observe ' + type + ': ' + err); return false; }
  }

  function pushEvent(e) {
    P.events.push({
      name: e.name,
      entryType: e.entryType,
      start: epoch(e.startTime),
      inputDelay: r1(e.processingStart - e.startTime),
      processing: r1(e.processingEnd - e.processingStart),
      presentation: r1(Math.max(0, e.startTime + e.duration - e.processingEnd)),
      duration: r1(e.duration),
      interactionId: e.interactionId || 0,
      target: sel(e.target)
    });
    if (P.events.length > 3000) P.events.splice(0, 1000);
  }
  observe('event', pushEvent, { durationThreshold: 16 });
  observe('first-input', pushEvent);

  observe('longtask', function (e) {
    P.longTasks.push({ start: epoch(e.startTime), rel: r1(e.startTime), duration: r1(e.duration) });
  });

  observe('long-animation-frame', function (e) {
    var scripts = [];
    try {
      var list = (e.scripts || []).slice().sort(function (a, b) { return b.duration - a.duration; }).slice(0, 3);
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        scripts.push({
          src: String(s.sourceURL || '').split('?')[0].slice(-120),
          fn: String(s.sourceFunctionName || '').slice(0, 60),
          invoker: String(s.invoker || '').slice(0, 80),
          duration: r1(s.duration)
        });
      }
    } catch (err) {}
    P.loafs.push({
      start: epoch(e.startTime), rel: r1(e.startTime), duration: r1(e.duration),
      blocking: r1(e.blockingDuration || 0),
      renderStart: e.renderStart ? r1(e.renderStart - e.startTime) : null,
      scripts: scripts
    });
  });

  observe('layout-shift', function (e) {
    var sources = [];
    try {
      var src = e.sources || [];
      for (var i = 0; i < src.length && i < 3; i++) sources.push(sel(src[i].node));
    } catch (err) {}
    P.shifts.push({ t: epoch(e.startTime), rel: r1(e.startTime), value: e.value, hadRecentInput: !!e.hadRecentInput, sources: sources });
  });

  observe('largest-contentful-paint', function (e) {
    P.lcp.push({ time: r1(e.startTime), renderTime: r1(e.renderTime || 0), loadTime: r1(e.loadTime || 0), size: e.size, element: sel(e.element), url: e.url || null, tag: e.element ? e.element.tagName.toLowerCase() : null });
  });

  observe('paint', function (e) { P.paints[e.name] = r1(e.startTime); });

  observe('soft-navigation', function (e) {
    P.softNavs.push({ start: epoch(e.startTime), rel: r1(e.startTime), url: e.name, navigationId: e.navigationId || null });
  });

  // ---- web-vitals (attribution build) ----------------------------------------------------------------
  function pick(obj, keys) {
    var out = {};
    if (!obj) return out;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v == null) continue;
      if (typeof v === 'number') out[keys[i]] = r1(v);
      else if (typeof v === 'string' || typeof v === 'boolean') out[keys[i]] = v;
    }
    return out;
  }
  var ATTR = {
    LCP: ['target', 'url', 'timeToFirstByte', 'resourceLoadDelay', 'resourceLoadDuration', 'elementRenderDelay'],
    CLS: ['largestShiftTarget', 'largestShiftTime', 'largestShiftValue', 'loadState'],
    INP: ['interactionTarget', 'interactionType', 'interactionTime', 'inputDelay', 'processingDuration', 'presentationDelay', 'loadState'],
    FCP: ['timeToFirstByte', 'firstByteToFCP', 'loadState'],
    TTFB: ['waitingDuration', 'cacheDuration', 'dnsDuration', 'connectionDuration', 'requestDuration']
  };
  function store(metric) {
    try {
      var navId = metric.navigationId == null ? 0 : metric.navigationId;
      var rec = {
        name: metric.name,
        value: metric.name === 'CLS' ? metric.value : r1(metric.value),
        rating: metric.rating,
        navigationType: metric.navigationType,
        navigationId: navId,
        navigationURL: metric.navigationURL || null,
        attribution: pick(metric.attribution, ATTR[metric.name] || []),
        at: epoch()
      };
      var arr = P.vitals[metric.name] || (P.vitals[metric.name] = []);
      for (var i = 0; i < arr.length; i++) { if (arr[i].navigationId === navId) { arr[i] = rec; return; } }
      arr.push(rec);
    } catch (err) { P.errors.push('vitals: ' + err); }
  }
  try {
    var wv = window.__webVitals;
    if (wv) {
      var o = { reportAllChanges: true, reportSoftNavs: true };
      wv.onTTFB(store, o); wv.onFCP(store, o); wv.onLCP(store, o); wv.onCLS(store, o);
      wv.onINP(store, { reportAllChanges: true, reportSoftNavs: true, durationThreshold: 16 });
    } else { P.errors.push('web-vitals bundle missing'); }
  } catch (err) { P.errors.push('web-vitals init: ' + err); }

  // ---- UI conditions, evaluated once per animation frame by page.waitForFunction ---------------------
  // Playwright's own locator waits re-check on a backoff of up to 500 ms, which is too coarse for timing.
  var ROLE_SEL = {
    heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
    button: 'button,[role=button],input[type=button],input[type=submit]',
    combobox: '[role=combobox],select',
    option: '[role=option],option',
    link: 'a[href],[role=link]',
    menuitem: '[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]',
    textbox: 'textarea,input:not([type]),input[type=text],input[type=search],[role=textbox]',
    dialog: 'dialog,[role=dialog]',
    listbox: '[role=listbox]'
  };
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var st = getComputedStyle(el);
    if (st.visibility !== 'visible' || st.display === 'none') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function nameOf(el) {
    var n = el.getAttribute('aria-label');
    if (!n) {
      var lb = el.getAttribute('aria-labelledby');
      if (lb) n = lb.split(/\s+/).map(function (id) { var t = document.getElementById(id); return t ? t.textContent : ''; }).join(' ');
    }
    if (!n && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) n = el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (!n) n = el.textContent || '';
    if (!n) n = el.getAttribute('title') || '';
    return norm(n);
  }
  function matches(value, m) {
    if (m == null) return true;
    value = norm(value);
    if (m.re != null) return new RegExp(m.re, m.flags || '').test(value);
    if (m.exact) return value === norm(m.text);
    return value.toLowerCase().indexOf(norm(m.text).toLowerCase()) !== -1;
  }
  function isEnabled(el) {
    return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('fieldset[disabled]');
  }
  function scopeOf(spec) {
    if (!spec.within) return document;
    return document.querySelector(spec.within === 'main' ? 'main,[role=main]' : spec.within);
  }
  // Fingerprint of the post list in <main>: text of the first n (default 8) post cards. Eight, because the
  // first few cards can be pinned/featured posts that are identical across tabs. Digits are masked so live
  // vote counters do not count as a change). A card is found by climbing from its vote button.
  var VOTE_RE = /^(\d+ Votes?|Vote)$/;
  function feedSignature(n) {
    var scope = document.querySelector('main,[role=main]') || document;
    var btns = scope.querySelectorAll('button');
    var out = [];
    for (var i = 0; i < btns.length && out.length < (n || 8); i++) {
      var b = btns[i];
      if (!VOTE_RE.test(norm(b.textContent)) || !isVisible(b)) continue;
      var el = b;
      for (var d = 0; d < 6 && el.parentElement; d++) { el = el.parentElement; if (norm(el.textContent).length > 80) break; }
      out.push(norm(el.textContent).replace(/\d+/g, '#').slice(0, 60));
    }
    return out.join(' || ');
  }
  P.feedSignature = feedSignature;

  function check(spec) {
    try {
      var i, els, el, list;
      switch (spec.kind) {
        case 'feedChanged': { var sig = feedSignature(spec.n || 8); return sig !== '' && sig !== spec.baseline; }
        case 'url': return new RegExp(spec.re, spec.flags || '').test(location.pathname + location.search);
        case 'path': return new RegExp(spec.re, spec.flags || '').test(location.pathname);
        case 'title': return new RegExp(spec.re, spec.flags || '').test(document.title);
        case 'all': for (i = 0; i < spec.specs.length; i++) if (!check(spec.specs[i])) return false; return true;
        case 'not': return !check(spec.spec);
        case 'role':
        case 'css':
        case 'placeholder': {
          var scope = scopeOf(spec);
          if (!scope) return false;
          var selector = spec.kind === 'role' ? ROLE_SEL[spec.role] || '[role=' + spec.role + ']' : spec.kind === 'placeholder' ? '[placeholder]' : spec.selector;
          els = scope.querySelectorAll(selector);
          list = [];
          for (i = 0; i < els.length; i++) {
            el = els[i];
            if (spec.kind === 'placeholder' && !matches(el.getAttribute('placeholder'), spec.match)) continue;
            if (spec.kind === 'role' && spec.name && !matches(nameOf(el), spec.name)) continue;
            if (spec.hasText && !matches(spec.useValue ? el.value : el.textContent, spec.hasText)) continue;
            if (!isVisible(el)) continue;
            list.push(el);
          }
          if (list.length < (spec.minCount || 1)) return false;
          if (spec.enabled != null) {
            el = spec.pick === 'last' ? list[list.length - 1] : list[0];
            return isEnabled(el) === !!spec.enabled;
          }
          return true;
        }
        case 'text': {
          var root = scopeOf(spec);
          if (!root) return false;
          var walker = document.createTreeWalker(root === document ? document.body : root, NodeFilter.SHOW_TEXT);
          var node;
          while ((node = walker.nextNode())) {
            if (!node.nodeValue || !node.nodeValue.trim()) continue;
            el = node.parentElement;
            for (var d = 0; el && d < 3; d++, el = el.parentElement) {
              if (matches(el.textContent, spec.match)) { if (isVisible(el)) return true; break; }
            }
          }
          return false;
        }
      }
      return false;
    } catch (err) { P.errors.push('check: ' + err); return false; }
  }
  P.check = check;

  // ---- readers (called from node via page.evaluate) --------------------------------------------------
  function inWin(t, a, b) { return t >= a && t <= b; }

  P.now = function () { return { epoch: epoch(), dateNow: Date.now(), timeOrigin: TO, url: location.href }; };

  /** Everything observed between two epoch timestamps. */
  P.slice = function (from, to) {
    var f = function (arr, key) { return arr.filter(function (x) { return inWin(x[key], from, to); }); };
    var ambientFrom = from - 1000;
    var ambient = P.mutationBatches.filter(function (t) { return t >= ambientFrom && t < from; }).length;
    var vit = {};
    for (var k in P.vitals) vit[k] = P.vitals[k];
    return {
      url: location.href,
      timeOrigin: TO,
      interactions: f(P.interactions, 't'),
      events: f(P.events, 'start'),
      longTasks: P.longTasks.filter(function (x) { return x.start + x.duration >= from && x.start <= to; }),
      loafs: P.loafs.filter(function (x) { return x.start + x.duration >= from && x.start <= to; }),
      shifts: f(P.shifts, 't'),
      softNavs: f(P.softNavs, 'start'),
      vitals: vit,
      ambientMutations1s: ambient,
      errors: P.errors.slice(0, 20)
    };
  };

  /** Navigation Timing L2 + paint + LCP + CLS + long tasks for the current document. */
  P.pageLoad = function () {
    var nav = performance.getEntriesByType('navigation')[0];
    var n = null;
    if (nav) {
      var tls = nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0;
      n = {
        type: nav.type,
        redirectCount: nav.redirectCount,
        redirectMs: r1(nav.redirectEnd - nav.redirectStart),
        dns: r1(nav.domainLookupEnd - nav.domainLookupStart),
        tcp: r1(Math.max(0, nav.connectEnd - nav.connectStart - tls)),
        tls: r1(tls),
        requestStart: r1(nav.requestStart),
        ttfb: r1(nav.responseStart),
        responseEnd: r1(nav.responseEnd),
        domInteractive: r1(nav.domInteractive),
        dcl: r1(nav.domContentLoadedEventEnd),
        load: r1(nav.loadEventEnd),
        transferSize: nav.transferSize,
        encodedBodySize: nav.encodedBodySize,
        decodedBodySize: nav.decodedBodySize,
        protocol: nav.nextHopProtocol,
        serverTiming: (nav.serverTiming || []).map(function (s) { return s.name + ';dur=' + s.duration + (s.description ? ';desc=' + s.description : ''); }).join(', ')
      };
    }
    var lcp = P.lcp.length ? P.lcp[P.lcp.length - 1] : null;
    var cls = 0;
    var bySource = {};
    for (var i = 0; i < P.shifts.length; i++) {
      var s = P.shifts[i];
      if (s.hadRecentInput) continue;
      cls += s.value;
      var key = (s.sources && s.sources[0]) || '(unknown)';
      bySource[key] = (bySource[key] || 0) + s.value;
    }
    var topShift = Object.keys(bySource).map(function (k) { return { element: k, value: Math.round(bySource[k] * 10000) / 10000 }; })
      .sort(function (a, b) { return b.value - a.value; }).slice(0, 5);
    var vit = {};
    for (var k2 in P.vitals) {
      var arr = P.vitals[k2];
      for (var j = 0; j < arr.length; j++) if (arr[j].navigationType !== 'soft-navigation') vit[k2] = arr[j];
    }
    return {
      url: location.href,
      title: document.title,
      timeOrigin: TO,
      collectedAtRel: r1(performance.now()),
      nav: n,
      fp: P.paints['first-paint'] == null ? null : P.paints['first-paint'],
      fcp: P.paints['first-contentful-paint'] == null ? null : P.paints['first-contentful-paint'],
      lcp: lcp,
      lcpCandidates: P.lcp.length,
      clsRaw: Math.round(cls * 10000) / 10000,
      shiftCount: P.shifts.length,
      topShifts: topShift,
      longTasks: P.longTasks.map(function (t) { return { rel: t.rel, duration: t.duration }; }),
      loafs: P.loafs.map(function (t) { return { rel: t.rel, duration: t.duration, blocking: t.blocking, scripts: t.scripts }; }),
      loafSupported: P.supported.indexOf('long-animation-frame') !== -1,
      vitals: vit,
      resourceCount: performance.getEntriesByType('resource').length,
      errors: P.errors.slice(0, 20)
    };
  };

  /** Broken images and mixed content in the current DOM. */
  P.quality = function () {
    var broken = [];
    var imgs = document.images;
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.complete && im.naturalWidth === 0 && (im.currentSrc || im.src)) broken.push(String(im.currentSrc || im.src).slice(0, 300));
    }
    var mixed = [];
    if (location.protocol === 'https:') {
      var nodes = document.querySelectorAll('img[src^="http:"],script[src^="http:"],link[rel=stylesheet][href^="http:"],iframe[src^="http:"],video[src^="http:"],audio[src^="http:"],source[src^="http:"]');
      for (var j = 0; j < nodes.length; j++) mixed.push(nodes[j].tagName.toLowerCase() + ' ' + String(nodes[j].getAttribute('src') || nodes[j].getAttribute('href')).slice(0, 300));
    }
    return { url: location.href, imageCount: imgs.length, brokenImages: broken, mixedContent: mixed };
  };
})();
`;

const WV_DIR = path.join(__dirname, '..', 'node_modules', 'web-vitals');
let cached: string | null = null;

/** The full init script: inlined web-vitals attribution IIFE, then the probes. */
export function buildInitScript(): string {
  if (cached) return cached;
  const wvPath = path.join(WV_DIR, 'dist', 'web-vitals.attribution.iife.js');
  const wv = fs.readFileSync(wvPath, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '');
  cached = `(function(){ if (window.top !== window || window.__webVitals) return; try { ${wv}\n; window.__webVitals = webVitals; } catch (e) { window.__webVitalsError = String(e); } })();\n${PROBE_SOURCE}`;
  return cached;
}

/** Install on a context: applies to every page and every navigation in it. */
export async function installObservers(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: buildInitScript() });
}

export function webVitalsVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(WV_DIR, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}
