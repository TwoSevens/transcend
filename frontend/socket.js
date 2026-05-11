import { io } from 'socket.io-client';

const socket = io(process.env.REACT_APP_BACKEND_URL || 'http://localhost:5000', {
  transports: ['websocket'],
  autoConnect: true,
  reconnectionAttempts: 5,
});

export default socket;
