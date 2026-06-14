import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { 
  FolderPlus, File, Edit2, Trash2, Share2, LogOut, FolderOpen,
  ChevronRight, ChevronDown, Folder, Sun, Moon, Copy, Check, Plus, Key, RotateCw, ChevronLeft
} from 'lucide-react';

interface Workspace {
  id: string;
  name: string;
}

interface Document {
  id: string;
  workspaceId: string;
  title: string;
}

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  doc?: Document;
  children: Record<string, TreeNode>;
}

function buildDocTree(docs: Document[]): TreeNode {
  const root: TreeNode = { name: 'root', path: '', isFolder: true, children: {} };

  for (const doc of docs) {
    const parts = doc.title.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = current.path ? `${current.path}/${part}` : part;

      if (!current.children[part]) {
        current.children[part] = {
          name: part,
          path: currentPath,
          isFolder: !isLast,
          doc: isLast ? doc : undefined,
          children: {}
        };
      }

      current = current.children[part];
    }
  }

  return root;
}

interface WorkspaceSelectorProps {
  token: string;
  backendUrl: string;
  onSelectDocument: (workspaceId: string, documentId: string, title: string) => void;
  onLogout: () => void;
  username: string;
  selectedDocumentId: string | null;
  width: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onCollapse?: () => void;
}

interface CustomDialogState {
  isOpen: boolean;
  type: 'confirm';
  title: string;
  message: string;
  onConfirm: () => void;
}

