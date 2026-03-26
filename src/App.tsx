/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Radio, 
  Mic, 
  Settings, 
  Users, 
  Wifi, 
  Battery, 
  ShieldCheck,
  Volume2,
  Zap,
  LogIn,
  ChevronRight,
  ArrowLeft,
  Search,
  Lock,
  User as UserIcon,
  LogOut,
  Activity
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { io, Socket } from 'socket.io-client';
import { audioService } from './services/audioService';
import { auth, db } from './firebase';
import { 
  onAuthStateChanged, 
  User as FirebaseUser,
  signOut,
  signInWithPopup,
  GoogleAuthProvider
} from "firebase/auth";
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  getDoc, 
  setDoc,
  Timestamp
} from "firebase/firestore";

/**
 * Utility for Tailwind class merging
 */
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
type View = 'AUTH' | 'CHANNELS' | 'PTT';

interface Channel {
  id: string;
  name: string;
  members: number;
  status: 'active' | 'idle';
  description?: string;
}

interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  lastSeen: Timestamp;
  status: 'online' | 'offline';
}

const MOCK_CHANNELS: Channel[] = [
  { id: '1', name: 'MAIN_FORGE_LINE_01', members: 12, status: 'active' },
  { id: '2', name: 'MAINTENANCE_TEAM_A', members: 5, status: 'idle' },
  { id: '3', name: 'LOGISTICS_CENTER_04', members: 8, status: 'idle' },
  { id: '4', name: 'EMERGENCY_BROADCAST', members: 45, status: 'idle' },
];

// --- Components ---

const AudioVisualizer = ({ isActive, color = '#FF4444', volume = 0 }: { isActive: boolean, color?: string, volume?: number }) => {
  return (
    <div className="flex items-center gap-1 h-8">
      {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <motion.div
          key={i}
          animate={isActive ? { height: [4, (volume / 2) + (Math.random() * 10) + 4, 4] } : { height: 4 }}
          transition={{ repeat: Infinity, duration: 0.2, delay: i * 0.02 }}
          style={{ backgroundColor: color }}
          className="w-1 rounded-full opacity-80"
        />
      ))}
    </div>
  );
};

