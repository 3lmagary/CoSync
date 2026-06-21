// Maps a ProseMirror document position to a plain text character index (for Yjs relative selection)
export function getPlainTextIndex(doc: any, pmPos: number): number {
  let currentIndex = 0;
  let found = false;

  doc.descendants((node: any, pos: number) => {
    if (found) return false;

    if (pos >= pmPos) {
      found = true;
      return false;
    }

    if (node.isText) {
      const length = node.text.length;
      if (pmPos >= pos && pmPos <= pos + length) {
        currentIndex += (pmPos - pos);
        found = true;
        return false;
      }
      currentIndex += length;
    } else if (node.isBlock) {
      if (pos > 0) {
        currentIndex += 1; // Map block break to a newline
      }
    }
    return true;
  });

  return currentIndex;
}

// Maps a plain text character index (from Obsidian) to a ProseMirror document position
export function getProseMirrorPos(doc: any, plainTextIndex: number): number {
  let currentIndex = 0;
  // Fallback to the end of the document content instead of the beginning (stuck on side)
  let targetPos = doc.content.size > 2 ? doc.content.size - 1 : 1;

  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const length = node.text.length;
      if (plainTextIndex >= currentIndex && plainTextIndex <= currentIndex + length) {
        targetPos = pos + (plainTextIndex - currentIndex);
        return false; // Found, stop search
      }
      currentIndex += length;
    } else if (node.isBlock) {
      // Paragraphs and headings in ProseMirror have open/close tokens that take up 1 position each.
      // In plain text, they are represented by newlines.
      if (pos > 0) {
        currentIndex += 1; // Map block break to a newline character
      }
      if (plainTextIndex <= currentIndex) {
        targetPos = pos + 1;
        return false;
      }
    }
    return true;
  });

  return targetPos;
}
