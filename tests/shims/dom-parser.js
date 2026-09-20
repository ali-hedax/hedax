/* Minimal XML DOMParser shim — only the surface `parseXlsxNative` uses:
   getElementsByTagName, getAttribute, getAttributeNS, textContent, [0], .length.
   Node has no DOMParser, so tests would otherwise be unable to exercise the real
   xlsx reader that ships in the dashboard. Not a general-purpose XML parser. */
"use strict";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

class Element {
  constructor(name, attrs) {
    this.tagName = name;
    this.localName = name.includes(":") ? name.split(":").pop() : name;
    this.attrs = attrs || {};
    this.children = [];
    this.text = "";
  }
  getAttribute(name) {
    if (Object.prototype.hasOwnProperty.call(this.attrs, name)) return this.attrs[name];
    return null;
  }
  // The real DOM resolves by namespace URI; for our fixtures matching the local
  // name is equivalent and keeps the shim small.
  getAttributeNS(_ns, localName) {
    for (const k of Object.keys(this.attrs)) {
      if (k === localName || k.endsWith(":" + localName)) return this.attrs[k];
    }
    return null;
  }
  getElementsByTagName(name) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (name === "*" || c.tagName === name || c.localName === name) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  get textContent() {
    let s = this.text;
    for (const c of this.children) s += c.textContent;
    return s;
  }
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  return attrs;
}

class DOMParser {
  parseFromString(text) {
    const root = new Element("#document", {});
    const stack = [root];
    const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      const chunk = text.slice(last, m.index);
      if (chunk) stack[stack.length - 1].text += decodeEntities(chunk);
      last = re.lastIndex;
      if (m[5] !== undefined) { stack[stack.length - 1].text += m[5]; continue; } // CDATA
      if (m[2] === undefined) continue;                                           // PI or comment
      if (m[1] === "/") { if (stack.length > 1) stack.pop(); continue; }
      const el = new Element(m[2], parseAttrs(m[3] || ""));
      stack[stack.length - 1].children.push(el);
      if (m[4] !== "/") stack.push(el);
    }
    const tail = text.slice(last);
    if (tail) stack[stack.length - 1].text += decodeEntities(tail);
    return root;
  }
}

module.exports = { DOMParser, Element };
