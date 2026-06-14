import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  Bold, Italic, Code, Strikethrough, List, ListOrdered, Heading1, Heading2,
  Undo, Redo, Users, ChevronLeft, Save, AlertTriangle, Quote, Terminal, Minus,
  Share2, Copy, Check, Menu
} from 'lucide-react';

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

                      const labelEl = document.createElement('div');
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
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [onlineUsers, setOnlineUsers] = useState<any[]>([]);
  const [localSynced, setLocalSynced] = useState(false);
  const [docSize, setDocSize] = useState<number>(0);
  const maxDocSize = 5 * 1024 * 1024; // 5MB

  // Sharing states
  const [showShareModal, setShowShareModal] = useState(false);
  const [inviteToken, setInviteToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [sharingError, setSharingError] = useState('');

  // 1. Setup persistent Yjs structures
  const prevCollabRef = useRef<any>(null);

  const { ydoc, wsProvider, indexeddbProvider } = useMemo(() => {
    // Clean up previous Yjs instances if they exist
    if (prevCollabRef.current) {
      console.log('Cleaning up previous Yjs instances...');
      const { ydoc: pDoc, wsProvider: pWs, indexeddbProvider: pIdb } = prevCollabRef.current;
      try {
        pIdb.destroy();
        pWs.disconnect();
        pWs.destroy();
        pDoc.destroy();
      } catch (err) {
        console.error('Error destroying previous Yjs instances', err);
      }
    }

    const ydoc = new Y.Doc();
    
    // Convert http/https backend URL to ws/wss
    const wsUrl = backendUrl.replace(/^http/, 'ws');
    const roomName = `/workspace/${workspaceId}/doc/${documentId}`;

    // Initialize Local Persistence via IndexedDB
    const indexeddbProvider = new IndexeddbPersistence(documentId, ydoc);

    // Initialize Collaborative WebSocket Provider with subprotocol auth
    const wsProvider = new WebsocketProvider(wsUrl, roomName, ydoc, {
      connect: false, // Don't connect immediately, wait for local IndexedDB load
      protocols: ['co-sync-auth', token]
    });

    // Custom Exponential Reconnection backoff parameters
    wsProvider.maxBackoffTime = 30000;

    prevCollabRef.current = { ydoc, wsProvider, indexeddbProvider };

    return { ydoc, wsProvider, indexeddbProvider };
  }, [documentId, workspaceId, token, backendUrl]);

  // Handle local DB synchronization and WS connection triggers
  useEffect(() => {
    const handleSynced = () => {
      console.log('Local IndexedDB state loaded and synced.');
      setLocalSynced(true);
      
      // Connect to WS server only AFTER local DB is loaded to prevent overwrite states
      wsProvider.connect();

      // Register this client ID as a browser client
      const browserClients = ydoc.getArray('browser-clients');
      if (!browserClients.toArray().includes(ydoc.clientID)) {
        browserClients.push([ydoc.clientID]);
      }
    };

    if (indexeddbProvider.synced) {
      handleSynced();
    } else {
      indexeddbProvider.on('synced', handleSynced);
    }

    return () => {
      indexeddbProvider.off('synced', handleSynced);
      wsProvider.disconnect();
    };
  }, [wsProvider, indexeddbProvider, ydoc]);

  // Monitor connection statuses and awareness presence lists
  useEffect(() => {
    const handleStatus = ({ status }: { status: any }) => {
      setConnectionStatus(status);
    };

    wsProvider.on('status', handleStatus);

    // Bind awareness updates
    const handleAwareness = () => {
      const states = wsProvider.awareness.getStates();
      const usersList: any[] = [];
      states.forEach((state: any, clientId: number) => {
        if (state.user) {
          usersList.push({
            clientId,
            username: state.user.name,
            color: state.user.color,
          });
        }
      });
      setOnlineUsers(usersList);
    };

    wsProvider.awareness.on('change', handleAwareness);

    // Setup local user metadata in awareness state
    wsProvider.awareness.setLocalStateField('user', {
      name: user.username,
      color: user.color,
      userId: user.id
    });

    return () => {
      wsProvider.off('status', handleStatus);
      wsProvider.awareness.off('change', handleAwareness);
    };
  }, [wsProvider, user]);

  // Calculate doc size periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const stateUpdate = Y.encodeStateAsUpdate(ydoc);
      setDocSize(stateUpdate.byteLength);
    }, 5000);

    return () => clearInterval(interval);
  }, [ydoc]);

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
    const handleAwarenessChange = () => {
      if (!editor.isDestroyed) {
        try {
          editor.view.dispatch(editor.state.tr);
        } catch (e) {
          // Ignore state mismatch errors during tab switches
        }
      }
    };
    wsProvider.awareness.on('change', handleAwarenessChange);
    return () => {
      wsProvider.awareness.off('change', handleAwarenessChange);
    };
  }, [editor, wsProvider]);

  // Synchronize Yjs 'codemirror' Y.Text (Obsidian) with TipTap's editor
  useEffect(() => {
    if (!editor || !ydoc || !wsProvider) return;

    const ytext = ydoc.getText('codemirror');
    let isApplyingRemote = false;

    // 1. Listen to Yjs text changes (from Obsidian)
    let lastRemoteUpdate = 0;
const handleYTextChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      // Skip if the transaction was initiated locally by this browser
      if (transaction && transaction.local) return;
      // Throttle remote updates to avoid excessive UI re-renders (min 500ms interval)
      const now = Date.now();
      if (now - lastRemoteUpdate < 500) return;
      lastRemoteUpdate = now;
      console.log('Applying remote update at', new Date(now).toISOString());

      // Do not overwrite content if the user is actively typing in the browser editor
      if (editor.isFocused) return;

      // Check if the update came from another browser
      if (transaction) {
        const metadata = ydoc.getMap('metadata');
        const browserClients = ydoc.getArray('browser-clients').toArray();
        let isBrowserUpdate = false;

        // A. Check metadata last-updater
        if (transaction.changedParentTypes.has(metadata as any)) {
          const lastUpdater = metadata.get('last-updater');
          if (lastUpdater && browserClients.includes(lastUpdater)) {
            isBrowserUpdate = true;
          }
        }

        // B. Fallback: check awareness states of changed clients
        if (!isBrowserUpdate && wsProvider) {
          const changedClients: number[] = [];
          transaction.afterState.forEach((clock, client) => {
            const beforeClock = transaction.beforeState.get(client) || 0;
            if (clock > beforeClock) {
              changedClients.push(client);
            }
          });
          
          const hasNonObsidianClient = changedClients.some(c => {
            const senderState = wsProvider.awareness.getStates().get(c);
            return senderState && senderState.user && senderState.user.userId !== 'obsidian-client';
          });
          
          if (hasNonObsidianClient || changedClients.some(c => browserClients.includes(c))) {
            isBrowserUpdate = true;
          }
        }

        if (isBrowserUpdate) {
          // If the update originates from another browser client, ignore for now (handled elsewhere)
          return;
        }
      }

      const fullMarkdown = ytext.toString();
      const { body } = splitFrontmatterAndBody(fullMarkdown);
      const currentHtml = editor.getHTML();
      const currentMarkdown = htmlToMarkdown(currentHtml);
      
      // If the content is already the same, do not update to prevent selection/caret reset
      if (normalizeMarkdown(body) === normalizeMarkdown(currentMarkdown)) return;

      const html = markdownToHtml(body);
      
      // Preserve current cursor selection before applying remote content
      const currentSelection = editor.state.selection;

      isApplyingRemote = true;
      try {
        editor.commands.setContent(html, false);
        // Restore selection after content update to avoid caret jump
        if (currentSelection && typeof currentSelection.from === 'number') {
          editor.commands.setTextSelection({ from: currentSelection.from, to: currentSelection.to });
        }
      } finally {
        isApplyingRemote = false;
      }
    };

    ytext.observe(handleYTextChange);

    // 2. Listen to TipTap editor changes (from browser typing) with a 250ms debounce
    let debounceTimer: NodeJS.Timeout;
    const handleTipTapUpdate = ({ transaction }: { transaction?: any } = {}) => {
      if (isApplyingRemote) return;
      if (transaction && transaction.getMeta('y-prosemirror')) return;
      
      clearTimeout(debounceTimer);
      // Increase debounce interval to reduce frequent remote writes
      debounceTimer = setTimeout(() => {
        if (isApplyingRemote) return;
        
        const html = editor.getHTML();
        const bodyMarkdown = htmlToMarkdown(html);
        
        const fullMarkdown = ytext.toString();
        const { frontmatter, body: currentBody } = splitFrontmatterAndBody(fullMarkdown);

        if (bodyMarkdown.trim() !== currentBody.trim()) {
          ydoc.transact(() => {
            updateYTextCleanly(ytext, frontmatter + bodyMarkdown);
            ydoc.getMap('metadata').set('last-updater', ydoc.clientID);
          }, 'tiptap-update');
          handleSelectionUpdate();
        }
      }, 250);
    };

    editor.on('update', handleTipTapUpdate);

    // 3. Sync local browser selection/cursor to Yjs awareness relative position
    const handleSelectionUpdate = () => {
      try {
        const { selection } = editor.state;
        const plainIndex = getPlainTextIndex(editor.state.doc, selection.head);
        
        const fullMarkdown = ytext.toString();
        const { frontmatter } = splitFrontmatterAndBody(fullMarkdown);
        const frontmatterLen = frontmatter.length;
        
        const relativePos = Y.createRelativePositionFromTypeIndex(ytext, plainIndex + frontmatterLen);
        
        wsProvider.awareness.setLocalStateField('cursor', {
          anchor: relativePos,
          head: relativePos
        });
      } catch (err) {
        console.warn('Error updating selection cursor awareness:', err);
      }
    };

    editor.on('selectionUpdate', handleSelectionUpdate);

    // Initial sync from Yjs to TipTap if Yjs has content
    const initialFullMarkdown = ytext.toString();
    if (initialFullMarkdown) {
      const { body } = splitFrontmatterAndBody(initialFullMarkdown);
      isApplyingRemote = true;
      try {
        editor.commands.setContent(markdownToHtml(body), false);
      } finally {
        isApplyingRemote = false;
      }
    }

    return () => {
      ytext.unobserve(handleYTextChange);
      editor.off('update', handleTipTapUpdate);
      editor.off('selectionUpdate', handleSelectionUpdate);
      clearTimeout(debounceTimer);
    };
  }, [editor, ydoc, wsProvider]);

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

