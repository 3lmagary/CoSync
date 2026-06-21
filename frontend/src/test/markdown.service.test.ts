/**
 * markdown.service.test.ts
 *
 * PR #2 – Markdown Rendering Regression Tests
 *
 * Tests markdownToHtml() and htmlToMarkdown() for:
 *   - Headings (h1–h6)
 *   - Unordered lists (- and *)
 *   - Ordered lists (1. 2. 3.)
 *   - Fenced code blocks (``` with language hint)
 *   - Blockquotes
 *   - Horizontal rules
 *   - Bold / Italic / Inline code (inline markup)
 *   - Round-trip stability: markdown → html → markdown
 */

import { describe, it, expect } from 'vitest';
import { markdownToHtml, htmlToMarkdown, inlineMarkdownToHtml } from '../services/markdown.service';

// ---------------------------------------------------------------------------
// markdownToHtml
// ---------------------------------------------------------------------------

describe('markdownToHtml()', () => {

  // ── Headings ──────────────────────────────────────────────────────────────

  describe('Headings', () => {
    it('renders h1', () => {
      const html = markdownToHtml('# Hello World');
      expect(html).toContain('<h1');
      expect(html).toContain('Hello World');
      expect(html).toContain('</h1>');
    });

    it('renders h2', () => {
      const html = markdownToHtml('## Section Title');
      expect(html).toContain('<h2');
      expect(html).toContain('Section Title');
    });

    it('renders h3', () => {
      const html = markdownToHtml('### Sub-section');
      expect(html).toContain('<h3');
    });

    it('renders h4', () => {
      expect(markdownToHtml('#### Deep')).toContain('<h4');
    });

    it('renders h5', () => {
      expect(markdownToHtml('##### Deeper')).toContain('<h5');
    });

    it('renders h6', () => {
      expect(markdownToHtml('###### Deepest')).toContain('<h6');
    });

    it('does NOT treat # without trailing space as heading', () => {
      const html = markdownToHtml('#NoSpace');
      expect(html).not.toContain('<h1');
    });
  });

  // ── Unordered Lists ───────────────────────────────────────────────────────

  describe('Unordered Lists', () => {
    it('renders a simple - list', () => {
      const md = '- Item 1\n- Item 2\n- Item 3';
      const html = markdownToHtml(md);
      expect(html).toContain('<ul');
      expect(html).toContain('<li');
      expect(html).toContain('Item 1');
      expect(html).toContain('Item 2');
      expect(html).toContain('Item 3');
      expect(html).toContain('</ul>');
    });

    it('renders a * list', () => {
      const html = markdownToHtml('* Alpha\n* Beta');
      expect(html).toContain('<ul');
      expect(html).toContain('Alpha');
      expect(html).toContain('Beta');
    });

    it('renders a + list', () => {
      const html = markdownToHtml('+ One\n+ Two');
      expect(html).toContain('<ul');
      expect(html).toContain('One');
    });
  });

  // ── Ordered Lists ─────────────────────────────────────────────────────────

  describe('Ordered Lists', () => {
    it('renders a numbered list', () => {
      const md = '1. First\n2. Second\n3. Third';
      const html = markdownToHtml(md);
      expect(html).toContain('<ol');
      expect(html).toContain('<li');
      expect(html).toContain('First');
      expect(html).toContain('Second');
      expect(html).toContain('Third');
      expect(html).toContain('</ol>');
    });

    it('produces correct number of <li> elements', () => {
      const html = markdownToHtml('1. A\n2. B\n3. C');
      const count = (html.match(/<li/g) || []).length;
      expect(count).toBe(3);
    });
  });

  // ── Code Blocks ───────────────────────────────────────────────────────────

  describe('Code Blocks', () => {
    it('renders a plain code block', () => {
      const md = '```\nconsole.log("test");\n```';
      const html = markdownToHtml(md);
      expect(html).toContain('<pre>');
      expect(html).toContain('<code');
      expect(html).toContain('console.log');
      expect(html).toContain('</code></pre>');
    });

    it('renders a JS code block with language hint', () => {
      const md = '```js\nconsole.log("hello");\n```';
      const html = markdownToHtml(md);
      expect(html).toContain('class="language-js"');
      expect(html).toContain('console.log');
    });

    it('escapes HTML entities inside code blocks', () => {
      const md = '```\n<div>Hello & World</div>\n```';
      const html = markdownToHtml(md);
      expect(html).toContain('&lt;div&gt;');
      expect(html).toContain('&amp;');
      expect(html).not.toContain('<div>');
    });

    it('does NOT interpret markdown inside code blocks', () => {
      const md = '```\n# Not a heading\n- Not a list\n```';
      const html = markdownToHtml(md);
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('<ul');
    });

    it('code block newlines are preserved as actual newlines (not \\\\n)', () => {
      const md = '```\nline1\nline2\n```';
      const html = markdownToHtml(md);
      // Should NOT contain literal backslash-n
      expect(html).not.toContain('\\n');
    });
  });

  // ── Blockquotes ───────────────────────────────────────────────────────────

  describe('Blockquotes', () => {
    it('renders a blockquote', () => {
      const html = markdownToHtml('> This is a quote');
      expect(html).toContain('<blockquote');
      expect(html).toContain('This is a quote');
      expect(html).toContain('</blockquote>');
    });
  });

  // ── Horizontal Rule ───────────────────────────────────────────────────────

  describe('Horizontal Rule', () => {
    it('renders --- as <hr />', () => {
      const html = markdownToHtml('---');
      expect(html).toContain('<hr');
    });

    it('renders *** as <hr />', () => {
      expect(markdownToHtml('***')).toContain('<hr');
    });
  });

  // ── Inline Markup ─────────────────────────────────────────────────────────

  describe('Inline markup (via inlineMarkdownToHtml)', () => {
    it('bold **text**', () => {
      expect(inlineMarkdownToHtml('**bold**')).toContain('<strong>bold</strong>');
    });

    it('italic *text*', () => {
      expect(inlineMarkdownToHtml('*italic*')).toContain('<em>italic</em>');
    });

    it('inline code `code`', () => {
      expect(inlineMarkdownToHtml('`code`')).toContain('<code>code</code>');
    });
  });

  // ── Mixed document ────────────────────────────────────────────────────────

  describe('Mixed document', () => {
    const sampleMd = `# Heading

- Item 1
- Item 2

1. One
2. Two

\`\`\`js
console.log("test");
\`\`\`
`;

    it('renders all elements without throwing', () => {
      expect(() => markdownToHtml(sampleMd)).not.toThrow();
    });

    it('contains h1, ul, ol, pre in output', () => {
      const html = markdownToHtml(sampleMd);
      expect(html).toContain('<h1');
      expect(html).toContain('<ul');
      expect(html).toContain('<ol');
      expect(html).toContain('<pre>');
    });
  });
});

