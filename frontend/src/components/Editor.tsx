import React, { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';

import {
  Bold, Italic, Code, Strikethrough, List, ListOrdered, Heading1, Heading2,
  Undo, Redo, Users, ChevronLeft, Save, AlertTriangle, Quote, Terminal, Minus,
  Share2, Copy, Check, Menu
} from 'lucide-react';
import { getPlainTextIndex, getProseMirrorPos } from '../services/cursor.service';
import { updateYTextCleanly } from '../services/diff.service';
import { htmlToMarkdown, markdownToHtml, splitFrontmatterAndBody } from '../services/markdown.service';
import { useYjsSync } from '../hooks/useYjsSync';
import { useAwareness } from '../hooks/useAwareness';
import { HybridSyncManager } from '../core/HybridSyncManager';

interface EditorProps {
  token: string;
  workspaceId: string;
  documentId: string;
  docTitle: string;
  backendUrl: string;
  onBack: () => void;
  user: { id: string; username: string; color: string };
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
}

function getAbsolutePosition(relativePos: any, ydoc: Y.Doc): Y.AbsolutePosition | null {
  if (!relativePos) return null;
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(relativePos, ydoc);
    if (abs) return abs;
  } catch (e) {
    // Ignore error, try JSON parsing
  }
  try {
    const rel = Y.createRelativePositionFromJSON(relativePos);
    return Y.createAbsolutePositionFromRelativePosition(rel, ydoc);
  } catch (e) {
    return null;
  }
}

const ObsidianCursorExtension = Extension.create({
  name: 'obsidianCursor',

  addOptions() {
    return {
      wsProvider: null,
      ydoc: null,
    };
  },

  addProseMirrorPlugins() {
    const { wsProvider, ydoc } = this.options;
    if (!wsProvider || !ydoc) return [];

    return [
      new Plugin({
        key: new PluginKey('obsidianCursor'),
        state: {
          init() {
            return { version: 0 };
          },
          apply(_tr, value) {
            return { version: value.version + 1 };
          }
        },
        props: {
          decorations(state) {
            if ((window as any).disableAwareness) {
              return DecorationSet.create(state.doc, []);
            }
            const decorations: any[] = [];
            const states = wsProvider.awareness.getStates();
            const ytext = ydoc.getText('codemirror');

            try {
              states.forEach((clientState: any, clientId: number) => {
                if (clientId === wsProvider.awareness.doc.clientID) return;
                
                // Only draw custom cursor decoration for Obsidian clients!
                if (clientState.user?.userId !== 'obsidian-client') return;

                const cursor = clientState.cursor;
                if (cursor && cursor.head) {
                  const headPos = getAbsolutePosition(cursor.head, ydoc);
                  if (headPos && headPos.type === ytext) {
                    const plainIndex = headPos.index;
                    const fullMarkdown = ytext.toString();
                    const { frontmatter } = splitFrontmatterAndBody(fullMarkdown);
                    const frontmatterLen = frontmatter.length;
                    const bodyIndex = plainIndex - frontmatterLen;

                    if (bodyIndex >= 0) {
                      const pmPos = getProseMirrorPos(state.doc, bodyIndex);
                      if (pmPos > 0 && pmPos <= state.doc.content.size) {
                      const { color = '#10b981', name = 'Obsidian User' } = clientState.user || {};
                      
                      const cursorEl = document.createElement('span');
                      cursorEl.className = 'remote-cursor';
                      cursorEl.style.color = color;

                      const labelEl = document.createElement('span');
                      labelEl.innerText = name;
                      labelEl.style.position = 'absolute';
                      labelEl.style.top = '-1.4em';
                      labelEl.style.left = '0';
                      labelEl.style.background = color;
                      labelEl.style.color = '#fff';
                      labelEl.style.fontSize = '10px';
                      labelEl.style.padding = '2px 6px';
                      labelEl.style.borderRadius = '4px';
                      labelEl.style.whiteSpace = 'nowrap';
                      labelEl.style.pointerEvents = 'none';
                      labelEl.style.zIndex = '100';
                      labelEl.style.fontWeight = '700';
                      labelEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
                      
                      cursorEl.appendChild(labelEl);

                      decorations.push(Decoration.widget(pmPos, cursorEl, { side: -1 }));
                    }
                    }
                  }
                }
              });
            } catch (err) {
              console.warn('Error rendering Obsidian remote cursors:', err);
            }

            return DecorationSet.create(state.doc, decorations);
          }
        }
      })
    ];
  }
});

