/**
 * md.js — Rendu Markdown minimal et sûr (le texte est échappé avant mise en forme).
 * Titres, paragraphes, listes (imbriquées), citations, gras, italique, code, horodatages cliquables.
 */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  // Horodatages (12:34 ou 1:02:03) → liens vers le lecteur.
  t = t.replace(/(?<![\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/g, '<button class="link-t" data-t="$1">$1</button>');
  return t;
}

export function markdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  const stack = [];   // listes ouvertes : { type, indent }
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeLists = (indent = -1) => {
    while (stack.length && stack[stack.length - 1].indent > indent) out.push(`</li></${stack.pop().type}>`);
  };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim()) { flushPara(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)/);
    const bq = line.match(/^>\s?(.*)/);
    if (h) {
      flushPara(); closeLists();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (li) {
      flushPara();
      const indent = li[1].length;
      const type = /\d/.test(li[2]) ? 'ol' : 'ul';
      const top = stack[stack.length - 1];
      if (!top || indent > top.indent) {
        out.push(`<${type}><li>`);
        stack.push({ type, indent });
      } else {
        closeLists(indent);
        const cur = stack[stack.length - 1];
        if (cur && cur.indent === indent) out.push('</li><li>');
        else { out.push(`<${type}><li>`); stack.push({ type, indent }); }
      }
      out.push(inline(li[3]));
    } else if (bq) {
      flushPara(); closeLists();
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
    } else {
      if (stack.length && /^\s{2,}/.test(line)) { out.push(' ' + inline(line.trim())); continue; }
      closeLists();
      para.push(line.trim());
    }
  }
  flushPara(); closeLists();
  return out.join('');
}

/** Surligne les occurrences d'une requête dans un HTML déjà échappé (texte simple uniquement). */
export function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}
