import React, { useState, useEffect, useRef } from 'react';
import { Auth } from './components/Auth';
import { WorkspaceSelector } from './components/WorkspaceSelector';
import { Editor } from './components/Editor';
import { Menu } from 'lucide-react';

interface User {
  id: string;
  username: string;
  color: string;
}

interface SelectedDoc {
  workspaceId: string;
  documentId: string;
  title: string;
}

const getBackendUrl = () => {
  const envUrl = import.meta.env.VITE_BACKEND_URL;
  if (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')) {
    return envUrl;
  }
  
  if (typeof window !== 'undefined' && window.location) {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    
    if (hostname && hostname.includes('cosync') && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      const apiHost = hostname.replace('cosync', 'cosync-api');
      return `${protocol}//${apiHost}`;
    }
    
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return `${protocol}//${hostname}:4000`;
    }
  }
  return envUrl || 'http://localhost:4000';
};

const BACKEND_URL = getBackendUrl();

const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<SelectedDoc | null>(null);
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);

  // Theme support
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('cosync_theme') as 'dark' | 'light') || 'dark';
  });

  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  // Sidebar width support
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('cosync_sidebar_width');
    return saved ? parseInt(saved, 10) : 260;
  });

  const isResizing = useRef(false);

  // Restore session from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('cosync_token');
    const savedUser = localStorage.getItem('cosync_user');
    
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
  }, []);

  // Theme class management
  useEffect(() => {
    localStorage.setItem('cosync_theme', theme);
    if (theme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  }, [theme]);

  // Handle invite joins
  const joinWorkspaceWithToken = async (authToken: string, inviteToken: string, targetDocId?: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/workspaces/join/${inviteToken}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to join workspace');
      
      // Clear URL params
      const url = new URL(window.location.href);
      url.searchParams.delete('invite');
      url.searchParams.delete('docId');
      window.history.replaceState({}, document.title, url.pathname);

      alert(`Successfully joined workspace: ${data.workspace.name}`);
      
      // Trigger refresh of workspaces list
      setWorkspaceRefreshKey(prev => prev + 1);

      if (targetDocId) {
        // Fetch workspace documents to select it
        try {
          const docsRes = await fetch(`${BACKEND_URL}/api/workspaces/${data.workspace.id}/documents`, {
            headers: { Authorization: `Bearer ${authToken}` }
          });
          if (docsRes.ok) {
            const docs = await docsRes.json();
            const targetDoc = docs.find((d: any) => d.id === targetDocId);
            if (targetDoc) {
              setSelectedDoc({
                workspaceId: data.workspace.id,
                documentId: targetDocId,
                title: targetDoc.title
              });
            }
          }
        } catch (e) {
          console.error(e);
        }
      }
    } catch (err: any) {
      alert(err.message);
      // Clear URL params
      const url = new URL(window.location.href);
      url.searchParams.delete('invite');
      url.searchParams.delete('docId');
      window.history.replaceState({}, document.title, url.pathname);
    }
  };

  // Check URL query parameters for invite token
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get('invite');
    const docId = params.get('docId');

    if (inviteToken) {
      if (token) {
        joinWorkspaceWithToken(token, inviteToken, docId || undefined);
      } else {
        localStorage.setItem('cosync_pending_invite', inviteToken);
        if (docId) {
          localStorage.setItem('cosync_pending_doc_id', docId);
        }
        alert('Please login or register to join the shared workspace.');
      }
    }
  }, [token]);

  const handleAuthSuccess = (newToken: string, newUser: User) => {
    localStorage.setItem('cosync_token', newToken);
    localStorage.setItem('cosync_user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);

    // Run pending invite
    const pendingInvite = localStorage.getItem('cosync_pending_invite');
    const pendingDocId = localStorage.getItem('cosync_pending_doc_id');
    if (pendingInvite) {
      localStorage.removeItem('cosync_pending_invite');
      localStorage.removeItem('cosync_pending_doc_id');
      joinWorkspaceWithToken(newToken, pendingInvite, pendingDocId || undefined);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('cosync_token');
    localStorage.removeItem('cosync_user');
    setToken(null);
    setUser(null);
    setSelectedDoc(null);
  };

  // Drag resizing handlers
  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = Math.max(200, Math.min(500, e.clientX));
    setSidebarWidth(newWidth);
    localStorage.setItem('cosync_sidebar_width', newWidth.toString());
  };

  const handleMouseUp = () => {
    isResizing.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  return (
    <div className="app-container" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {!token || !user ? (
        <>
          <header className="app-navbar">
            <div className="brand">
              <span>✍️</span>
              <span>CoSync</span>
            </div>
          </header>
          <main style={{ display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
            <Auth onAuthSuccess={handleAuthSuccess} backendUrl={BACKEND_URL} />
          </main>
        </>
      ) : (
        <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
          {isSidebarOpen && (
            <>
              <WorkspaceSelector
                key={workspaceRefreshKey}
                token={token}
                backendUrl={BACKEND_URL}
                username={user.username}
                onLogout={handleLogout}
                onSelectDocument={(workspaceId, documentId, title) => 
                  setSelectedDoc({ workspaceId, documentId, title })
                }
                selectedDocumentId={selectedDoc?.documentId || null}
                width={sidebarWidth}
                theme={theme}
                onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
                onCollapse={() => setIsSidebarOpen(false)}
              />
              
              {/* Draggable Divider */}
              <div onMouseDown={startResizing} className="sidebar-resize-handle" />
            </>
          )}

          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', overflowY: 'auto', position: 'relative' }}>
            {selectedDoc ? (
              <Editor
                key={selectedDoc.documentId}
                token={token}
                workspaceId={selectedDoc.workspaceId}
                documentId={selectedDoc.documentId}
                docTitle={selectedDoc.title}
                backendUrl={BACKEND_URL}
                user={user}
                onBack={() => setSelectedDoc(null)}
                isSidebarOpen={isSidebarOpen}
                onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
              />
            ) : (
              <div style={{ display: 'flex', flex: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: '1rem', padding: '2rem', textAlign: 'center', position: 'relative' }}>
                {!isSidebarOpen && (
                  <button
                    onClick={() => setIsSidebarOpen(true)}
                    className="btn-secondary"
                    style={{
                      position: 'absolute',
                      top: '1.5rem',
                      left: '1.5rem',
                      padding: '0.5rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer'
                    }}
                    title="Show Sidebar"
                  >
                    <Menu size={20} />
                  </button>
                )}
                <span style={{ fontSize: '4.5rem', filter: 'drop-shadow(0 10px 15px rgba(99,102,241,0.25))' }}>✍️</span>
                <h2 style={{ color: 'var(--text-color)', fontWeight: 800, fontSize: '1.75rem', margin: 0 }}>Welcome to CoSync</h2>
                <p style={{ color: 'var(--text-muted)', maxWidth: '400px', margin: 0, fontSize: '1rem', lineHeight: '1.6' }}>Select a document from the left sidebar or create a new workspace to start collaborating in real-time.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