export const Editor: React.FC<EditorProps> = ({
  token,
  workspaceId,
  documentId,
  docTitle,
  backendUrl,
  onBack,
  user,
  onToggleSidebar,
  isSidebarOpen
}) => {
  const { ydoc, wsProvider, localSynced, docSize } = useYjsSync({ documentId, workspaceId, token, backendUrl });
  const { connectionStatus, onlineUsers } = useAwareness(wsProvider, user);
  const maxDocSize = 5 * 1024 * 1024; // 5MB

  // Sharing states
  const [showShareModal, setShowShareModal] = useState(false);
  const [inviteToken, setInviteToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [sharingError, setSharingError] = useState('');

  // 2. Setup TipTap Editor configuration
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: false, // Collaborative extension handles history natively
        paragraph: {
          HTMLAttributes: {
            dir: 'auto',
          },
        },
        heading: {
          HTMLAttributes: {
            dir: 'auto',
          },
        },
        blockquote: {
          HTMLAttributes: {
            dir: 'auto',
          },
        },
        listItem: {
          HTMLAttributes: {
            dir: 'auto',
          },
        },
      }),

      Collaboration.configure({
        document: ydoc,
      }),

      CollaborationCursor.configure({
        provider: wsProvider,
        user: {
          name: user.username,
          color: user.color,
        },
      }),

      ObsidianCursorExtension.configure({
        wsProvider,
        ydoc,
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap',
      },
    },
  });

  // Trigger editor view dispatch on Yjs awareness updates to redraw remote cursors
  useEffect(() => {
    if (!editor || !wsProvider) return;
    let throttleTimeout: NodeJS.Timeout | null = null;
    let lastObsidianCursorsStr = '';
    const handleAwarenessChange = () => {
      // Find all obsidian clients and serialize their cursor state
      const states = wsProvider.awareness.getStates();
      let currentCursorsStr = '';
      states.forEach((clientState: any, clientId: number) => {
        if (clientState.user?.userId === 'obsidian-client') {
          const cursor = clientState.cursor;
          if (cursor) {
            currentCursorsStr += `${clientId}:${JSON.stringify(cursor.head)}|`;
          }
        }
      });

      if (currentCursorsStr === lastObsidianCursorsStr) {
        // No change in Obsidian cursors!
        return;
      }
      lastObsidianCursorsStr = currentCursorsStr;

      if (throttleTimeout) return;
      throttleTimeout = setTimeout(() => {
        throttleTimeout = null;
        console.log("Awareness Received - Throttled Redraw");
        if (!editor.isDestroyed) {
          try {
            editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
          } catch (e) {
            // Ignore state mismatch errors during tab switches
          }
        }
      }, 100);
    };
    wsProvider.awareness.on('change', handleAwarenessChange);
    return () => {
      wsProvider.awareness.off('change', handleAwarenessChange);
      if (throttleTimeout) clearTimeout(throttleTimeout);
    };
  }, [editor, wsProvider]);

  // Print document info
  useEffect(() => {
    console.log("documentId:", documentId);
    console.log("workspaceId:", workspaceId);
    console.log("roomName:", `/workspace/${workspaceId}/doc/${documentId}`);
  }, [documentId, workspaceId]);

  // Log local and remote updates for diagnostics
  useEffect(() => {
    if (!ydoc || !wsProvider) return;
    const handleUpdate = (_update: Uint8Array, origin: any) => {
      if (origin === wsProvider) {
        console.log("Yjs Update Received");
      } else {
        console.log("Yjs Update Sent");
      }
    };
    ydoc.on('update', handleUpdate);
    return () => {
      ydoc.off('update', handleUpdate);
    };
  }, [ydoc, wsProvider]);

  // Log websocket connection and sync protocol states
  useEffect(() => {
    if (!wsProvider) return;
    
    const handleStatus = ({ status }: { status: string }) => {
      if (status === 'connected') {
        console.log("WebSocket Connected");
        console.log("Room Joined");
        console.log("Sync Step 1");
      }
    };

    const handleSync = (isSynced: boolean) => {
      if (isSynced) {
        console.log("Sync Step 2");
      }
    };

    wsProvider.on('status', handleStatus);
    wsProvider.on('sync', handleSync);

    return () => {
      wsProvider.off('status', handleStatus);
      wsProvider.off('sync', handleSync);
    };
  }, [wsProvider]);

  // 3. Initialize HybridSyncManager for Obsidian integration bridge
  useEffect(() => {
    if (!editor || !ydoc || !wsProvider || !localSynced) return;

    const syncManager = new HybridSyncManager(ydoc, wsProvider, editor);

    // Enable both directions of the bridge
    syncManager.setXmlToTextEnabled(true);
    syncManager.setTextToXmlEnabled(true);

    return () => {
      syncManager.destroy();
    };
  }, [editor, ydoc, wsProvider, localSynced]);

  const handleShareDoc = async () => {
    try {
      setSharingError('');
      const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/invite-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to generate invite token');
      const data = await res.json();
      setInviteToken(data.token);
      setShowShareModal(true);
    } catch (err: any) {
      setSharingError(err.message);
    }
  };

  if (!editor) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '1.5rem', gap: '1.25rem', width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
      
      {/* Editor Header Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {!isSidebarOpen && onToggleSidebar && (
            <button onClick={onToggleSidebar} className="btn-secondary" style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Show Sidebar">
              <Menu size={20} />
            </button>
          )}
          <button onClick={onBack} className="btn-secondary" style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ChevronLeft size={20} />
          </button>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800 }}>{docTitle}</h2>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', alignItems: 'center' }}>
              <span className={`status-badge ${connectionStatus}`}>
                <span className="pulse-dot"></span>
                <span>{connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting' : 'Disconnected'}</span>
              </span>
              <span className="status-badge" style={{ color: '#9ca3af', gap: '0.25rem' }}>
                <Save size={14} />
                <span>{localSynced ? 'Offline Saved' : 'Caching...'}</span>
              </span>
              {docSize > maxDocSize * 0.8 && (
                <span className="status-badge" style={{ color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)', gap: '0.25rem' }}>
                  <AlertTriangle size={14} />
                  <span>Size Warning: {(docSize / 1024 / 1024).toFixed(2)}MB</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Online Presence & Share list in Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {/* Share Document Button */}
          <button
            onClick={handleShareDoc}
            className="btn-primary"
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            <Share2 size={15} />
            <span>Share Link</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-color)', fontSize: '0.9rem', background: 'var(--item-bg)', padding: '0.4rem 0.8rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            <Users size={16} style={{ color: 'var(--text-muted)' }} />
            <span style={{ fontWeight: 600 }}>{onlineUsers.length} online</span>
          </div>
          
          <div style={{ display: 'flex', gap: '-4px' }}>
            {onlineUsers.map((u, idx) => (
              <div
                key={u.clientId}
                title={u.username}
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  backgroundColor: u.color,
                  border: '2px solid var(--bg-color)',
                  marginLeft: idx === 0 ? 0 : '-8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  fontWeight: 800,
                  color: '#fff',
                  textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                  cursor: 'default',
                  zIndex: 10 - idx
                }}
              >
                {u.username.substring(0, 1).toUpperCase()}
              </div>
            ))}
          </div>
        </div>
      </div>

      {sharingError && (
        <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#fca5a5', borderRadius: '8px', fontSize: '0.8rem' }}>
          {sharingError}
        </div>
      )}

      {/* Tiptap Collaborative Editor Box */}
      <div className="editor-wrapper">
        
        {/* Editor text formatting toolbar */}
        <div className="editor-toolbar">
          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={`toolbar-btn ${editor.isActive('bold') ? 'is-active' : ''}`}
            title="Bold"
          >
            <Bold size={18} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={`toolbar-btn ${editor.isActive('italic') ? 'is-active' : ''}`}
            title="Italic"
          >
            <Italic size={18} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleStrike().run()}
            className={`toolbar-btn ${editor.isActive('strike') ? 'is-active' : ''}`}
            title="Strikethrough"
          >
            <Strikethrough size={18} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleCode().run()}
            className={`toolbar-btn ${editor.isActive('code') ? 'is-active' : ''}`}
            title="Inline Code"
          >
            <Code size={18} />
          </button>

          <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: 'auto 0.5rem' }}></div>

          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            className={`toolbar-btn ${editor.isActive('heading', { level: 1 }) ? 'is-active' : ''}`}
            title="Heading 1"
          >
            <Heading1 size={18} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            className={`toolbar-btn ${editor.isActive('heading', { level: 2 }) ? 'is-active' : ''}`}
            title="Heading 2"
          >
            <Heading2 size={18} />
          </button>

          <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: 'auto 0.5rem' }}></div>

          <button
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            className={`toolbar-btn ${editor.isActive('bulletList') ? 'is-active' : ''}`}
            title="Bullet List"
          >
            <List size={18} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            className={`toolbar-btn ${editor.isActive('orderedList') ? 'is-active' : ''}`}
            title="Ordered List"
          >
            <ListOrdered size={18} />
          </button>

          <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: 'auto 0.5rem' }}></div>

          {/* New formatting tools */}
          <button
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            className={`toolbar-btn ${editor.isActive('blockquote') ? 'is-active' : ''}`}
            title="Blockquote"
          >
            <Quote size={18} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            className={`toolbar-btn ${editor.isActive('codeBlock') ? 'is-active' : ''}`}
            title="Code Block"
          >
            <Terminal size={18} />
          </button>
          <button
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
            className="toolbar-btn"
            title="Divider"
          >
            <Minus size={18} />
          </button>

          <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: 'auto 0.5rem' }}></div>

          <button
            onClick={() => editor.chain().focus().undo().run()}
            className="toolbar-btn"
            title="Undo"
          >
            <Undo size={18} />
          </button>
          <button
            onClick={() => editor.chain().focus().redo().run()}
            className="toolbar-btn"
            title="Redo"
          >
            <Redo size={18} />
          </button>
        </div>

        {/* Main Editable Content area */}
        <EditorContent editor={editor} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: 'var(--editor-bg)' }} />
      </div>

      {/* Share Document Link Modal Dialog */}
      {showShareModal && (
        <div className="share-modal-overlay" onClick={() => setShowShareModal(false)}>
          <div className="share-modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>Share Document</h3>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              Anyone with this link will join this workspace and directly open this document: <strong>{docTitle}</strong>.
            </p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)' }}>Document Share Link</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input 
                  type="text" 
                  readOnly 
                  value={`${window.location.origin}/?invite=${inviteToken}&docId=${documentId}`}
                  className="input-field"
                  style={{ flex: 1, fontSize: '0.85rem', padding: '0.5rem 0.75rem' }}
                />
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/?invite=${inviteToken}&docId=${documentId}`);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="btn-primary"
                  style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button onClick={() => setShowShareModal(false)} className="btn-secondary" style={{ padding: '0.5rem 1.25rem' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Editor;
