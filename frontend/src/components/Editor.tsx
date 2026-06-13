import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import {
  Bold, Italic, Code, Strikethrough, List, ListOrdered, Heading1, Heading2,
  Undo, Redo, Users, ChevronLeft, Save, AlertTriangle, Quote, Terminal, Minus,
  Share2, Copy, Check
} from 'lucide-react';

interface EditorProps {
  token: string;
  workspaceId: string;
  documentId: string;
  docTitle: string;
  backendUrl: string;
  onBack: () => void;
  user: { id: string; username: string; color: string };
}

export const Editor: React.FC<EditorProps> = ({
  token,
  workspaceId,
  documentId,
  docTitle,
  backendUrl,
  onBack,
  user
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
    ],
    editorProps: {
      attributes: {
        class: 'tiptap',
      },
    },
  });

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
          <button onClick={onBack} className="btn-secondary" style={{ padding: '0.5rem' }}>
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
