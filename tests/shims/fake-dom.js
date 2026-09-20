/* Minimal DOM shim for render smoke tests. Elements keep their innerHTML as a
   string, which is enough to assert on what a tab renders and — more usefully —
   to surface any ReferenceError or TypeError thrown along the render path. */
"use strict";

function makeElement(tag) {
  const el = {
    tagName: tag,
    innerHTML: "",
    textContent: "",
    className: "",
    value: "",
    checked: false,
    clientWidth: 900,
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {},
    remove() {},
    focus() {},
    closest: () => makeElement("div"),
    querySelector: () => makeElement("div"),
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
  };
  return el;
}

/* ids: array of element ids the page will look up by getElementById */
function makeDocument(ids) {
  const byId = new Map();
  (ids || []).forEach((id) => byId.set(id, makeElement("div")));
  const body = makeElement("body");
  return {
    body,
    documentElement: { setAttribute() {} },
    addEventListener() {},
    createElement: (t) => makeElement(t),
    createElementNS: (_ns, t) => makeElement(t),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeElement("div"));
      return byId.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    __byId: byId,
    __el: (id) => byId.get(id),
  };
}

module.exports = { makeDocument, makeElement };
