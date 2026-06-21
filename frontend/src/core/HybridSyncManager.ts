import { Editor } from '@tiptap/react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { htmlToMarkdown, markdownToHtml, splitFrontmatterAndBody } from '../services/markdown.service';
import { updateYTextCleanly } from '../services/diff.service';
import { getPlainTextIndex, getProseMirrorPos } from '../services/cursor.service';

export class HybridSyncManager {
  private ydoc: Y.Doc;
  private wsProvider: WebsocketProvider;
  private editor: Editor;

  private isBridging = false;
  private bridgeTimeout: NodeJS.Timeout | null = null;
  private textToXmlTimeout: NodeJS.Timeout | null = null;

  // Activation flags for incremental milestones
  private enableXmlToText = false;
  private enableTextToXml = false;

  private lastXmlChangeTime: number = 0;
  private lastXmlToTextTime: number = 0;
  private lastTextToXmlTime: number = 0;

  constructor(ydoc: Y.Doc, wsProvider: WebsocketProvider, editor: Editor) {
    this.ydoc = ydoc;
    this.wsProvider = wsProvider;
    this.editor = editor;

    console.log("[HybridSyncManager]: Initialized.");
    this.setupObservers();

    // Trigger initial sync check if WebSocket provider is already synced
    if (this.wsProvider.synced) {
      this.performInitialSyncCheck();
    } else {
      this.wsProvider.once('sync', () => {
        this.performInitialSyncCheck();
      });
    }
  }

  private setupObservers() {
    const yxml = this.ydoc.getXmlFragment('default');
    const ytext = this.ydoc.getText('codemirror');

    // 1. XmlFragment -> Y.Text (Browser to Obsidian)
    yxml.observeDeep((events) => {
      this.lastXmlChangeTime = Date.now();

      if (!this.enableXmlToText) return;
      if (this.isBridging) return;

      // Only bridge if the update was initiated locally by this browser
      const hasLocalUpdate = events.some(event => event.transaction.local);
      const origin = events[0]?.transaction.origin;

      if (!hasLocalUpdate || origin === 'bridge-to-xml') return;

      console.log(`[HybridSyncManager]: XML Change detected. Origin: ${origin}. Throttling translation...`);

      const now = Date.now();
      const timeSinceLast = now - this.lastXmlToTextTime;
      const throttleDelay = 100; // 100ms throttle for fast real-time update

      if (this.bridgeTimeout) clearTimeout(this.bridgeTimeout);

      if (timeSinceLast >= throttleDelay) {
        this.lastXmlToTextTime = now;
        this.bridgeXmlToText();
      } else {
        this.bridgeTimeout = setTimeout(() => {
          this.bridgeTimeout = null;
          this.lastXmlToTextTime = Date.now();
          this.bridgeXmlToText();
        }, throttleDelay - timeSinceLast);
      }
    });

    // 2. Y.Text -> XmlFragment (Obsidian to Browser)
    ytext.observe((event, transaction) => {
      if (!this.enableTextToXml) return;
      if (this.isBridging) return;

      // Skip if local update or from bridge
      if (transaction.local || transaction.origin === 'bridge-to-text') return;

      // If yxml was changed recently (within 1000ms), it means the user is actively typing in the browser.
      // We ignore the update to prevent disrupting the user's active typing session and let browser typing take priority.
      if (Date.now() - this.lastXmlChangeTime < 1000) {
        console.log("[HybridSyncManager]: Ignoring ytext change because browser has active local edits.");
        return;
      }

      console.log(`[HybridSyncManager]: Text Change detected. Origin: ${transaction.origin}. Throttling translation...`);

      const now = Date.now();
      const timeSinceLast = now - this.lastTextToXmlTime;
      // Use a constant 100ms throttle for ultra-responsive updates in all states (focused/unfocused)
      const throttleDelay = 100;

      if (this.textToXmlTimeout) clearTimeout(this.textToXmlTimeout);

      if (timeSinceLast >= throttleDelay) {
        this.lastTextToXmlTime = now;
        this.bridgeTextToXml();
      } else {
        this.textToXmlTimeout = setTimeout(() => {
          this.textToXmlTimeout = null;
          this.lastTextToXmlTime = Date.now();
          this.bridgeTextToXml();
        }, throttleDelay - timeSinceLast);
      }
    });
  }

