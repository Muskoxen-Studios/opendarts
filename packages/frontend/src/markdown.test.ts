import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
  it('renders headings at their level', () => {
    expect(renderMarkdown('# Killer')).toBe('<h1>Killer</h1>');
    expect(renderMarkdown('### Friendly fire')).toBe('<h3>Friendly fire</h3>');
  });

  it('joins the wrapped lines of a paragraph', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one two</p>\n<p>three</p>');
  });

  it('renders strong, emphasis and code inline', () => {
    expect(renderMarkdown('a **b** c *d* e `f`')).toBe(
      '<p>a <strong>b</strong> c <em>d</em> e <code>f</code></p>',
    );
  });

  it('leaves markup inside a code span literal', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  it('escapes HTML rather than passing it through', () => {
    // The manuals are ours, but v-html means a slip would be an injection.
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    );
    expect(renderMarkdown('```\n<b>x</b>\n```')).toBe('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  });

  it('renders bullet and ordered lists, folding continuation lines', () => {
    expect(renderMarkdown('- one\n  still one\n- two')).toBe(
      '<ul><li>one still one</li><li>two</li></ul>',
    );
    expect(renderMarkdown('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders a table with its header row', () => {
    expect(renderMarkdown('| Rule | Meaning |\n|---|---|\n| Double | only a double |')).toBe(
      '<table><thead><tr><th>Rule</th><th>Meaning</th></tr></thead>' +
        '<tbody><tr><td>Double</td><td>only a double</td></tr></tbody></table>',
    );
  });

  it('renders blockquotes and rules', () => {
    expect(renderMarkdown('> mind the bull')).toBe('<blockquote>mind the bull</blockquote>');
    expect(renderMarkdown('a\n\n---\n\nb')).toBe('<p>a</p>\n<hr />\n<p>b</p>');
  });

  it('renders nothing for empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('\n  \n')).toBe('');
  });
});