export const WorkspaceSelector: React.FC<WorkspaceSelectorProps> = ({
  token,
  backendUrl,
  onSelectDocument,
  onLogout,
  username,
  selectedDocumentId,
  width,
  theme,
  onToggleTheme,
  onCollapse
}) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceDocs, setWorkspaceDocs] = useState<Record<string, Document[]>>({});
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Custom UI Dialog state (Only for delete confirmations)
  const [dialog, setDialog] = useState<CustomDialogState | null>(null);

  // Inline Editing states
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [createWorkspaceValue, setCreateWorkspaceValue] = useState('');

  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceValue, setRenameWorkspaceValue] = useState('');

  const [creatingDocInWorkspaceId, setCreatingDocInWorkspaceId] = useState<string | null>(null);
  const [createDocValue, setCreateDocValue] = useState('');

  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renameDocValue, setRenameDocValue] = useState('');
  const [shareSuccess, setShareSuccess] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  
  // Connect Obsidian Modal states
  const [showObsidianModal, setShowObsidianModal] = useState(false);
  const [selectedWorkspaceForObsidian, setSelectedWorkspaceForObsidian] = useState<string>('create-new');
  const [copiedObsidianCode, setCopiedObsidianCode] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  // Share Modal state
  const [shareModal, setShareModal] = useState<{
    isOpen: boolean;
    workspaceId: string;
    workspaceName: string;
    inviteToken: string;
    usernameToShare: string;
    copied: boolean;
  } | null>(null);

  // Helper to trigger custom confirm (for deletes)
  const showCustomConfirm = (title: string, message: string, onConfirm: () => void) => {
    setDialog({
      isOpen: true,
      type: 'confirm',
      title,
      message,
      onConfirm: () => {
        onConfirm();
        setDialog(null);
      }
    });
  };

  // Load workspaces on mount
  useEffect(() => {
    fetchWorkspaces();
  }, []);

  // Expand the workspace containing the active document
  useEffect(() => {
    if (selectedDocumentId) {
      const wsId = Object.keys(workspaceDocs).find(wid => 
        workspaceDocs[wid]?.some(doc => doc.id === selectedDocumentId)
      );
      if (wsId) {
        setExpandedWorkspaces(prev => ({ ...prev, [wsId]: true }));
        const doc = workspaceDocs[wsId]?.find(d => d.id === selectedDocumentId);
        if (doc && doc.title.includes('/')) {
          const parts = doc.title.split('/');
          const newExpanded: Record<string, boolean> = {};
          let currentPath = '';
          for (let i = 0; i < parts.length - 1; i++) {
            currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
            newExpanded[currentPath] = true;
          }
          setExpandedFolders(prev => ({ ...prev, ...newExpanded }));
        }
      }
    }
  }, [selectedDocumentId, workspaceDocs]);

  const fetchWorkspaces = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/workspaces`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401) {
        onLogout();
        return;
      }
      if (!res.ok) throw new Error('Failed to load workspaces');
      const data = await res.json();
      setWorkspaces(data);
      
      // Concurrently fetch all documents for all workspaces
      fetchAllDocuments(data);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const fetchAllDocuments = async (workspacesList: Workspace[]) => {
    const docsMap: Record<string, Document[]> = {};
    
    await Promise.all(workspacesList.map(async (ws) => {
      try {
        const res = await fetch(`${backendUrl}/api/workspaces/${ws.id}/documents`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          docsMap[ws.id] = data;
        }
      } catch (err) {
        console.error(`Failed to load documents for workspace ${ws.id}`, err);
      }
    }));
    
    setWorkspaceDocs(docsMap);
  };

  const createWorkspaceWithName = async (name: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/workspaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name })
      });
      if (!res.ok) throw new Error('Failed to create workspace');
      const data = await res.json();
      setWorkspaces([...workspaces, data]);
      setWorkspaceDocs(prev => ({ ...prev, [data.id]: [] }));
      setExpandedWorkspaces(prev => ({ ...prev, [data.id]: true }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleCreateDocument = async (workspaceId: string, title: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ title })
      });
      if (!res.ok) throw new Error('Failed to create document');
      const data = await res.json();
      
      setWorkspaceDocs(prev => ({
        ...prev,
        [workspaceId]: [...(prev[workspaceId] || []), data]
      }));
      setExpandedWorkspaces(prev => ({ ...prev, [workspaceId]: true }));
      onSelectDocument(workspaceId, data.id, data.title);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteWorkspace = async (workspaceId: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete workspace');
      }
      setWorkspaces(workspaces.filter(ws => ws.id !== workspaceId));
      setWorkspaceDocs(prev => {
        const updated = { ...prev };
        delete updated[workspaceId];
        return updated;
      });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRenameWorkspace = async (workspaceId: string, newName: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name: newName })
      });
      if (!res.ok) throw new Error('Failed to rename workspace');
      setWorkspaces(workspaces.map(ws => ws.id === workspaceId ? { ...ws, name: newName } : ws));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleShareWorkspaceModal = async (e: React.MouseEvent, workspaceId: string, workspaceName: string) => {
    e.stopPropagation();
    try {
      const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/invite-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to generate invite token');
      const data = await res.json();
      
      setShareSuccess(null);
      setShareError(null);
      setShareModal({
        isOpen: true,
        workspaceId,
        workspaceName,
        inviteToken: data.token,
        usernameToShare: '',
        copied: false
      });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteDocument = async (workspaceId: string, docId: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/documents/${docId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete document');
      
      setWorkspaceDocs(prev => ({
        ...prev,
        [workspaceId]: prev[workspaceId].filter(doc => doc.id !== docId)
      }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRenameDocument = async (workspaceId: string, docId: string, newTitle: string) => {
    try {
      const res = await fetch(`${backendUrl}/api/workspaces/${workspaceId}/documents/${docId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ title: newTitle })
      });
      if (!res.ok) throw new Error('Failed to rename document');
      
      setWorkspaceDocs(prev => ({
        ...prev,
        [workspaceId]: prev[workspaceId].map(doc => doc.id === docId ? { ...doc, title: newTitle } : doc)
      }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleWorkspaceExpanded = (workspaceId: string) => {
    setExpandedWorkspaces(prev => ({
      ...prev,
      [workspaceId]: !prev[workspaceId]
    }));
  };

  // Inline Commit Handlers
  const handleCommitCreateWorkspace = () => {
    if (!isCreatingWorkspace) return;
    if (createWorkspaceValue.trim()) {
      createWorkspaceWithName(createWorkspaceValue.trim());
    }
    setIsCreatingWorkspace(false);
    setCreateWorkspaceValue('');
  };

  const handleCommitRenameWorkspace = (workspaceId: string) => {
    if (renamingWorkspaceId !== workspaceId) return;
    if (renameWorkspaceValue.trim()) {
      handleRenameWorkspace(workspaceId, renameWorkspaceValue.trim());
    }
    setRenamingWorkspaceId(null);
  };

  const handleCommitCreateDocument = (workspaceId: string) => {
    if (creatingDocInWorkspaceId !== workspaceId) return;
    if (createDocValue.trim()) {
      handleCreateDocument(workspaceId, createDocValue.trim());
    }
    setCreatingDocInWorkspaceId(null);
    setCreateDocValue('');
  };

  const handleCommitRenameDocument = (workspaceId: string, docId: string) => {
    if (renamingDocId !== docId) return;
    if (renameDocValue.trim()) {
      handleRenameDocument(workspaceId, docId, renameDocValue.trim());
    }
    setRenamingDocId(null);
  };

  const renderTreeNode = (node: TreeNode, depth: number, wsId: string): React.ReactNode => {
    const sortedKeys = Object.keys(node.children).sort((a, b) => {
      const na = node.children[a];
      const nb = node.children[b];
      if (na.isFolder && !nb.isFolder) return -1;
      if (!na.isFolder && nb.isFolder) return 1;
      return a.localeCompare(b);
    });

    return (
      <div key={node.path} style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
        {node.name !== 'root' && (
          node.isFolder ? (
            <div 
              onClick={(e) => {
                e.stopPropagation();
                setExpandedFolders(prev => ({ ...prev, [node.path]: !prev[node.path] }));
              }}
              className="workspace-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: '0.35rem',
                padding: '0.35rem 0.5rem',
                fontSize: '0.83rem',
                borderRadius: '6px',
                cursor: 'pointer',
                color: 'var(--text-color)',
                marginLeft: `${depth * 0.5}rem`,
                background: 'transparent',
                transition: 'background 0.2s',
              }}
            >
              {expandedFolders[node.path] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Folder size={13} color="#f59e0b" style={{ flexShrink: 0 }} />
              <span 
                dir="auto"
                style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'start' }}
              >
                {node.name}
              </span>
            </div>
          ) : (
            node.doc && (
              <div
                onClick={() => onSelectDocument(wsId, node.doc!.id, node.doc!.title)}
                className={`document-item ${selectedDocumentId === node.doc.id ? 'active' : ''}`}
                style={{ 
                  padding: '0.4rem 0.5rem', 
                  fontSize: '0.83rem', 
                  borderRadius: '6px',
                  marginLeft: `${depth * 0.5 + 0.9}rem`
                }}
              >
                {renamingDocId === node.doc.id ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%' }} onClick={e => e.stopPropagation()}>
                    <File size={13} color="var(--active-text)" style={{ flexShrink: 0 }} />
                    <input
                      type="text"
                      autoFocus
                      value={renameDocValue}
                      onChange={e => setRenameDocValue(e.target.value)}
                      onBlur={() => handleCommitRenameDocument(wsId, node.doc!.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleCommitRenameDocument(wsId, node.doc!.id);
                        else if (e.key === 'Escape') setRenamingDocId(null);
                      }}
                      className="input-field"
                      style={{ padding: '2px 6px', fontSize: '0.8rem', width: '100%', height: '20px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.1)', color: 'var(--text-color)' }}
                    />
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', overflow: 'hidden', flex: 1 }}>
                      <File size={13} color={selectedDocumentId === node.doc.id ? 'var(--active-text)' : 'var(--text-muted)'} style={{ flexShrink: 0 }} />
                      <span 
                        dir="auto"
                        style={{ 
                          whiteSpace: 'nowrap', 
                          overflow: 'hidden', 
                          textOverflow: 'ellipsis',
                          color: selectedDocumentId === node.doc.id ? 'var(--active-text)' : 'var(--text-color)',
                          textAlign: 'start'
                        }}
                      >
                        {node.name}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: '0.15rem', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingDocId(node.doc!.id);
                          setRenameDocValue(node.doc!.title);
                        }}
                        title="Rename Document"
                        className="action-btn rename"
                        style={{ padding: '2px' }}
                      >
                        <Edit2 size={11} />
                      </button>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          showCustomConfirm('Delete Document', `Are you sure you want to delete "${node.doc!.title}"? This action cannot be undone.`, () => {
                            handleDeleteDocument(wsId, node.doc!.id);
                          });
                        }}
                        title="Delete Document"
                        className="action-btn delete"
                        style={{ padding: '2px' }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          )
        )}
        
        {(node.name === 'root' || expandedFolders[node.path]) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
            {sortedKeys.map(key => renderTreeNode(node.children[key], node.name === 'root' ? 0 : depth + 1, wsId))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div 
      className="sidebar-container" 
      style={{ 
        width, 
        minWidth: width, 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '1.25rem', 
        padding: '1.25rem', 
        background: 'var(--sidebar-bg)', 
        borderRight: '1px solid var(--border-color)', 
        height: '100%', 
        boxSizing: 'border-box', 
        overflowY: 'auto',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        transition: 'background-color 0.3s ease, border-color 0.3s ease'
      }}
    >
      {/* Brand & User Profile */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
        <div style={{ display: 'flex', justifySelf: 'stretch', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="brand" style={{ fontSize: '1.45rem' }}>
            <span>✍️</span>
            <span>CoSync</span>
          </div>
          <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
            <button 
              onClick={fetchWorkspaces} 
              className="action-btn rename" 
              title="Refresh Workspaces & Notes"
              style={{ padding: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <RotateCw size={15} />
            </button>
            <button 
              onClick={onToggleTheme} 
              className="action-btn rename" 
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              style={{ padding: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            {onCollapse && (
              <button 
                onClick={onCollapse} 
                className="action-btn rename" 
                title="Collapse Sidebar"
                style={{ padding: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <ChevronLeft size={15} />
              </button>
            )}
          </div>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--item-bg)', padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid var(--border-muted)' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginRight: '4px' }}>
            Hi, <span style={{ color: 'var(--active-text)', fontWeight: 600 }}>{username}</span>
          </span>
          <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
            <button 
              onClick={() => setShowObsidianModal(true)} 
              className="action-btn rename" 
              title="Connect Obsidian Vault" 
              style={{ padding: '4px' }}
            >
              <Key size={13} />
            </button>
            <button onClick={onLogout} className="action-btn delete" title="Sign Out" style={{ padding: '2px' }}>
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#fca5a5', borderRadius: '8px', fontSize: '0.8rem' }}>
          {error}
        </div>
      )}

      {/* Workspaces Section Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <FolderOpen size={13} />
          <span>Workspaces</span>
        </span>
        <button 
          onClick={() => {
            setIsCreatingWorkspace(true);
          }} 
          className="action-btn rename" 
          title="New Workspace"
          style={{ padding: '4px', borderRadius: '4px', background: 'var(--item-bg)' }}
        >
          <FolderPlus size={14} />
        </button>
      </div>

      {/* Folders File Tree list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, overflowY: 'auto' }}>
        
        {/* Workspace Creation Input */}
        {isCreatingWorkspace && (
          <div className="workspace-item" style={{ padding: '0.45rem 0.6rem' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%' }}>
              <Folder size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />
              <input
                type="text"
                autoFocus
                placeholder="Workspace name..."
                value={createWorkspaceValue}
                onChange={e => setCreateWorkspaceValue(e.target.value)}
                onBlur={handleCommitCreateWorkspace}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCommitCreateWorkspace();
                  else if (e.key === 'Escape') setIsCreatingWorkspace(false);
                }}
                className="input-field"
                style={{ padding: '2px 6px', fontSize: '0.85rem', width: '100%', height: '22px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.1)', color: 'var(--text-color)' }}
              />
            </div>
          </div>
        )}

        {workspaces.length === 0 && !isCreatingWorkspace ? (
          <div style={{ padding: '2rem 1rem', color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
            No Workspaces yet.<br/>Create one to start!
          </div>
        ) : (
          workspaces.map(ws => {
            const isExpanded = !!expandedWorkspaces[ws.id];
            const docs = workspaceDocs[ws.id] || [];
            
            return (
              <div key={ws.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                {/* Folder Item */}
                <div 
                  className="workspace-item"
                  style={{ 
                    padding: '0.45rem 0.6rem', 
                    fontSize: '0.88rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                  onClick={() => toggleWorkspaceExpanded(ws.id)}
                >
                  {renamingWorkspaceId === ws.id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%' }} onClick={e => e.stopPropagation()}>
                      <FolderOpen size={14} color="#818cf8" style={{ flexShrink: 0 }} />
                      <input
                        type="text"
                        autoFocus
                        value={renameWorkspaceValue}
                        onChange={e => setRenameWorkspaceValue(e.target.value)}
                        onBlur={() => handleCommitRenameWorkspace(ws.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleCommitRenameWorkspace(ws.id);
                          else if (e.key === 'Escape') setRenamingWorkspaceId(null);
                        }}
                        className="input-field"
                        style={{ padding: '2px 6px', fontSize: '0.85rem', width: '100%', height: '22px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.1)', color: 'var(--text-color)' }}
                      />
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', overflow: 'hidden', flex: 1 }}>
                        {isExpanded ? <ChevronDown size={14} style={{ flexShrink: 0 }} /> : <ChevronRight size={14} style={{ flexShrink: 0 }} />}
                        {isExpanded ? <FolderOpen size={14} color="#818cf8" style={{ flexShrink: 0 }} /> : <Folder size={14} color="#9ca3af" style={{ flexShrink: 0 }} />}
                        <span 
                          dir="auto"
                          style={{ 
                            whiteSpace: 'nowrap', 
                            overflow: 'hidden', 
                            textOverflow: 'ellipsis',
                            fontWeight: 600,
                            color: 'var(--text-color)',
                            textAlign: 'start'
                          }}
                        >
                          {ws.name}
                        </span>
                      </div>
                      
                      {/* Action buttons inside workspace folder */}
                      <div style={{ display: 'flex', gap: '0.15rem', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                        <button 
                          onClick={() => {
                            setCreatingDocInWorkspaceId(ws.id);
                            setExpandedWorkspaces(prev => ({ ...prev, [ws.id]: true }));
                          }} 
                          className="action-btn rename" 
                          title="New Document"
                        >
                          <Plus size={13} />
                        </button>
                        <button onClick={(e) => handleShareWorkspaceModal(e, ws.id, ws.name)} className="action-btn share" title="Share via link">
                          <Share2 size={12} />
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenamingWorkspaceId(ws.id);
                            setRenameWorkspaceValue(ws.name);
                          }} 
                          className="action-btn rename" 
                          title="Rename Workspace"
                        >
                          <Edit2 size={12} />
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            showCustomConfirm('Delete Workspace', `Are you sure you want to delete "${ws.name}" and all its documents? This action cannot be undone.`, () => {
                              handleDeleteWorkspace(ws.id);
                            });
                          }} 
                          className="action-btn delete" 
                          title="Delete Workspace"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Sub-documents branch */}
                {isExpanded && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', paddingLeft: '1.1rem', borderLeft: '1px dashed var(--border-color)', marginLeft: '0.75rem', marginTop: '0.1rem' }}>
                    
                    {(() => {
                      const tree = buildDocTree(docs);
                      return renderTreeNode(tree, 0, ws.id);
                    })()}

                    {/* Inline Document Creation Input */}
                    {creatingDocInWorkspaceId === ws.id && (
                      <div className="document-item" style={{ padding: '0.4rem 0.5rem' }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%' }}>
                          <File size={13} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                          <input
                            type="text"
                            autoFocus
                            placeholder="Untitled..."
                            value={createDocValue}
                            onChange={e => setCreateDocValue(e.target.value)}
                            onBlur={() => handleCommitCreateDocument(ws.id)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleCommitCreateDocument(ws.id);
                              else if (e.key === 'Escape') setCreatingDocInWorkspaceId(null);
                            }}
                            className="input-field"
                            style={{ padding: '2px 6px', fontSize: '0.8rem', width: '100%', height: '20px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.1)', color: 'var(--text-color)' }}
                          />
                        </div>
                      </div>
                    )}

                    {docs.length === 0 && creatingDocInWorkspaceId !== ws.id && (
                      <div style={{ padding: '0.35rem 0.5rem', color: 'var(--text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>
                        Empty Workspace
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Custom Dialog Overlay (Only for delete confirmations) */}
      {dialog && dialog.isOpen && ReactDOM.createPortal(
        <div className="share-modal-overlay" onClick={() => setDialog(null)}>
          <div className="share-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800 }}>{dialog.title}</h3>
            
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              {dialog.message}
            </p>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button onClick={() => setDialog(null)} className="btn-secondary" style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}>
                Cancel
              </button>
              <button 
                onClick={dialog.onConfirm}
                className="btn-primary"
                style={{ 
                  padding: '0.45rem 1.25rem', 
                  fontSize: '0.85rem',
                  background: 'linear-gradient(135deg, #ef4444, #b91c1c)',
                  boxShadow: '0 4px 15px rgba(239, 68, 68, 0.2)'
                }}
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Share Workspace Modal Dialog */}
      {shareModal && shareModal.isOpen && ReactDOM.createPortal(
        <div className="share-modal-overlay" onClick={() => { setShareModal(null); setShareSuccess(null); setShareError(null); }}>
          <div className="share-modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>Invite to {shareModal.workspaceName}</h3>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--active-text)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              Workspace ID: {shareModal.workspaceId}
            </p>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              Anyone with this link will be added as a collaborator to this workspace.
            </p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)' }}>Workspace Invite Link</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input 
                  type="text" 
                  readOnly 
                  value={`${window.location.origin}/?invite=${shareModal.inviteToken}`}
                  className="input-field"
                  style={{ flex: 1, fontSize: '0.85rem', padding: '0.5rem 0.75rem' }}
                />
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/?invite=${shareModal.inviteToken}`);
                    setShareModal(prev => prev ? { ...prev, copied: true } : null);
                    setTimeout(() => {
                      setShareModal(prev => prev ? { ...prev, copied: false } : null);
                    }, 2000);
                  }}
                  className="btn-primary"
                  style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                >
                  {shareModal.copied ? <Check size={16} /> : <Copy size={16} />}
                  <span>{shareModal.copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            <div style={{ width: '100%', height: '1px', background: 'var(--border-color)', margin: '0.5rem 0' }} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)' }}>Invite directly via Username</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input 
                  type="text" 
                  placeholder="Enter username..." 
                  value={shareModal.usernameToShare}
                  onChange={e => setShareModal(prev => prev ? { ...prev, usernameToShare: e.target.value } : null)}
                  className="input-field"
                  style={{ flex: 1, fontSize: '0.85rem', padding: '0.5rem 0.75rem' }}
                />
                <button 
                  onClick={async () => {
                    if (!shareModal.usernameToShare.trim()) return;
                    setShareSuccess(null);
                    setShareError(null);
                    try {
                      const res = await fetch(`${backendUrl}/api/workspaces/${shareModal.workspaceId}/share`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${token}`
                        },
                        body: JSON.stringify({ username: shareModal.usernameToShare })
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || 'Failed to share');
                      setShareSuccess(`Successfully shared workspace with ${shareModal.usernameToShare}`);
                      setShareModal(prev => prev ? { ...prev, usernameToShare: '' } : null);
                    } catch (err: any) {
                      setShareError(err.message);
                    }
                  }}
                  className="btn-secondary"
                  style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                >
                  Send
                </button>
              </div>
              {shareSuccess && (
                <div style={{ fontSize: '0.8rem', color: '#10b981', marginTop: '0.25rem', fontWeight: 600 }}>
                  {shareSuccess}
                </div>
              )}
              {shareError && (
                <div style={{ fontSize: '0.8rem', color: '#ef4444', marginTop: '0.25rem', fontWeight: 600 }}>
                  {shareError}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button 
                onClick={() => {
                  setShareModal(null);
                  setShareSuccess(null);
                  setShareError(null);
                }} 
                className="btn-secondary" 
                style={{ padding: '0.5rem 1.25rem' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showObsidianModal && ReactDOM.createPortal(
        <div className="share-modal-overlay" onClick={() => setShowObsidianModal(false)}>
          <div className="share-modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>🔌</span>
              <span>Connect Obsidian Vault</span>
            </h3>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              Link your Obsidian vault directly to CoSync. You can choose to sync to an existing workspace or automatically create a new one named after your vault.
            </p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)' }}>Target Workspace</label>
              <select
                value={selectedWorkspaceForObsidian}
                onChange={e => {
                  setSelectedWorkspaceForObsidian(e.target.value);
                  setCopiedObsidianCode(false);
                }}
                className="input-field"
                style={{ width: '100%', padding: '0.5rem', background: 'var(--item-bg)', color: 'var(--text-color)', border: '1px solid var(--border-color)', borderRadius: '6px' }}
              >
                <option value="create-new">🆕 Create new workspace named after vault (Recommended)</option>
                {workspaces.map(ws => (
                  <option key={ws.id} value={ws.id}>📁 {ws.name}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)' }}>Connection Code</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input 
                  type="text" 
                  readOnly 
                  value={btoa(JSON.stringify({
                    serverUrl: backendUrl,
                    token: token,
                    workspaceId: selectedWorkspaceForObsidian
                  }))}
                  className="input-field"
                  style={{ flex: 1, fontSize: '0.85rem', padding: '0.5rem 0.75rem' }}
                  onClick={e => (e.target as HTMLInputElement).select()}
                />
                <button 
                  onClick={() => {
                    const code = btoa(JSON.stringify({
                      serverUrl: backendUrl,
                      token: token,
                      workspaceId: selectedWorkspaceForObsidian
                    }));
                    navigator.clipboard.writeText(code);
                    setCopiedObsidianCode(true);
                    setTimeout(() => setCopiedObsidianCode(false), 2000);
                  }}
                  className="btn-primary"
                  style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                >
                  {copiedObsidianCode ? <Check size={16} /> : <Copy size={16} />}
                  <span>{copiedObsidianCode ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button 
                onClick={() => {
                  setShowObsidianModal(false);
                  setCopiedObsidianCode(false);
                }} 
                className="btn-secondary" 
                style={{ padding: '0.5rem 1.25rem' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
