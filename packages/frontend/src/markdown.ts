/**
 * A very small Markdown renderer, for the game manuals and nothing else.
 *
 * Hand-rolled rather than pulled in: the frontend depends on `vue` and
 * `@darts/schema` alone, and the manuals only use the handful of constructs
 * below. Everything is HTML-escaped before any tag is emitted, so a manual can
 * never inject markup.
 *
 * Supported: ATX headings, `-`/`*` and ordered lists, GitHub-style tables,
 * fenced code blocks, blockquotes, `---` rules, paragraphs, and inline
 * `code`, **strong** and *emphasis*.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline formatting.
 *
 * Code spans are lifted out first and put back last, so their contents are
 * never read as emphasis -- `**x**` inside backticks stays literal.
 */
function inline(src: string): string {
  const codes: string[] = [];
  let out = escapeHtml(src).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `@@code${codes.length - 1}@@`;
  });

  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

  return out.replace(/@@code(\d+)@@/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
}

/** Split a table row into its cells, dropping the leading and trailing pipes. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*([-*])\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code.
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // the closing fence
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      html.push('<hr />');
      i += 1;
      continue;
    }

    // Table: a pipe row followed by a dash rule.
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        body.push(cells(lines[i]!));
        i += 1;
      }
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const rows = body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    // Lists. An indented continuation line folds into the item above it.
    if (BULLET.test(line) || ORDERED.test(line)) {
      const isOrdered = ORDERED.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = isOrdered ? ORDERED.exec(l) : BULLET.exec(l);
        if (m) {
          items.push(isOrdered ? m[1]! : m[2]!);
          i += 1;
          continue;
        }
        if (l.trim() !== '' && /^\s+/.test(l) && items.length > 0) {
          items[items.length - 1] += ` ${l.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }

    // Paragraph: everything up to the next blank line or block start.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === '' ||
        /^#{1,6}\s/.test(l) ||
        /^\s*```/.test(l) ||
        /^\s*(---+|\*\*\*+)\s*$/.test(l) ||
        /^\s*>\s?/.test(l) ||
        BULLET.test(l) ||
        ORDERED.test(l)
      ) {
        break;
      }
      para.push(l.trim());
      i += 1;
    }
    if (para.length > 0) html.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return html.join('\n');
}