// Markdown <-> HTML serialization helpers for Obsidian <-> TipTap sync
function markdownToHtml(markdown: string): string {
  if (!markdown) return '';
  
  const lines = markdown.split(/\r?\n/);
  let html = '';
  let inList = false;
  let listType: 'ul' | 'ol' | null = null;
  let inBlockquote = false;
  let inCodeBlock = false;
  
  const closeList = () => {
    if (inList) {
      html += listType === 'ul' ? '</ul>' : '</ol>';
      inList = false;
      listType = null;
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

function inlineMarkdownToHtml(text: string): string {
  let temp = text;
  // Bold, Italic & Code replacements
  temp = temp.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  temp = temp.replace(/\*([\s\S]+?)\*/g, '<em>$1</em>');
  temp = temp.replace(/`([\s\S]+?)`/g, '<code>$1</code>');
  return temp;
}

function htmlToMarkdown(html: string): string {
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
    return p1.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, () => `${index++}. $1\n`) + '\n';
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

// Maps a plain text character index (from Obsidian) to a ProseMirror document position
function getProseMirrorPos(doc: any, plainTextIndex: number): number {
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

// Maps a ProseMirror document position to a plain text character index (for Yjs relative selection)
function getPlainTextIndex(doc: any, pmPos: number): number {
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

// Splits content into YAML frontmatter and body markdown
function splitFrontmatterAndBody(content: string): { frontmatter: string; body: string } {
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
  
  // Clean up body
  body = body.trim();
  
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

function normalizeMarkdown(md: string): string {
  if (!md) return '';
  return md
    .replace(/\s+/g, ' ')
    .trim();
}

// Performs a performant diff-based update to Y.Text to keep typing updates smooth and prevent layout shifts
function updateYTextCleanly(ytext: Y.Text, newText: string) {
  const normalizedNewText = newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const oldText = ytext.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (oldText === normalizedNewText) return;

  // Find common prefix
  let commonPrefixLen = 0;
  const maxLen = Math.min(oldText.length, normalizedNewText.length);
  while (commonPrefixLen < maxLen && oldText[commonPrefixLen] === normalizedNewText[commonPrefixLen]) {
    commonPrefixLen++;
  }

  // Find common suffix
  let commonSuffixLen = 0;
  const maxSuffixLen = maxLen - commonPrefixLen;
  while (
    commonSuffixLen < maxSuffixLen &&
    oldText[oldText.length - 1 - commonSuffixLen] === normalizedNewText[normalizedNewText.length - 1 - commonSuffixLen]
  ) {
    commonSuffixLen++;
  }

  const deleteCount = oldText.length - commonPrefixLen - commonSuffixLen;
  const insertText = normalizedNewText.substring(commonPrefixLen, normalizedNewText.length - commonSuffixLen);

  if (deleteCount > 0 || insertText.length > 0) {
    ytext.delete(commonPrefixLen, deleteCount);
    ytext.insert(commonPrefixLen, insertText);
  }
}