// ---------------------------------------------------------------------------
// htmlToMarkdown
// ---------------------------------------------------------------------------

describe('htmlToMarkdown()', () => {
  it('converts <h1> to # heading', () => {
    const md = htmlToMarkdown('<h1>Title</h1>');
    expect(md).toContain('# Title');
  });

  it('converts <h2> to ## heading', () => {
    const md = htmlToMarkdown('<h2>Sub</h2>');
    expect(md).toContain('## Sub');
  });

  it('converts <ul><li> to - items', () => {
    const md = htmlToMarkdown('<ul><li>A</li><li>B</li></ul>');
    expect(md).toContain('- A');
    expect(md).toContain('- B');
  });

  it('converts <ol><li> to numbered items', () => {
    const md = htmlToMarkdown('<ol><li>First</li><li>Second</li></ol>');
    expect(md).toContain('1. First');
    expect(md).toContain('2. Second');
  });

  it('converts <pre><code> block to fenced code block', () => {
    const md = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(md).toContain('```');
    expect(md).toContain('const x = 1;');
  });

  it('converts <strong> to **bold**', () => {
    expect(htmlToMarkdown('<strong>bold</strong>')).toContain('**bold**');
  });

  it('converts <em> to *italic*', () => {
    expect(htmlToMarkdown('<em>italic</em>')).toContain('*italic*');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Round-trip stability: markdown → html → markdown
// ---------------------------------------------------------------------------

describe('Round-trip: markdownToHtml → htmlToMarkdown', () => {
  it('heading survives round-trip', () => {
    const original = '# My Heading';
    const roundTrip = htmlToMarkdown(markdownToHtml(original));
    expect(roundTrip).toContain('My Heading');
    expect(roundTrip).toContain('#');
  });

  it('bold text survives round-trip', () => {
    const original = '**bold text**';
    const roundTrip = htmlToMarkdown(markdownToHtml(original));
    expect(roundTrip).toContain('bold text');
  });

  it('list survives round-trip', () => {
    const original = '- Alpha\n- Beta\n- Gamma';
    const roundTrip = htmlToMarkdown(markdownToHtml(original));
    expect(roundTrip).toContain('Alpha');
    expect(roundTrip).toContain('Beta');
  });
});
