import { io } from 'socket.io-client';

const socket = io(
  import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000',
  {
    transports: ['websocket'],
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.3,
  },
);

export default socket;
