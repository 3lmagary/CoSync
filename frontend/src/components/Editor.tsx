import React, { useEffect, useState } from 'react';
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';

// Tiptap Table & Code Highlights
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';

import {
  Bold, Italic, Code, Strikethrough, List, ListOrdered, Heading1, Heading2,
  Users, ChevronLeft, Save, AlertTriangle, Quote, Terminal, Minus,
  Share2, Copy, Check, Menu, Maximize2, Minimize2, Table as TableIcon
} from 'lucide-react';
import { getProseMirrorPos } from '../services/cursor.service';
import { splitFrontmatterAndBody } from '../services/markdown.service';
import { useYjsSync } from '../hooks/useYjsSync';
import { useAwareness } from '../hooks/useAwareness';
import { HybridSyncManager } from '../core/HybridSyncManager';

const lowlight = createLowlight(common);

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

  const [currentTitle, setCurrentTitle] = useState(docTitle);
  const [widthMode, setWidthMode] = useState<'centered' | 'full'>('centered');

  // Notion-like Slash Menu states
  const [slashMenu, setSlashMenu] = useState<{
    isOpen: boolean;
    x: number;
    y: number;
    query: string;
    selectIndex: number;
  }>({
    isOpen: false,
    x: 0,
    y: 0,
    query: '',
    selectIndex: 0,
  });

  const slashCommands = [
    { id: 'h1', title: 'Heading 1', desc: 'Big section heading', icon: <Heading1 size={14} />, action: (editorInstance: any) => editorInstance.chain().focus().toggleHeading({ level: 1 }).run() },
    { id: 'h2', title: 'Heading 2', desc: 'Medium section heading', icon: <Heading2 size={14} />, action: (editorInstance: any) => editorInstance.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: 'bullet', title: 'Bullet List', desc: 'Simple bulleted list', icon: <List size={14} />, action: (editorInstance: any) => editorInstance.chain().focus().toggleBulletList().run() },
    { id: 'ordered', title: 'Ordered List', desc: 'List with numbering', icon: <ListOrdered size={14} />, action: (editorInstance: any) => editorInstance.chain().focus().toggleOrderedList().run() },
    { id: 'table', title: 'Table', desc: 'Insert a 3x3 layout table', icon: <TableIcon size={14} />, action: (editorInstance: any) => editorInstance.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: 'quote', title: 'Blockquote', desc: 'Capture a quote block', icon: <Quote size={14} />, action: (editorInstance: any) => editorInstance.chain().focus().toggleBlockquote().run() },
    { id: 'codeblock', title: 'Code Block', desc: 'Code snippet code block', icon: <Terminal size={14} />, action: (editorInstance: any) => editorInstance.chain().focus().toggleCodeBlock().run() },
    { id: 'divider', title: 'Divider', desc: 'Visual horizontal line', icon: <Minus size={14} />, action: (editorInstance: any) => editorInstance.chain().focus().setHorizontalRule().run() },
  ];

  const filteredCommands = slashCommands.filter(cmd => 
    cmd.title.toLowerCase().includes(slashMenu.query.toLowerCase()) ||
    cmd.id.toLowerCase().includes(slashMenu.query.toLowerCase())
  );

  const latestStateRef = React.useRef({
    slashMenu,
    filteredCommands
  });

  useEffect(() => {
    latestStateRef.current = {
      slashMenu,
      filteredCommands
    };
  }, [slashMenu, filteredCommands]);

  const handleExecuteCommand = (cmd: any) => {
    if (!editor) return;
    const { view } = editor;
    const { selection } = view.state;
    const text = selection.$from.parent.textContent;
    const caretIndex = selection.$from.parentOffset;
    const textBeforeCaret = text.slice(0, caretIndex);
    const slashIndex = textBeforeCaret.lastIndexOf('/');
    if (slashIndex !== -1) {
      const startPos = selection.$from.before() + 1 + slashIndex;
      view.dispatch(view.state.tr.delete(startPos, selection.from));
    }
    setTimeout(() => {
      cmd.action(editor);
      editor.commands.focus();
    }, 10);
    setSlashMenu(prev => ({ ...prev, isOpen: false }));
  };

  useEffect(() => {
    setCurrentTitle(docTitle);
  }, [docTitle]);

  const handleTitleChange = (newTitle: string) => {
    setCurrentTitle(newTitle);
  };

  const handleTitleBlur = async () => {
    if (!currentTitle.trim() || currentTitle === docTitle) return;
    try {
      const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/documents/${documentId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ title: currentTitle.trim() })
      });
      if (!res.ok) throw new Error('Failed to rename document');
    } catch (err) {
      console.error('Failed to rename document', err);
    }
  };

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
        codeBlock: false, // Use custom lowlight syntax highlighter instead
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

      CodeBlockLowlight.configure({
        lowlight,
      }),

      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,

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
      handleKeyDown: (view, event) => {
        const { slashMenu: menu, filteredCommands: filtered } = latestStateRef.current;
        if (!menu.isOpen || filtered.length === 0) return false;

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSlashMenu(prev => ({
            ...prev,
            selectIndex: (prev.selectIndex + 1) % filtered.length
          }));
          return true;
        }
        
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSlashMenu(prev => ({
            ...prev,
            selectIndex: (prev.selectIndex - 1 + filtered.length) % filtered.length
          }));
          return true;
        }

        if (event.key === 'Enter') {
          event.preventDefault();
          const selectedCmd = filtered[menu.selectIndex];
          if (selectedCmd) {
            const { selection } = view.state;
            const text = selection.$from.parent.textContent;
            const caretIndex = selection.$from.parentOffset;
            const textBeforeCaret = text.slice(0, caretIndex);
            const slashIndex = textBeforeCaret.lastIndexOf('/');
            if (slashIndex !== -1) {
              const startPos = selection.$from.before() + 1 + slashIndex;
              view.dispatch(view.state.tr.delete(startPos, selection.from));
            }
            setTimeout(() => {
              selectedCmd.action(editor);
              editor?.commands.focus();
            }, 10);
          }
          setSlashMenu(prev => ({ ...prev, isOpen: false }));
          return true;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          setSlashMenu(prev => ({ ...prev, isOpen: false }));
          return true;
        }

        return false;
      }
    },
  });

  const handleEditorStateChange = (editorInstance: any) => {
    const { selection } = editorInstance.state;
    const { $from } = selection;
    if ($from.parent.type.name !== 'paragraph') {
      if (latestStateRef.current.slashMenu.isOpen) {
        setSlashMenu(prev => ({ ...prev, isOpen: false }));
      }
      return;
    }
    const text = $from.parent.textContent;
    const caretIndex = $from.parentOffset;
    const textBeforeCaret = text.slice(0, caretIndex);
    const slashIndex = textBeforeCaret.lastIndexOf('/');
    
    if (slashIndex !== -1) {
      const query = textBeforeCaret.slice(slashIndex + 1);
      if (!query.includes(' ')) {
        const coords = editorInstance.view.coordsAtPos(selection.from);
        const container = editorInstance.view.dom.closest('.editor-scroll-container');
        if (container) {
          const containerRect = container.getBoundingClientRect();
          const x = coords.left - containerRect.left + container.scrollLeft;
          const y = coords.bottom - containerRect.top + container.scrollTop + 5;
          setSlashMenu(prev => ({
            isOpen: true,
            x,
            y,
            query,
            selectIndex: prev.isOpen && prev.query === query ? prev.selectIndex : 0
          }));
          return;
        }
      }
    }
    
    if (latestStateRef.current.slashMenu.isOpen) {
      setSlashMenu(prev => ({ ...prev, isOpen: false }));
    }
  };

  useEffect(() => {
    if (!editor) return;
    const handleStateChange = () => {
      handleEditorStateChange(editor);
    };
    editor.on('update', handleStateChange);
    editor.on('selectionUpdate', handleStateChange);
    return () => {
      editor.off('update', handleStateChange);
      editor.off('selectionUpdate', handleStateChange);
    };
  }, [editor]);

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
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
      
      {/* Editor Header Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1.5rem', borderBottom: '1px solid var(--border-color)', background: 'var(--navbar-bg)', backdropFilter: 'blur(10px)', zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {!isSidebarOpen && onToggleSidebar && (
            <button onClick={onToggleSidebar} className="btn-secondary" style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Show Sidebar">
              <Menu size={20} />
            </button>
          )}
          <button onClick={onBack} className="btn-secondary" style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Back to Documents">
            <ChevronLeft size={20} />
          </button>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span className={`status-badge ${connectionStatus}`}>
              <span className="pulse-dot"></span>
              <span>{connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting' : 'Disconnected'}</span>
            </span>
            <span className="status-badge" style={{ color: '#9ca3af', gap: '0.25rem' }}>
              <Save size={14} />
              <span>{localSynced ? 'Saved' : 'Saving...'}</span>
            </span>
            {docSize > maxDocSize * 0.8 && (
              <span className="status-badge" style={{ color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)', gap: '0.25rem' }}>
                <AlertTriangle size={14} />
                <span>Size Warning: {(docSize / 1024 / 1024).toFixed(2)}MB</span>
              </span>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {/* Toggle Width Mode */}
          <button
            onClick={() => setWidthMode(prev => prev === 'centered' ? 'full' : 'centered')}
            className="btn-secondary"
            style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title={widthMode === 'centered' ? "Full Width" : "Readable Width"}
          >
            {widthMode === 'centered' ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
          </button>

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

      {/* Selection Bubble Menu */}
      {editor && (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 150 }}>
          <div className="bubble-menu">
            <button
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={editor.isActive('bold') ? 'is-active' : ''}
              title="Bold"
            >
              <Bold size={14} />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={editor.isActive('italic') ? 'is-active' : ''}
              title="Italic"
            >
              <Italic size={14} />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleStrike().run()}
              className={editor.isActive('strike') ? 'is-active' : ''}
              title="Strikethrough"
            >
              <Strikethrough size={14} />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleCode().run()}
              className={editor.isActive('code') ? 'is-active' : ''}
              title="Inline Code"
            >
              <Code size={14} />
            </button>
            <div style={{ width: '1px', height: '14px', background: 'rgba(255,255,255,0.15)', margin: 'auto 0.25rem' }}></div>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              className={editor.isActive('heading', { level: 1 }) ? 'is-active' : ''}
              title="Heading 1"
            >
              <Heading1 size={14} />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              className={editor.isActive('heading', { level: 2 }) ? 'is-active' : ''}
              title="Heading 2"
            >
              <Heading2 size={14} />
            </button>
            <div style={{ width: '1px', height: '14px', background: 'rgba(255,255,255,0.15)', margin: 'auto 0.25rem' }}></div>
            <button
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              className={editor.isActive('bulletList') ? 'is-active' : ''}
              title="Bullet List"
            >
              <List size={14} />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              className={editor.isActive('blockquote') ? 'is-active' : ''}
              title="Blockquote"
            >
              <Quote size={14} />
            </button>
          </div>
        </BubbleMenu>
      )}

      {sharingError && (
        <div style={{ margin: '1rem 1.5rem 0', padding: '0.5rem 0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#fca5a5', borderRadius: '8px', fontSize: '0.8rem' }}>
          {sharingError}
        </div>
      )}

      {/* Clean Document View */}
      <div className="editor-clean-layout">
        {/* Scrollable document area */}
        <div className="editor-scroll-container">
          {slashMenu.isOpen && filteredCommands.length > 0 && (
            <div 
              className="slash-menu" 
              style={{ 
                top: slashMenu.y, 
                left: slashMenu.x,
              }}
            >
              {filteredCommands.map((cmd, idx) => (
                <button
                  key={cmd.id}
                  onClick={() => handleExecuteCommand(cmd)}
                  className={`slash-menu-item ${slashMenu.selectIndex === idx ? 'is-selected' : ''}`}
                >
                  <span className="slash-menu-item-icon">{cmd.icon}</span>
                  <span className="slash-menu-item-details">
                    <span className="slash-menu-item-title">{cmd.title}</span>
                    <span className="slash-menu-item-desc">{cmd.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className={`editor-document-page ${widthMode === 'centered' ? 'centered-width' : 'full-width'}`}>
            
            {/* Inline Auto-saving Title Input */}
            <input
              type="text"
              value={currentTitle}
              onChange={(e) => handleTitleChange(e.target.value)}
              onBlur={handleTitleBlur}
              className="editor-document-title-input"
              placeholder="Untitled note"
            />
            
            {/* Editable Content */}
            <div className="tiptap-clean">
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>
      </div>

      {/* Share Document Link Modal Dialog */}
      {showShareModal && (
        <div className="share-modal-overlay" onClick={() => setShowShareModal(false)}>
          <div className="share-modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>Share Document</h3>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              Anyone with this link will join this workspace and directly open this document: <strong>{currentTitle}</strong>.
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
