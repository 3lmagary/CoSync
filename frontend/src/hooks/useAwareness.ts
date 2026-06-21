import { useEffect, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';

export function useAwareness(wsProvider: WebsocketProvider | null, user: { id: string; username: string; color: string }) {
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [onlineUsers, setOnlineUsers] = useState<any[]>([]);

  console.log("useAwareness Hook user input:", user);

  useEffect(() => {
    if (!wsProvider) {
      console.log("useAwareness: No wsProvider provided yet.");
      return;
    }

    console.log("useAwareness Effect ran. user:", user);

    const handleStatus = ({ status }: { status: any }) => {
      console.log("useAwareness handleStatus status:", status, "user:", user);
      setConnectionStatus(status);
      if (status === 'connected') {
        console.log("Setting local state field 'user' inside handleStatus:", user);
        wsProvider.awareness.setLocalState({
          user: {
            name: user.username,
            color: user.color,
            userId: user.id
          }
        });
        console.log("After setting local state: localState =", wsProvider.awareness.getLocalState(), "clientID =", wsProvider.doc.clientID);
      }
    };

    wsProvider.on('status', handleStatus);

    const handleAwareness = () => {
      const states = wsProvider.awareness.getStates();
      console.log("Awareness states size:", states.size, "Entries:", Array.from(states.entries()).map(([cid, val]: any) => ({ clientId: cid, hasUser: !!val.user, user: val.user })));
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

    console.log("Setting initial local state:", user);
    wsProvider.awareness.setLocalState({
      user: {
        name: user.username,
        color: user.color,
        userId: user.id
      }
    });

    return () => {
      console.log("useAwareness Cleanup function called");
      wsProvider.off('status', handleStatus);
      wsProvider.awareness.off('change', handleAwareness);
    };
  }, [wsProvider, user]);

  return { connectionStatus, onlineUsers };
}
