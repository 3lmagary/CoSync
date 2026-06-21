import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { diff_match_patch } from 'diff-match-patch';

// Re-implement updateYTextCleanly logic for testing
const dmp = new diff_match_patch();
function updateYTextCleanly(ytext: Y.Text, newText: string) {
  const oldText = ytext.toString();
  if (oldText === newText) return;

  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  let cursor = 0;
  for (const [op, text] of diffs) {
    if (op === 0) {
      cursor += text.length;
    } else if (op === -1) {
      ytext.delete(cursor, text.length);
    } else if (op === 1) {
      ytext.insert(cursor, text);
      cursor += text.length;
    }
  }
}

describe('Unicode, Arabic & Emoji Sync Safety', () => {
  it('Should handle Arabic text correctly', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('test');
    
    ytext.insert(0, 'مرحبا بك');
    updateYTextCleanly(ytext, 'مرحبا بك في كورسينك');
    
    expect(ytext.toString()).toBe('مرحبا بك في كورسينك');
  });

  it('Should handle Emoji surrogate pairs correctly (CRITICAL TEST)', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('test');
    
    // 🔥 is a surrogate pair (length 2 in JS)
    ytext.insert(0, 'Hello 🔥 World');
    
    // Simulate user deleting the space after the emoji
    updateYTextCleanly(ytext, 'Hello 🔥World');
    
    expect(ytext.toString()).toBe('Hello 🔥World');
  });

  it('Should handle mixed LTR/RTL with Emojis', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('test');
    
    ytext.insert(0, 'Start👨‍👩‍👧‍👦نهاية');
    updateYTextCleanly(ytext, 'Start👨‍👩‍👧‍👦نصفنهاية');
    
    expect(ytext.toString()).toBe('Start👨‍👩‍👧‍👦نصفنهاية');
  });
});