  private performInitialSyncCheck() {
    const yxml = this.ydoc.getXmlFragment('default');
    const ytext = this.ydoc.getText('codemirror');

    // If native XML is empty but Markdown has text (e.g. created in Obsidian), populate XML
    if (yxml.childLength === 0 && ytext.length > 0) {
      console.log("[HybridSyncManager]: Initial sync check - Populating empty XmlFragment from Y.Text");
      this.isBridging = true;
      try {
        const markdown = ytext.toString();
        const { body } = splitFrontmatterAndBody(markdown);
        const html = markdownToHtml(body);
        this.editor.commands.setContent(html, false);
      } catch (err) {
        console.error("Failed initial sync check:", err);
      } finally {
        this.isBridging = false;
      }
    }
  }

  private bridgeXmlToText() {
    this.isBridging = true;
    try {
      const ytext = this.ydoc.getText('codemirror');
      const html = this.editor.getHTML();
      const markdown = htmlToMarkdown(html);

      // Preserve existing frontmatter from ytext
      const currentYText = ytext.toString();
      const { frontmatter } = splitFrontmatterAndBody(currentYText);
      const fullMarkdown = frontmatter + markdown;

      this.ydoc.transact(() => {
        updateYTextCleanly(ytext, fullMarkdown);
      }, 'bridge-to-text');
      console.log("[HybridSyncManager]: Bridged XmlFragment -> Y.Text (Markdown with preserved frontmatter)");
    } catch (err) {
      console.error("Failed to bridge XmlFragment to Y.Text:", err);
    } finally {
      this.isBridging = false;
    }
  }

  private bridgeTextToXml() {
    this.isBridging = true;
    try {
      const ytext = this.ydoc.getText('codemirror');
      const markdown = ytext.toString();
      const { body } = splitFrontmatterAndBody(markdown);

      // Normalization function to compare content accurately
      const normalize = (str: string) => {
        return str
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\s+/g, ' ') // Collapse all consecutive whitespaces/newlines to a single space
          .trim();
      };

      const currentHtml = this.editor.getHTML();
      const currentMarkdown = htmlToMarkdown(currentHtml);

      if (normalize(currentMarkdown) === normalize(body)) {
        console.log("[HybridSyncManager]: Text and XML are already in sync. Skipping bridge.");
        return;
      }

      const html = markdownToHtml(body);

      if (!this.editor.isFocused) {
        this.editor.commands.setContent(html, false);
        console.log("[HybridSyncManager]: Bridged Y.Text -> XmlFragment (setContent, unfocused)");
      } else {
        console.log("[HybridSyncManager]: Editor has focus. Bridging and restoring cursor position...");
        
        // Save current selection as plain text offsets
        const selection = this.editor.state.selection;
        const plainAnchor = getPlainTextIndex(this.editor.state.doc, selection.anchor);
        const plainHead = getPlainTextIndex(this.editor.state.doc, selection.head);

        // Perform safe merge content set
        this.editor.commands.setContent(html, false);

        // Restore mapped selection positions
        const newAnchor = getProseMirrorPos(this.editor.state.doc, plainAnchor);
        const newHead = getProseMirrorPos(this.editor.state.doc, plainHead);

        this.editor.commands.setTextSelection({ from: newAnchor, to: newHead });
      }
    } catch (err) {
      console.error("Failed to bridge Y.Text to XmlFragment:", err);
    } finally {
      this.isBridging = false;
    }
  }

  setXmlToTextEnabled(enabled: boolean) {
    this.enableXmlToText = enabled;
    if (enabled) {
      console.log("[HybridSyncManager]: Enabled Browser -> Obsidian sync");
      // Trigger initial run if editor has content
      if (this.editor.getHTML()) {
        this.bridgeXmlToText();
      }
    }
  }

  setTextToXmlEnabled(enabled: boolean) {
    this.enableTextToXml = enabled;
    if (enabled) {
      console.log("[HybridSyncManager]: Enabled Obsidian -> Browser sync");
      // Trigger initial check
      this.performInitialSyncCheck();
    }
  }

  destroy() {
    console.log("[HybridSyncManager]: Destroying...");
    if (this.bridgeTimeout) {
      clearTimeout(this.bridgeTimeout);
      this.bridgeTimeout = null;
    }
    if (this.textToXmlTimeout) {
      clearTimeout(this.textToXmlTimeout);
      this.textToXmlTimeout = null;
    }
  }
}
