import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

// Re-implement or mock the bridge functions to test invariants
function simulateTipTapToYjs(tipTapHtml: string, ytext: Y.Text) {
  // Simplified for invariant testing
  // In real life, it goes TipTap -> htmlToMarkdown -> updateYTextCleanly -> Y.Text
  const markdown = tipTapHtml.replace('<p>', '').replace('</p>', '');
  
  if (ytext.toString() !== markdown) {
    ytext.delete(0, ytext.length);
    ytext.insert(0, markdown);
  }
}

describe('Sync Invariant CI Tests', () => {
  it('Should maintain invariant after 1000 random edits', () => {
    const ydoc1 = new Y.Doc();
    const ytext1 = ydoc1.getText('codemirror');
    
    const ydoc2 = new Y.Doc();
    const ytext2 = ydoc2.getText('codemirror');

    // Link them together like a perfect websocket
    ydoc1.on('update', (update) => Y.applyUpdate(ydoc2, update));
    ydoc2.on('update', (update) => Y.applyUpdate(ydoc1, update));

    // Fuzz testing 10000 edits
    const chars = [
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '.split(''),
      '🔥', '😀', ...'العربية'.split('')
    ];
    for (let i = 0; i < 10000; i++) {
      const isDoc1 = Math.random() > 0.5;
      const doc = isDoc1 ? ytext1 : ytext2;
      const char = chars[Math.floor(Math.random() * chars.length)];
      const str = doc.toString();
      
      let pos = Math.floor(Math.random() * (doc.length + 1));
      if (pos > 0 && pos < str.length) {
        const prevCode = str.charCodeAt(pos - 1);
        const currCode = str.charCodeAt(pos);
        if (prevCode >= 0xD800 && prevCode <= 0xDBFF && currCode >= 0xDC00 && currCode <= 0xDFFF) {
          pos = Math.random() > 0.5 ? pos - 1 : pos + 1;
        }
      }
      
      if (Math.random() > 0.3) {
        doc.insert(pos, char);
      } else if (doc.length > 0) {
        let deletePos = Math.floor(Math.random() * doc.length);
        let deleteLen = 1;
        const code = str.charCodeAt(deletePos);
        if (code >= 0xDC00 && code <= 0xDFFF && deletePos > 0) {
          deletePos--;
          deleteLen = 2;
        } else if (code >= 0xD800 && code <= 0xDBFF && deletePos < str.length - 1) {
          deleteLen = 2;
        }
        doc.delete(deletePos, deleteLen);
      }
    }

    // The Invariant Rule:
    expect(ytext1.toString()).toEqual(ytext2.toString());
  });
});
