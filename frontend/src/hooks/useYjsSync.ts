import { useMemo, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

export function useYjsSync({ documentId, workspaceId, token, backendUrl }: { documentId: string; workspaceId: string; token: string; backendUrl: string }) {
  const [localSynced, setLocalSynced] = useState(false);
  const [docSize, setDocSize] = useState<number>(0);
  
  const prevCollabRef = useRef<any>(null);
  const cleanupTimeoutRef = useRef<any>(null);

  const { ydoc, wsProvider, indexeddbProvider } = useMemo(() => {
    if (prevCollabRef.current) {
      console.log('Cleaning up previous Yjs instances...');
      const { ydoc: pDoc, wsProvider: pWs, indexeddbProvider: pIdb } = prevCollabRef.current;
      try {
        if (pIdb) {
          pIdb.destroy();
        }
        pWs.disconnect();
        pWs.destroy();
        pDoc.destroy();
      } catch (err) {
        console.error('Error destroying previous Yjs instances', err);
      }
    }

    const ydoc = new Y.Doc();
    const wsUrl = backendUrl.replace(/^http/, 'ws');
    const roomName = `workspace/${workspaceId}/doc/${documentId}`;
    let indexeddbProvider: any = null;
    try {
      indexeddbProvider = new IndexeddbPersistence(documentId, ydoc);
    } catch (e) {
      console.warn('IndexedDB persistence is not supported or blocked in this environment:', e);
    }

    const wsProvider = new WebsocketProvider(wsUrl, roomName, ydoc, {
      connect: false,
      protocols: ['co-sync-auth', token]
    });

    wsProvider.maxBackoffTime = 30000;

    prevCollabRef.current = { ydoc, wsProvider, indexeddbProvider };

    return { ydoc, wsProvider, indexeddbProvider };
  }, [documentId, workspaceId, token, backendUrl]);

  useEffect(() => {
    // Clear any pending cleanup timeouts if the component is re-mounting or remaining active
    if (cleanupTimeoutRef.current) {
      console.log('Cancelling pending Yjs cleanup/destruction...');
      clearTimeout(cleanupTimeoutRef.current);
      cleanupTimeoutRef.current = null;
    }

    return () => {
      if (prevCollabRef.current) {
        console.log('Scheduling Yjs cleanup/destruction on unmount...');
        const { ydoc: pDoc, wsProvider: pWs, indexeddbProvider: pIdb } = prevCollabRef.current;
        cleanupTimeoutRef.current = setTimeout(() => {
          console.log('Executing final Yjs cleanup/destruction...');
          try {
            if (pIdb) {
              pIdb.destroy();
            }
            pWs.disconnect();
            pWs.destroy();
            pDoc.destroy();
          } catch (err) {
            console.error('Error destroying final Yjs instances', err);
          }
          cleanupTimeoutRef.current = null;
        }, 100);
      }
    };
  }, []);

  useEffect(() => {
    // Intercept send for debugging
    const handleStatusDebug = ({ status }: any) => {
      if (status === 'connected' && wsProvider.ws) {
        const originalSend = wsProvider.ws.send;
        wsProvider.ws.send = function (data: any) {
          try {
            const arr = new Uint8Array(data);
            console.log(`[CLIENT WS SEND]: length=${arr.length}, type=${arr[0]}`);
          } catch (e) {
            console.log(`[CLIENT WS SEND Error checking type]:`, e);
          }
          return originalSend.apply(this, arguments);
        };
      }
    };
    wsProvider.on('status', handleStatusDebug);

    // Connect WebSocket immediately
    wsProvider.connect();
    
    // Set localSynced to true immediately so the editor can start syncing with Yjs right away
    setLocalSynced(true);

    const handleSynced = () => {
      console.log('Local IndexedDB state loaded and synced.');
      const browserClients = ydoc.getArray('browser-clients');
      if (!browserClients.toArray().includes(ydoc.clientID)) {
        browserClients.push([ydoc.clientID]);
      }
    };

    if (indexeddbProvider) {
      if (indexeddbProvider.synced) {
        handleSynced();
      } else {
        indexeddbProvider.on('synced', handleSynced);
      }
    } else {
      // No persistence, sync immediately
      handleSynced();
    }

    return () => {
      wsProvider.off('status', handleStatusDebug);
      if (indexeddbProvider) {
        indexeddbProvider.off('synced', handleSynced);
      }
      wsProvider.disconnect();
    };
  }, [wsProvider, indexeddbProvider, ydoc]);

  useEffect(() => {
    const interval = setInterval(() => {
      const stateUpdate = Y.encodeStateAsUpdate(ydoc);
      setDocSize(stateUpdate.byteLength);
    }, 5000);

    return () => clearInterval(interval);
  }, [ydoc]);

  return { ydoc, wsProvider, indexeddbProvider, localSynced, docSize };
}
