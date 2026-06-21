import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

describe('Convergence Failure Root Cause Analysis', () => {

  it('1. Minimal ASCII-only Test (10000 edits)', () => {
    const ydoc1 = new Y.Doc();
    const ytext1 = ydoc1.getText('codemirror');
    const ydoc2 = new Y.Doc();
    const ytext2 = ydoc2.getText('codemirror');

    ydoc1.on('update', (update) => Y.applyUpdate(ydoc2, update));
    ydoc2.on('update', (update) => Y.applyUpdate(ydoc1, update));

    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
    for (let i = 0; i < 10000; i++) {
      const isDoc1 = Math.random() > 0.5;
      const doc = isDoc1 ? ytext1 : ytext2;
      const char = chars[Math.floor(Math.random() * chars.length)];
      
      if (Math.random() > 0.3) {
        const pos = Math.floor(Math.random() * (doc.length + 1));
        doc.insert(pos, char);
      } else if (doc.length > 0) {
        const deletePos = Math.floor(Math.random() * doc.length);
        doc.delete(deletePos, 1);
      }
      
      // Check invariant strictly after every step to find exactly when it fails
      if (ytext1.toString() !== ytext2.toString()) {
        throw new Error(`Failed at step ${i}. Doc1: "${ytext1.toString()}", Doc2: "${ytext2.toString()}"`);
      }
    }
  });

  it('2. Emojis without Synchronous ApplyUpdate Loop (Transaction Origin)', () => {
    const ydoc1 = new Y.Doc();
    const ytext1 = ydoc1.getText('codemirror');
    const ydoc2 = new Y.Doc();
    const ytext2 = ydoc2.getText('codemirror');

    ydoc1.on('update', (update, origin) => {
      if (origin !== 'sync') {
        Y.applyUpdate(ydoc2, update, 'sync');
      }
    });
    ydoc2.on('update', (update, origin) => {
      if (origin !== 'sync') {
        Y.applyUpdate(ydoc1, update, 'sync');
      }
    });

    const chars = ['🔥', '😀'];
    for (let i = 0; i < 1000; i++) {
      const isDoc1 = Math.random() > 0.5;
      const doc = isDoc1 ? ytext1 : ytext2;
      const docId = isDoc1 ? ydoc1 : ydoc2;
      const char = chars[Math.floor(Math.random() * chars.length)];
      const str = doc.toString();
      
      docId.transact(() => {
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
      }, 'local');
    }
    expect(ytext1.toString()).toEqual(ytext2.toString());
  });

});
