/*
 * dc-mini.js — a tiny renderer for the My Gardrobe page template.
 * Supports {{path}} holes in text and attributes, <sc-for list as>,
 * <sc-if value>, and on* event attributes bound to functions from renderVals().
 */
(function () {
  'use strict';

  function lookup(scope, path) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var parts = path.split('.');
    var v = scope;
    for (var i = 0; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }

  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;
  var ANY = /\{\{\s*([^}]+?)\s*\}\}/g;

  function interp(str, scope) {
    return str.replace(ANY, function (_, p) {
      var v = lookup(scope, p);
      return v == null ? '' : String(v);
    });
  }

  var EVENT_MAP = { onclick: 'click', onchange: 'input', oninput: 'input', onsubmit: 'submit', onkeydown: 'keydown' };

  function buildChildren(parent, out, scope) {
    for (var n = parent.firstChild; n; n = n.nextSibling) build(n, out, scope);
  }

  function build(node, out, scope) {
    if (node.nodeType === 3) {
      out.appendChild(document.createTextNode(interp(node.nodeValue, scope)));
      return;
    }
    if (node.nodeType !== 1) return;
    var name = node.localName;
    if (name === 'sc-for') {
      var list = lookup(scope, (node.getAttribute('list') || '').replace(/[{}]/g, '')) || [];
      var as = node.getAttribute('as') || 'item';
      for (var i = 0; i < list.length; i++) {
        var child = Object.create(scope);
        child[as] = list[i];
        child.$index = i;
        buildChildren(node, out, child);
      }
      return;
    }
    if (name === 'sc-if') {
      var cond = lookup(scope, (node.getAttribute('value') || '').replace(/[{}]/g, ''));
      if (cond) buildChildren(node, out, scope);
      return;
    }
    var el = node.cloneNode(false);
    var attrs = Array.prototype.slice.call(node.attributes);
    for (var a = 0; a < attrs.length; a++) {
      var at = attrs[a];
      var an = at.name;
      if (an.indexOf('hint-') === 0) { el.removeAttribute(an); continue; }
      var whole = WHOLE.exec(at.value);
      var lower = an.toLowerCase();
      if (lower.indexOf('on') === 0 && whole) {
        el.removeAttribute(an);
        var fn = lookup(scope, whole[1]);
        if (typeof fn === 'function') {
          var evt = EVENT_MAP[lower] || lower.slice(2);
          el.addEventListener(evt, fn);
        }
        continue;
      }
      if (at.value.indexOf('{{') < 0) continue;
      var val = whole ? lookup(scope, whole[1]) : interp(at.value, scope);
      if (val === undefined || val === null || val === false && !/^aria-/.test(lower)) {
        el.removeAttribute(an);
      } else {
        el.setAttribute(an, String(val));
      }
      if (lower === 'value' && 'value' in el) el.value = val == null ? '' : String(val);
    }
    buildChildren(node, el, scope);
    out.appendChild(el);
  }

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (patch) {
    var p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = Object.assign({}, this.state, p);
    this.__schedule();
  };
  DCLogic.prototype.forceUpdate = function () { this.__schedule(); };
  DCLogic.prototype.__schedule = function () {
    var self = this;
    if (self.__pending) return;
    self.__pending = true;
    Promise.resolve().then(function () { self.__pending = false; self.__render(); });
  };
  DCLogic.prototype.__render = function () {
    var root = this.__root, tpl = this.__tpl;
    var active = document.activeElement;
    var focusSel = null, caret = null;
    if (active && active.tagName === 'INPUT' && root.contains(active)) {
      focusSel = 'input[type="' + (active.getAttribute('type') || 'text') + '"]';
      try { caret = active.selectionStart; } catch (e) {}
    }
    var frag = document.createDocumentFragment();
    buildChildren(tpl.content, frag, this.renderVals());
    root.replaceChildren(frag);
    if (focusSel) {
      var inp = root.querySelector(focusSel);
      if (inp) { inp.focus(); try { if (caret != null) inp.setSelectionRange(caret, caret); } catch (e) {} }
    }
  };

  window.DCLogic = DCLogic;
  window.dcMount = function (Component, tplSelector, rootSelector) {
    var c = new Component({});
    c.state = c.state || {};
    c.__tpl = document.querySelector(tplSelector);
    c.__root = document.querySelector(rootSelector);
    c.__render();
    if (typeof c.componentDidMount === 'function') c.componentDidMount();
    return c;
  };
})();
