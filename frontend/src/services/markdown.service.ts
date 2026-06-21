export function normalizeMarkdown(md: string): string {
  if (!md) return '';
  return md
    .replace(/\s+/g, ' ')
    .trim();
}

// Splits content into YAML frontmatter and body markdown
export function splitFrontmatterAndBody(content: string): { frontmatter: string; body: string } {
  const cleanContent = content.replace(/^\uFEFF/, '');
  
  // 1. Try to find any cosyncId in the document
  const looseIdRegex = /cosyncId:\s*([a-zA-Z0-9-]+)/;
  const idMatch = cleanContent.match(looseIdRegex);
  const cosyncId = idMatch ? idMatch[1].trim() : null;
  
  // 2. Only match frontmatter blocks that contain "cosyncId:"
  const frontmatterRegex = /---\r?\n([\s\S]*?cosyncId:[\s\S]*?)\r?\n---(?:\r?\n|$)/g;
  
  let body = cleanContent;
  let otherFrontmatterLines: string[] = [];
  
  body = body.replace(frontmatterRegex, (_block, innerContent) => {
    const lines = innerContent.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('cosyncId:')) {
        otherFrontmatterLines.push(line);
      }
    }
    return '\n'; // Keep a newline
  });
  
  // Also strip any remaining loose cosyncId lines
  body = body.replace(/cosyncId:\s*[^\r\n]+/g, '');
  
  // Clean up body by removing only the leading newlines left behind by frontmatter
  body = body.replace(/^\s+/, '');
  
  // Reconstruct frontmatter at the very top
  let frontmatter = '';
  if (cosyncId) {
    frontmatter = `---\ncosyncId: ${cosyncId}\n`;
    if (otherFrontmatterLines.length > 0) {
      const uniqueLines = Array.from(new Set(otherFrontmatterLines));
      frontmatter += uniqueLines.join('\n') + '\n';
    }
    frontmatter += '---\n';
  }
  
  return { frontmatter, body };
}

export function inlineMarkdownToHtml(text: string): string {
  let temp = text;
  // Bold, Italic & Code replacements
  temp = temp.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  temp = temp.replace(/\*([\s\S]+?)\*/g, '<em>$1</em>');
  temp = temp.replace(/`([\s\S]+?)`/g, '<code>$1</code>');
  return temp;
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  
  let temp = html;
  
  // Replace code blocks
  temp = temp.replace(/<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi, (_, lang, content) => {
    const language = lang ? lang.trim() : '';
    const unescaped = content
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    return `\n\`\`\`${language}\n${unescaped.trim()}\n\`\`\`\n\n`;
  });

  // Replace horizontal rules
  temp = temp.replace(/<hr[^>]*>/gi, '\n---\n\n');
  
  // Replace headings
  temp = temp.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
  temp = temp.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
  temp = temp.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
  temp = temp.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n');
  temp = temp.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '##### $1\n\n');
  temp = temp.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '###### $1\n\n');
  
  // Replace blockquotes
  temp = temp.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n');
  
  // Replace lists
  temp = temp.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, p1) => {
    return p1.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n') + '\n';
  });
  temp = temp.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, p1) => {
    let index = 1;
    return p1.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_li: string, content: string) => `${index++}. ${content}\n`) + '\n';
  });
  
  // Replace bold, italic, code
  temp = temp.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  temp = temp.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  temp = temp.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  temp = temp.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  temp = temp.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  
  // Replace paragraphs and line breaks
  temp = temp.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  temp = temp.replace(/<br\s*\/?>/gi, '\n');
  
  // Strip any remaining HTML tags
  temp = temp.replace(/<[^>]+>/g, '');
  
  // Clean up extra spaces
  temp = temp.replace(/\n{3,}/g, '\n\n');
  
  return temp.trim();
}

export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';
  
  let html = '';
  const lines = markdown.split('\n');
  
  let inList = false;
  let listType = ''; // 'ul' or 'ol'
  let inBlockquote = false;
  let inCodeBlock = false;
  
  const closeList = () => {
    if (inList) {
      html += listType === 'ul' ? '</ul>' : '</ol>';
      inList = false;
    }
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html += '</blockquote>';
      inBlockquote = false;
    }
  };

  const closeCodeBlock = () => {
    if (inCodeBlock) {
      html += '</code></pre>';
      inCodeBlock = false;
    }
  };
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();
    
    // Check code blocks
    if (trimmed.startsWith('```')) {
      closeList();
      closeBlockquote();
      if (inCodeBlock) {
        closeCodeBlock();
      } else {
        const lang = trimmed.substring(3).trim();
        html += `<pre><code${lang ? ` class="language-${lang}"` : ''}>`;
        inCodeBlock = true;
      }
      continue;
    }
    
    if (inCodeBlock) {
      // Escape HTML entities inside code blocks
      const escapedLine = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      html += escapedLine + '\n';
      continue;
    }

    // Empty line: close lists and blockquotes
    if (!trimmed) {
      closeList();
      closeBlockquote();
      continue;
    }
    
    // Check for horizontal rule
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      closeList();
      closeBlockquote();
      html += '<hr />';
      continue;
    }
    
    // Check for headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      closeBlockquote();
      const level = headingMatch[1].length;
      let content = headingMatch[2];
      content = inlineMarkdownToHtml(content);
      html += `<h${level} dir="auto">${content}</h${level}>`;
      continue;
    }
    
    // Check for blockquotes
    if (line.startsWith('> ')) {
      closeList();
      if (!inBlockquote) {
        html += '<blockquote dir="auto">';
        inBlockquote = true;
      }
      let content = line.substring(2);
      content = inlineMarkdownToHtml(content);
      html += `<p dir="auto">${content}</p>`;
      continue;
    } else {
      closeBlockquote();
    }
    
    // Check for unordered list
    const ulMatch = line.match(/^[-*+]\s+(.*)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        closeList();
        html += '<ul dir="auto">';
        inList = true;
        listType = 'ul';
      }
      let content = ulMatch[1];
      content = inlineMarkdownToHtml(content);
      html += `<li dir="auto">${content}</li>`;
      continue;
    }
    
    // Check for ordered list
    const olMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeList();
        html += '<ol dir="auto">';
        inList = true;
        listType = 'ol';
      }
      let content = olMatch[2];
      content = inlineMarkdownToHtml(content);
      html += `<li dir="auto">${content}</li>`;
      continue;
    }
    
    // Normal paragraph
    closeList();
    let content = inlineMarkdownToHtml(line);
    html += `<p dir="auto">${content}</p>`;
  }
  
  closeList();
  closeBlockquote();
  closeCodeBlock();
  
  return html;
}
