import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // --- Signaling & Channel Management ---
  const channels: Record<string, Set<string>> = {}; // channelId -> Set of socketIds
  const socketToChannel: Record<string, string> = {}; // socketId -> channelId

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-channel", (channelId: string) => {
      // Leave previous channel
      if (socketToChannel[socket.id]) {
        const prevChannel = socketToChannel[socket.id];
        channels[prevChannel]?.delete(socket.id);
        socket.leave(prevChannel);
      }

      // Join new channel
      socket.join(channelId);
      if (!channels[channelId]) channels[channelId] = new Set();
      channels[channelId].add(socket.id);
      socketToChannel[socket.id] = channelId;

      console.log(`User ${socket.id} joined channel ${channelId}`);
      
      // Notify others in channel
      socket.to(channelId).emit("user-joined", socket.id);
      
      // Send current members to the new user
      const members = Array.from(channels[channelId]).filter(id => id !== socket.id);
      socket.emit("channel-members", members);
    });

    // WebRTC Signaling
    socket.on("offer", ({ target, offer }) => {
      io.to(target).emit("offer", { from: socket.id, offer });
    });

    socket.on("answer", ({ target, answer }) => {
      io.to(target).emit("answer", { from: socket.id, answer });
    });

    socket.on("ice-candidate", ({ target, candidate }) => {
      io.to(target).emit("ice-candidate", { from: socket.id, candidate });
    });

    // PTT State
    socket.on("ptt-start", () => {
      const channelId = socketToChannel[socket.id];
      if (channelId) {
        socket.to(channelId).emit("ptt-start", { from: socket.id });
      }
    });

    socket.on("ptt-stop", () => {
      const channelId = socketToChannel[socket.id];
      if (channelId) {
        socket.to(channelId).emit("ptt-stop", { from: socket.id });
      }
    });

    socket.on("disconnect", () => {
      const channelId = socketToChannel[socket.id];
      if (channelId) {
        channels[channelId]?.delete(socket.id);
        socket.to(channelId).emit("user-left", socket.id);
      }
      delete socketToChannel[socket.id];
      console.log("User disconnected:", socket.id);
    });
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", message: "SilentConnect Signaling Server is active" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