export default function App() {
  const [view, setView] = useState<View>('AUTH');
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isTalking, setIsTalking] = useState(false);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [noiseCancelling, setNoiseCancelling] = useState(true);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [volume, setVolume] = useState(0);
  const [channels, setChannels] = useState<Channel[]>(MOCK_CHANNELS);
  
  const socketRef = useRef<Socket | null>(null);
  const visualizerIntervalRef = useRef<number | null>(null);
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const remoteStreams = useRef<Record<string, MediaStream>>({});

  // Auth State Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists()) {
          const newProfile: UserProfile = {
            uid: firebaseUser.uid,
            displayName: firebaseUser.displayName || 'Anonymous',
            email: firebaseUser.email || '',
            photoURL: firebaseUser.photoURL || '',
            lastSeen: Timestamp.now(),
            status: 'online'
          };
          await setDoc(userRef, newProfile);
          setProfile(newProfile);
        } else {
          setProfile(userSnap.data() as UserProfile);
        }
        
        setView('CHANNELS');
      } else {
        setProfile(null);
        setView('AUTH');
      }
    });

    return () => unsubscribe();
  }, []);

  // Fetch Channels from Firestore
  useEffect(() => {
    if (!user) return;

    const q = query(collection(db, 'channels'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (snapshot.empty) {
        setChannels(MOCK_CHANNELS);
        return;
      }
      const channelList: Channel[] = [];
      snapshot.forEach((doc) => {
        channelList.push({ id: doc.id, ...doc.data() } as Channel);
      });
      setChannels(channelList);
    }, (error) => {
      console.error('Firestore Error (Channels):', error);
    });

    return () => unsubscribe();
  }, [user]);

  // Initialize Socket.io
  useEffect(() => {
    if (!user) return;
    
    socketRef.current = io();

    socketRef.current.on('ptt-start', ({ from }) => {
      setActiveSpeaker(`Remote User (${from.slice(0, 4)})`);
    });

    socketRef.current.on('ptt-stop', () => {
      setActiveSpeaker(null);
    });

    socketRef.current.on('user-joined', async (userId) => {
      console.log('User joined:', userId);
      await createPeerConnection(userId);
    });

    socketRef.current.on('channel-members', async (members: string[]) => {
      for (const userId of members) {
        await createPeerConnection(userId);
      }
    });

    socketRef.current.on('offer', async ({ from, offer }) => {
      const pc = await createPeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.emit('answer', { target: from, answer });
    });

    socketRef.current.on('answer', async ({ from, answer }) => {
      const pc = peerConnections.current[from];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socketRef.current.on('ice-candidate', async ({ from, candidate }) => {
      const pc = peerConnections.current[from];
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socketRef.current.on('user-left', (userId) => {
      if (peerConnections.current[userId]) {
        peerConnections.current[userId].close();
        delete peerConnections.current[userId];
      }
    });

    return () => {
      socketRef.current?.disconnect();
      Object.values(peerConnections.current).forEach(pc => (pc as RTCPeerConnection).close());
    };
  }, [user]);

  const createPeerConnection = async (userId: string) => {
    if (peerConnections.current[userId]) return peerConnections.current[userId];

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('ice-candidate', { target: userId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      console.log('Received remote track from:', userId);
      const stream = event.streams[0];
      remoteStreams.current[userId] = stream;
      
      // Play remote stream
      const audio = new Audio();
      audio.srcObject = stream;
      audio.play();
    };

    // Add local stream if available
    const localStream = audioService.getStream();
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    peerConnections.current[userId] = pc;

    // If we are the one initiating, create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current?.emit('offer', { target: userId, offer });

    return pc;
  };

  // Initialize Audio Service
  useEffect(() => {
    if (view === 'PTT') {
      audioService.initialize().then(() => {
        visualizerIntervalRef.current = window.setInterval(() => {
          setVolume(audioService.getVolume());
        }, 50);
      });
    } else {
      if (visualizerIntervalRef.current) {
        clearInterval(visualizerIntervalRef.current);
      }
      audioService.stop();
    }
    return () => {
      if (visualizerIntervalRef.current) {
        clearInterval(visualizerIntervalRef.current);
      }
      audioService.stop();
    };
  }, [view]);

  useEffect(() => {
    audioService.setNoiseCancelling(noiseCancelling);
  }, [noiseCancelling]);

  const handlePTTDown = useCallback(async () => {
    if (activeSpeaker) return;
    
    try {
      await audioService.initialize();
      setIsTalking(true);
      
      // Haptic feedback
      if ('vibrate' in navigator) {
        navigator.vibrate(50);
      }

      socketRef.current?.emit('ptt-start');
      
      // Add local stream to all peer connections
      const localStream = audioService.getStream();
      if (localStream) {
        Object.values(peerConnections.current).forEach(pc => {
          const peer = pc as RTCPeerConnection;
          localStream.getTracks().forEach(track => {
            const sender = peer.getSenders().find(s => s.track?.kind === track.kind);
            if (sender) {
              sender.replaceTrack(track);
            } else {
              peer.addTrack(track, localStream);
            }
          });
        });
      }
    } catch (error) {
      console.error('Failed to start PTT:', error);
    }
  }, [activeSpeaker]);

  const handlePTTUp = useCallback(() => {
    if (!isTalking) return;

    setIsTalking(false);
    socketRef.current?.emit('ptt-stop');
    
    // Haptic feedback
    if ('vibrate' in navigator) {
      navigator.vibrate([30, 30]);
    }
  }, [isTalking]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Login Error:', error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setView('AUTH');
    } catch (error) {
      console.error('Logout Error:', error);
    }
  };

  const selectChannel = (channel: Channel) => {
    setActiveChannel(channel);
    socketRef.current?.emit('join-channel', channel.id);
    setView('PTT');
  };

  // --- Views ---

  const AuthView = () => (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col h-full px-8 justify-center"
    >
      <div className="mb-12 text-center">
        <div className="w-20 h-20 bg-industrial-accent rounded-3xl mx-auto flex items-center justify-center mb-6 shadow-2xl">
          <Radio size={40} className="text-white" />
        </div>
        <h1 className="text-3xl font-bold tracking-tighter text-white mb-2">SilentConnect</h1>
        <p className="text-industrial-muted text-sm font-mono tracking-widest uppercase">Industrial Mission-Critical PTT</p>
      </div>

      <div className="space-y-6">
        <div className="bg-industrial-card border border-white/5 p-6 rounded-2xl text-center">
          <ShieldCheck className="mx-auto text-industrial-safe mb-4" size={32} />
          <h2 className="text-white font-bold mb-2">Secure Access Protocol</h2>
          <p className="text-industrial-muted text-xs">Please authenticate using your corporate credentials to access the communication network.</p>
        </div>

        <button 
          onClick={handleLogin}
          className="w-full bg-white text-black font-bold py-5 rounded-2xl shadow-xl hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-3"
        >
          <LogIn size={20} />
          <span>SIGN IN WITH GOOGLE</span>
        </button>
      </div>

      <div className="mt-12 text-center">
        <span className="status-label block mb-4">System Status: Operational</span>
        <div className="flex justify-center gap-4">
          <Activity size={24} className="text-industrial-safe opacity-50" />
          <Zap size={24} className="text-industrial-accent opacity-50" />
        </div>
      </div>
    </motion.div>
  );

  const ChannelsView = () => (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex flex-col h-full"
    >
      <header className="p-6 border-b border-white/5 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Channels</h2>
          <p className="text-industrial-muted text-xs font-mono uppercase tracking-widest">Active Network</p>
        </div>
        <div className="flex items-center gap-3">
          {profile?.photoURL && (
            <img src={profile.photoURL} alt="User" className="w-8 h-8 rounded-full border border-white/10" />
          )}
          <button onClick={handleLogout} className="p-2 text-industrial-muted hover:text-white transition-colors">
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <div className="p-6">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-industrial-muted" size={18} />
          <input 
            type="text" 
            placeholder="Search channels..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-industrial-card border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white placeholder:text-industrial-muted focus:outline-none focus:border-industrial-accent transition-colors"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-3">
        {channels.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase())).map((channel) => (
          <button
            key={channel.id}
            onClick={() => selectChannel(channel)}
            className="w-full bg-industrial-card border border-white/5 p-5 rounded-2xl flex items-center justify-between hover:border-industrial-accent/50 transition-all group active:scale-[0.99]"
          >
            <div className="flex items-center gap-4">
              <div className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center transition-colors",
                channel.status === 'active' ? "bg-industrial-accent/20 text-industrial-accent" : "bg-white/5 text-industrial-muted"
              )}>
                <Radio size={24} />
              </div>
              <div className="text-left">
                <h3 className="text-white font-bold tracking-tight">{channel.name}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <Users size={12} className="text-industrial-muted" />
                  <span className="text-industrial-muted text-xs font-mono">{channel.members} ONLINE</span>
                  {channel.status === 'active' && (
                    <span className="flex h-1.5 w-1.5 rounded-full bg-industrial-accent animate-pulse" />
                  )}
                </div>
              </div>
            </div>
            <ChevronRight size={20} className="text-industrial-muted group-hover:text-white transition-colors" />
          </button>
        ))}
      </div>
    </motion.div>
  );

  const PTTView = () => (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      className="flex flex-col h-full"
    >
      {/* Top Header - Status Bar */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/5 bg-industrial-card/50 backdrop-blur-md">
        <button onClick={() => setView('CHANNELS')} className="p-2 -ml-2 text-industrial-muted hover:text-white transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div className="flex flex-col items-center">
          <span className="status-label">System Status</span>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-industrial-safe animate-pulse" />
            <span className="data-value text-industrial-safe uppercase">Connected</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-industrial-muted">
          <Wifi size={14} />
          <Battery size={14} />
        </div>
      </header>

      {/* Channel Info */}
      <section className="px-6 py-8 flex flex-col items-center text-center">
        <div className="flex items-center gap-2 mb-2">
          <Radio size={18} className="text-industrial-muted" />
          <span className="status-label">Active Channel</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white mb-1">
          {activeChannel?.name || 'SELECT CHANNEL'}
        </h1>
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10">
          <Users size={12} className="text-industrial-muted" />
          <span className="data-value text-industrial-muted">{activeChannel?.members || 0} Members Active</span>
        </div>
      </section>

      {/* Main PTT Area */}
      <main className="flex-1 flex flex-col items-center justify-center relative px-6">
        {/* Background Radial Tracks */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
          <div className="w-64 h-64 radial-track" />
          <div className="absolute w-80 h-80 radial-track opacity-50" />
        </div>

        {/* Status Indicator */}
        <div className="absolute top-10 w-full flex flex-col items-center">
          <AnimatePresence mode="wait">
            {isTalking ? (
              <motion.div
                key="talking"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex flex-col items-center"
              >
                <span className="status-label text-industrial-accent">Transmitting</span>
                <div className="mt-2">
                  <AudioVisualizer isActive={true} color="#FF4444" volume={volume} />
                </div>
              </motion.div>
            ) : activeSpeaker ? (
              <motion.div
                key="receiving"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex flex-col items-center"
              >
                <span className="status-label text-industrial-safe">Receiving</span>
                <span className="data-value text-white mt-1">{activeSpeaker}</span>
                <div className="mt-2">
                  <AudioVisualizer isActive={true} color="#00FF00" volume={40} />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center"
              >
                <span className="status-label">Standby Mode</span>
                <div className="mt-2">
                  <AudioVisualizer isActive={false} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* PTT Button */}
        <div className="relative z-10">
          <motion.div
            animate={isTalking ? { scale: [1, 1.05, 1] } : { scale: 1 }}
            transition={{ repeat: Infinity, duration: 2 }}
            className={cn(
              "w-56 h-56 rounded-full border-2 flex items-center justify-center transition-colors duration-300",
              isTalking ? "border-industrial-accent ptt-button-glow" : "border-white/10"
            )}
          >
            <motion.button
              onMouseDown={handlePTTDown}
              onMouseUp={handlePTTUp}
              onTouchStart={handlePTTDown}
              onTouchEnd={handlePTTUp}
              whileTap={{ scale: 0.92 }}
              className={cn(
                "w-48 h-48 rounded-full flex flex-col items-center justify-center transition-all duration-200 shadow-2xl",
                isTalking 
                  ? "bg-industrial-accent text-white" 
                  : "bg-industrial-card text-industrial-muted hover:bg-white/5"
              )}
            >
              <Mic size={48} className={cn("mb-2", isTalking && "animate-pulse")} />
              <span className="font-bold tracking-widest text-sm">PUSH TO TALK</span>
            </motion.button>
          </motion.div>
        </div>
      </main>

      {/* Bottom Controls */}
      <footer className="px-6 py-8 bg-industrial-card/80 backdrop-blur-xl border-t border-white/5 rounded-t-[32px]">
        <div className="grid grid-cols-2 gap-4">
          <button 
            onClick={() => setNoiseCancelling(!noiseCancelling)}
            className={cn(
              "flex flex-col items-center justify-center p-4 rounded-2xl border transition-all",
              noiseCancelling 
                ? "bg-industrial-safe/10 border-industrial-safe/30 text-industrial-safe" 
                : "bg-white/5 border-white/10 text-industrial-muted"
            )}
          >
            <ShieldCheck size={20} className="mb-2" />
            <span className="status-label text-inherit">AI Noise Cancel</span>
            <span className="data-value mt-1">{noiseCancelling ? 'ACTIVE' : 'DISABLED'}</span>
          </button>

          <button className="flex flex-col items-center justify-center p-4 rounded-2xl bg-white/5 border border-white/10 text-industrial-muted hover:bg-white/10 transition-all">
            <Zap size={20} className="mb-2" />
            <span className="status-label text-inherit">Audio Profile</span>
            <span className="data-value mt-1">INDUSTRIAL_MAX</span>
          </button>
        </div>

        <div className="flex items-center justify-between mt-8 px-2">
          <button className="p-3 rounded-full bg-white/5 text-industrial-muted hover:text-white transition-colors">
            <Settings size={20} />
          </button>
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <span className="status-label">Signal</span>
              <div className="flex gap-0.5 mt-1">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className={cn("w-1 rounded-full", i <= 3 ? "bg-industrial-safe h-3" : "bg-white/10 h-3")} />
                ))}
              </div>
            </div>
            <button className="p-3 rounded-full bg-white/5 text-industrial-muted hover:text-white transition-colors">
              <Volume2 size={20} />
            </button>
          </div>
        </div>
      </footer>
    </motion.div>
  );

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-industrial-bg overflow-hidden select-none">
      <AnimatePresence mode="wait">
        {view === 'AUTH' && <AuthView key="auth" />}
        {view === 'CHANNELS' && <ChannelsView key="channels" />}
        {view === 'PTT' && <PTTView key="ptt" />}
      </AnimatePresence>
    </div>
  );
}
