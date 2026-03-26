/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'motion/react';
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
  Activity,
  ChevronLeft
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

const AudioVisualizer = ({ isActive, color = '#3A3F47', volume = 0 }: { isActive: boolean, color?: string, volume?: number }) => {
  return (
    <div className="flex items-center gap-1.5 h-12">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => (
        <motion.div
          key={i}
          animate={isActive ? { height: [8, (volume / 1.5) + (Math.random() * 20) + 8, 8] } : { height: 8 }}
          transition={{ repeat: Infinity, duration: 0.15, delay: i * 0.01 }}
          style={{ backgroundColor: color }}
          className="w-1.5 rounded-full opacity-90"
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
  const [isVoiceDetected, setIsVoiceDetected] = useState(false);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [noiseCancelling, setNoiseCancelling] = useState(true);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [volume, setVolume] = useState(0);
  const [channels, setChannels] = useState<Channel[]>(MOCK_CHANNELS);
  const [activeMembers, setActiveMembers] = useState<string[]>([]);
  const [speakingMembers, setSpeakingMembers] = useState<Set<string>>(new Set());
  const [showMembersList, setShowMembersList] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginId, setLoginId] = useState('');
  const [loginPw, setLoginPw] = useState('');
  const [teamCode, setTeamCode] = useState('');
  const [authMode, setAuthMode] = useState<'CODE' | 'ADMIN'>('CODE');
  
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
      setActiveSpeaker(`USER_${from.slice(0, 4)}`);
      setSpeakingMembers(prev => new Set(prev).add(from));
    });

    socketRef.current.on('ptt-stop', ({ from }) => {
      setActiveSpeaker(null);
      setSpeakingMembers(prev => {
        const next = new Set(prev);
        next.delete(from);
        return next;
      });
    });

    socketRef.current.on('user-joined', async (userId) => {
      setActiveMembers(prev => [...new Set([...prev, userId])]);
      await createPeerConnection(userId);
    });

    socketRef.current.on('channel-members', async (members: string[]) => {
      setActiveMembers(members);
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
      setActiveMembers(prev => prev.filter(id => id !== userId));
      setSpeakingMembers(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
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
      const stream = event.streams[0];
      remoteStreams.current[userId] = stream;
      const audio = new Audio();
      audio.srcObject = stream;
      audio.play();
    };

    const localStream = audioService.getStream();
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    peerConnections.current[userId] = pc;

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
          const currentVolume = audioService.getVolume();
          setVolume(currentVolume);
          setIsVoiceDetected(currentVolume > 15);
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
      
      if ('vibrate' in navigator) {
        navigator.vibrate(80);
      }

      socketRef.current?.emit('ptt-start');
      setSpeakingMembers(prev => new Set(prev).add(user?.uid || 'me'));
      
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
    setSpeakingMembers(prev => {
      const next = new Set(prev);
      next.delete(user?.uid || 'me');
      return next;
    });
    
    if ('vibrate' in navigator) {
      navigator.vibrate([40, 40]);
    }
  }, [isTalking]);

  const handleDummyLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    
    const isCodeAuth = authMode === 'CODE' && teamCode.length === 6;
    const isAdminAuth = authMode === 'ADMIN' && loginId === 'admin' && loginPw === '1234';

    if (isCodeAuth || isAdminAuth) {
      const mockUser = {
        uid: isCodeAuth ? `GUEST_${teamCode}` : 'ADMIN_UNIT_01',
        displayName: isCodeAuth ? `UNIT_${teamCode}` : 'ADMIN_OPERATOR',
        email: isCodeAuth ? `guest_${teamCode}@twclear.local` : 'admin@twclear.local',
        photoURL: ''
      } as FirebaseUser;
      
      setUser(mockUser);
      setProfile({
        uid: mockUser.uid,
        displayName: mockUser.displayName || '',
        email: mockUser.email || '',
        photoURL: '',
        lastSeen: Timestamp.now(),
        status: 'online'
      });
      setView('CHANNELS');
      
      if ('vibrate' in navigator) {
        navigator.vibrate(100);
      }
    } else {
      setLoginError(authMode === 'CODE' ? 'Invalid 6-digit code.' : 'Invalid Operator ID or Security Key.');
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      if (error.code === 'auth/popup-closed-by-user') {
        setLoginError('Login cancelled. Please try again.');
      } else {
        console.error('Login Error:', error);
        setLoginError('An unexpected error occurred during login.');
      }
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

  const nextChannel = () => {
    const currentIndex = channels.findIndex(c => c.id === activeChannel?.id);
    const nextIndex = (currentIndex + 1) % channels.length;
    selectChannel(channels[nextIndex]);
  };

  const prevChannel = () => {
    const currentIndex = channels.findIndex(c => c.id === activeChannel?.id);
    const prevIndex = (currentIndex - 1 + channels.length) % channels.length;
    selectChannel(channels[prevIndex]);
  };

  // --- Views ---

  const AuthView = () => (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col h-full px-10 justify-center bg-industrial-bg"
    >
      <div className="mb-16 text-center">
        <div className="w-24 h-24 bg-industrial-accent rounded-[32px] mx-auto flex items-center justify-center mb-8 shadow-[0_0_50px_rgba(255,215,0,0.2)] rugged-border">
          <Radio size={48} className="text-black" />
        </div>
        <h1 className="text-4xl font-extrabold tracking-tighter text-white mb-3">T.W CLEAR</h1>
        <p className="status-label">Industrial Mission-Critical PTT</p>
      </div>

      <div className="space-y-6">
        <div className="flex bg-white/5 p-1 rounded-2xl mb-4">
          <button 
            onClick={() => setAuthMode('CODE')}
            className={cn(
              "flex-1 py-3 rounded-xl font-bold text-sm transition-all",
              authMode === 'CODE' ? "bg-industrial-accent text-black" : "text-industrial-muted"
            )}
          >
            TEAM CODE
          </button>
          <button 
            onClick={() => setAuthMode('ADMIN')}
            className={cn(
              "flex-1 py-3 rounded-xl font-bold text-sm transition-all",
              authMode === 'ADMIN' ? "bg-industrial-accent text-black" : "text-industrial-muted"
            )}
          >
            ADMIN LOGIN
          </button>
        </div>

        {authMode === 'CODE' ? (
          <div className="space-y-4">
            <div className="bg-industrial-card border border-white/5 p-6 rounded-3xl text-center rugged-border">
              <Lock className="mx-auto text-industrial-accent mb-3" size={32} />
              <h2 className="text-white font-bold text-lg mb-1 uppercase tracking-tight">Enter Team Access Code</h2>
              <p className="text-industrial-muted text-xs leading-relaxed">Enter your 6-digit deployment code to join the secure network.</p>
            </div>
            <input 
              type="text"
              maxLength={6}
              placeholder="0 0 0 0 0 0"
              value={teamCode}
              onChange={(e) => setTeamCode(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-industrial-card border border-white/10 rounded-2xl py-5 text-center text-3xl font-black tracking-[0.5em] text-industrial-accent placeholder:text-white/5 focus:outline-none focus:border-industrial-accent transition-all"
            />
            <button 
              onClick={handleDummyLogin}
              disabled={teamCode.length !== 6}
              className="w-full bg-industrial-accent text-black font-black py-6 rounded-3xl shadow-2xl hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 transition-all flex items-center justify-center gap-4 text-lg tracking-tighter"
            >
              <Zap size={24} />
              <span>CONNECT TO NETWORK</span>
            </button>
          </div>
        ) : (
          <form onSubmit={handleDummyLogin} className="space-y-4">
            <div className="space-y-3">
              <input 
                type="text"
                placeholder="OPERATOR ID"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                className="w-full bg-industrial-card border border-white/10 rounded-2xl py-4 px-6 text-white font-bold placeholder:text-industrial-muted focus:outline-none focus:border-industrial-accent transition-all"
              />
              <input 
                type="password"
                placeholder="SECURITY KEY"
                value={loginPw}
                onChange={(e) => setLoginPw(e.target.value)}
                className="w-full bg-industrial-card border border-white/10 rounded-2xl py-4 px-6 text-white font-bold placeholder:text-industrial-muted focus:outline-none focus:border-industrial-accent transition-all"
              />
            </div>
            <button 
              type="submit"
              className="w-full bg-industrial-accent text-black font-black py-6 rounded-3xl shadow-2xl hover:brightness-110 active:scale-[0.97] transition-all flex items-center justify-center gap-4 text-lg tracking-tighter"
            >
              <ShieldCheck size={24} />
              <span>AUTHORIZE ACCESS</span>
            </button>
          </form>
        )}

        <div className="relative py-4">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/5"></div></div>
          <div className="relative flex justify-center text-xs uppercase"><span className="bg-industrial-bg px-4 text-industrial-muted font-bold tracking-widest">OR</span></div>
        </div>

        <button 
          onClick={handleLogin}
          className="w-full bg-white/5 border border-white/10 text-white font-bold py-5 rounded-3xl hover:bg-white/10 active:scale-[0.97] transition-all flex items-center justify-center gap-4 text-sm tracking-tight"
        >
          <LogIn size={20} />
          <span>SIGN IN WITH GOOGLE</span>
        </button>

        {loginError && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-industrial-accent text-xs font-mono text-center bg-industrial-accent/10 p-4 rounded-2xl border border-industrial-accent/20"
          >
            {loginError}
          </motion.div>
        )}
      </div>
    </motion.div>
  );

  const ChannelsView = () => (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex flex-col h-full bg-industrial-bg"
    >
      <header className="p-8 border-b border-white/5 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black text-white tracking-tighter uppercase">Channels</h2>
          <p className="status-label">Active Network</p>
        </div>
        <div className="flex items-center gap-4">
          {profile?.photoURL && (
            <img src={profile.photoURL} alt="User" className="w-10 h-10 rounded-2xl border border-white/10" />
          )}
          <button onClick={handleLogout} className="p-3 bg-white/5 rounded-2xl text-industrial-muted hover:text-white transition-colors">
            <LogOut size={24} />
          </button>
        </div>
      </header>

      <div className="p-8">
        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-industrial-muted" size={24} />
          <input 
            type="text" 
            placeholder="SEARCH CHANNELS..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-industrial-card border border-white/10 rounded-3xl py-6 pl-14 pr-6 text-white font-bold placeholder:text-industrial-muted focus:outline-none focus:border-industrial-accent transition-colors text-lg"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-8 space-y-4">
        {channels.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase())).map((channel) => (
          <button
            key={channel.id}
            onClick={() => selectChannel(channel)}
            className="w-full bg-industrial-card border border-white/5 p-6 rounded-[32px] flex items-center justify-between hover:border-industrial-accent/50 transition-all group active:scale-[0.98] rugged-border"
          >
            <div className="flex items-center gap-5">
              <div className={cn(
                "w-16 h-16 rounded-2xl flex items-center justify-center transition-colors",
                channel.status === 'active' ? "bg-industrial-transmitting/20 text-industrial-transmitting" : "bg-white/5 text-industrial-muted"
              )}>
                <Radio size={32} />
              </div>
              <div className="text-left">
                <h3 className="text-xl font-black text-white tracking-tighter uppercase">{channel.name}</h3>
                <div className="flex items-center gap-3 mt-1">
                  <Users size={16} className="text-industrial-muted" />
                  <span className="data-value text-industrial-muted uppercase">{channel.members} ONLINE</span>
                  {channel.status === 'active' && (
                    <span className="flex h-2 w-2 rounded-full bg-industrial-transmitting animate-pulse" />
                  )}
                </div>
              </div>
            </div>
            <ChevronRight size={28} className="text-industrial-muted group-hover:text-white transition-colors" />
          </button>
        ))}
      </div>
    </motion.div>
  );

  const PTTView = () => {
    const x = useMotionValue(0);
    const opacity = useTransform(x, [-100, 0, 100], [0, 1, 0]);

    const handleDragEnd = (event: any, info: any) => {
      if (info.offset.x > 100) {
        prevChannel();
      } else if (info.offset.x < -100) {
        nextChannel();
      }
    };

    return (
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flex flex-col h-full bg-industrial-bg relative"
      >
        {/* Top Header - Massive Glanceability */}
        <header className="px-8 pt-12 pb-8 flex flex-col items-center border-b border-white/5 bg-industrial-card/30 backdrop-blur-2xl">
          <div className="w-full flex items-center justify-between mb-6">
            <button onClick={() => setView('CHANNELS')} className="p-4 -ml-4 bg-white/5 rounded-2xl text-industrial-muted hover:text-white transition-colors">
              <ChevronLeft size={32} />
            </button>
            <div className="flex items-center gap-6">
              <div className="flex flex-col items-end">
                <span className="status-label">SIGNAL</span>
                <div className="flex gap-1 mt-1.5">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className={cn("w-1.5 rounded-full", i <= 3 ? "bg-industrial-transmitting h-4" : "bg-white/10 h-4")} />
                  ))}
                </div>
              </div>
              <div className="flex flex-col items-end">
                <span className="status-label">BATTERY</span>
                <div className="flex items-center gap-2 mt-1">
                  <span className="data-value text-industrial-transmitting">84%</span>
                  <Battery size={20} className="text-industrial-transmitting rotate-90" />
                </div>
              </div>
            </div>
          </div>

          <motion.div 
            style={{ x, opacity }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            onDragEnd={handleDragEnd}
            className="w-full flex flex-col items-center cursor-grab active:cursor-grabbing"
          >
            <div className="flex items-center gap-3 mb-2">
              <Radio size={24} className="text-industrial-accent" />
              <span className="status-label text-industrial-accent">ACTIVE CHANNEL</span>
            </div>
            <h1 className="text-4xl font-black tracking-tighter text-white uppercase text-center leading-none">
              {activeChannel?.name || 'NO CHANNEL'}
            </h1>
            <div className="flex items-center gap-3 mt-4 px-5 py-2 rounded-2xl bg-white/5 border border-white/10">
              <Users size={18} className="text-industrial-muted" />
              <span className="data-value text-industrial-muted uppercase">{activeChannel?.members || 0} MEMBERS IN NETWORK</span>
            </div>
          </motion.div>
          
          <div className="flex justify-between w-full mt-6 px-4">
            <ChevronLeft size={24} className="text-industrial-muted/30 animate-pulse" />
            <span className="status-label opacity-30">SWIPE TO SWITCH</span>
            <ChevronRight size={24} className="text-industrial-muted/30 animate-pulse" />
          </div>
        </header>

        {/* Status Feedback Area */}
        <main className="flex-1 flex flex-col items-center justify-center relative overflow-hidden">
          {/* Dynamic Background Effects */}
          <AnimatePresence>
            {isTalking && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 0.15, scale: 1.5 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-industrial-transmitting rounded-full blur-[120px]"
              />
            )}
            {activeSpeaker && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 0.15, scale: 1.5 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-industrial-receiving rounded-full blur-[120px]"
              />
            )}
          </AnimatePresence>

          <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-10">
            <div className="w-[400px] h-[400px] radial-track" />
            <div className="absolute w-[600px] h-[600px] radial-track opacity-50" />
          </div>

          {/* Status Indicator */}
          <div className="absolute top-12 w-full flex flex-col items-center z-20">
            <AnimatePresence mode="wait">
              {isTalking ? (
                <motion.div
                  key="talking"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="flex flex-col items-center"
                >
                  <div className="px-6 py-2 bg-industrial-transmitting rounded-full mb-4 shadow-[0_0_30px_rgba(0,255,65,0.3)]">
                    <span className="text-black font-black tracking-tighter text-lg uppercase">TRANSMITTING</span>
                  </div>
                  
                  {noiseCancelling && isVoiceDetected && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex items-center gap-3 px-4 py-1.5 rounded-2xl bg-industrial-transmitting/10 border border-industrial-transmitting/30"
                    >
                      <ShieldCheck size={18} className="text-industrial-transmitting" />
                      <span className="data-value text-industrial-transmitting uppercase">AI VOICE ISOLATION ACTIVE</span>
                    </motion.div>
                  )}

                  <div className="mt-8">
                    <AudioVisualizer isActive={true} color="#00FF41" volume={volume} />
                  </div>
                </motion.div>
              ) : activeSpeaker ? (
                <motion.div
                  key="receiving"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="flex flex-col items-center"
                >
                  <div className="px-6 py-2 bg-industrial-receiving rounded-full mb-4 shadow-[0_0_30px_rgba(0,163,255,0.3)]">
                    <span className="text-black font-black tracking-tighter text-lg uppercase">RECEIVING</span>
                  </div>
                  <span className="text-2xl font-black text-white uppercase tracking-tighter mb-4">{activeSpeaker}</span>
                  <div className="mt-4">
                    <AudioVisualizer isActive={true} color="#00A3FF" volume={40} />
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center"
                >
                  <span className="status-label text-industrial-muted text-lg">STANDBY</span>
                  <div className="mt-8">
                    <AudioVisualizer isActive={false} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>

        {/* MASSIVE PTT BUTTON - 1/3 Height */}
        <footer className="h-[35vh] bg-industrial-card border-t-4 border-white/5 relative z-30 flex items-center justify-center px-8 pb-12">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-24 h-2 bg-industrial-muted/20 rounded-full" />
          
          <motion.div
            animate={isTalking ? { scale: [1, 1.03, 1] } : { scale: 1 }}
            transition={{ repeat: Infinity, duration: 1.5 }}
            className="w-full h-full max-w-sm flex items-center justify-center"
          >
            <motion.button
              onMouseDown={handlePTTDown}
              onMouseUp={handlePTTUp}
              onTouchStart={handlePTTDown}
              onTouchEnd={handlePTTUp}
              whileTap={{ scale: 0.94 }}
              className={cn(
                "w-full h-full rounded-[48px] flex flex-col items-center justify-center transition-all duration-300 shadow-2xl rugged-border",
                isTalking 
                  ? "bg-industrial-transmitting text-black ptt-button-glow-transmitting" 
                  : activeSpeaker
                    ? "bg-industrial-receiving/20 text-industrial-receiving border-industrial-receiving/30 ptt-button-glow-receiving"
                    : "bg-industrial-idle text-industrial-muted hover:bg-industrial-idle/80"
              )}
            >
              <div className={cn(
                "w-24 h-24 rounded-full flex items-center justify-center mb-4 transition-colors",
                isTalking ? "bg-black/10" : "bg-white/5"
              )}>
                <Mic size={56} className={cn(isTalking && "animate-pulse")} />
              </div>
              <span className="font-black tracking-tighter text-2xl uppercase">
                {isTalking ? 'RELEASE TO STOP' : 'PUSH TO TALK'}
              </span>
              <div className="mt-4 flex items-center gap-3 opacity-50">
                <Zap size={16} />
                <span className="status-label text-inherit">LOW LATENCY MODE</span>
              </div>
            </motion.button>
          </motion.div>

          {/* Quick Access Controls */}
          <div className="absolute top-4 right-8 flex flex-col gap-4">
            <button 
              onClick={() => setNoiseCancelling(!noiseCancelling)}
              className={cn(
                "p-5 rounded-3xl border transition-all shadow-xl",
                noiseCancelling 
                  ? "bg-industrial-transmitting/10 border-industrial-transmitting/30 text-industrial-transmitting" 
                  : "bg-white/5 border-white/10 text-industrial-muted"
              )}
            >
              <ShieldCheck size={32} />
            </button>
            <button className="p-5 rounded-3xl bg-white/5 border border-white/10 text-industrial-muted shadow-xl">
              <Volume2 size={32} />
            </button>
          </div>
          
          <div className="absolute top-4 left-8">
            <button 
              onClick={() => setShowMembersList(true)}
              className="p-5 rounded-3xl bg-white/5 border border-white/10 text-industrial-muted shadow-xl relative"
            >
              <Users size={32} />
              {activeMembers.length > 0 && (
                <span className="absolute -top-1 -right-1 w-6 h-6 bg-industrial-accent text-black text-[10px] font-black flex items-center justify-center rounded-full border-2 border-industrial-card">
                  {activeMembers.length}
                </span>
              )}
            </button>
          </div>
        </footer>

        {/* Members List Overlay */}
        <AnimatePresence>
          {showMembersList && (
            <>
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowMembersList(false)}
                className="absolute inset-0 bg-black/60 backdrop-blur-sm z-[40]"
              />
              <motion.div 
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="absolute bottom-0 left-0 right-0 bg-industrial-card rounded-t-[48px] border-t-4 border-white/5 z-[50] max-h-[70vh] flex flex-col rugged-border"
              >
                <div className="w-16 h-1.5 bg-white/10 rounded-full mx-auto mt-6 mb-8" />
                
                <div className="px-10 pb-12 flex-1 overflow-y-auto">
                  <div className="flex items-center justify-between mb-8">
                    <div>
                      <h2 className="text-2xl font-black text-white tracking-tighter uppercase">Active Members</h2>
                      <p className="status-label">Channel: {activeChannel?.name}</p>
                    </div>
                    <button 
                      onClick={() => setShowMembersList(false)}
                      className="p-3 bg-white/5 rounded-2xl text-industrial-muted hover:text-white transition-colors"
                    >
                      <ArrowLeft size={24} className="rotate-270" />
                    </button>
                  </div>

                  <div className="space-y-4">
                    {/* Self */}
                    <div className="bg-white/5 p-5 rounded-3xl flex items-center justify-between border border-white/5">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-industrial-accent rounded-2xl flex items-center justify-center text-black">
                          <UserIcon size={24} />
                        </div>
                        <div>
                          <h3 className="text-white font-bold uppercase tracking-tight">YOU (ME)</h3>
                          <span className="status-label text-industrial-transmitting">ONLINE</span>
                        </div>
                      </div>
                      {isTalking && (
                        <div className="flex items-center gap-2 px-3 py-1 bg-industrial-transmitting/20 rounded-full border border-industrial-transmitting/30">
                          <div className="w-2 h-2 bg-industrial-transmitting rounded-full animate-pulse" />
                          <span className="text-[10px] font-black text-industrial-transmitting uppercase">SPEAKING</span>
                        </div>
                      )}
                    </div>

                    {/* Others */}
                    {activeMembers.filter(id => id !== user?.uid).map((userId) => (
                      <div key={userId} className="bg-white/5 p-5 rounded-3xl flex items-center justify-between border border-white/5">
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            "w-12 h-12 rounded-2xl flex items-center justify-center transition-colors",
                            speakingMembers.has(userId) ? "bg-industrial-receiving text-black" : "bg-white/10 text-industrial-muted"
                          )}>
                            <UserIcon size={24} />
                          </div>
                          <div>
                            <h3 className="text-white font-bold uppercase tracking-tight">USER_{userId.slice(0, 6)}</h3>
                            <span className="status-label">REMOTE UNIT</span>
                          </div>
                        </div>
                        {speakingMembers.has(userId) && (
                          <div className="flex items-center gap-2 px-3 py-1 bg-industrial-receiving/20 rounded-full border border-industrial-receiving/30">
                            <div className="w-2 h-2 bg-industrial-receiving rounded-full animate-pulse" />
                            <span className="text-[10px] font-black text-industrial-receiving uppercase">SPEAKING</span>
                          </div>
                        )}
                      </div>
                    ))}

                    {activeMembers.length === 0 && (
                      <div className="py-12 text-center">
                        <Users size={48} className="mx-auto text-white/5 mb-4" />
                        <p className="text-industrial-muted font-bold uppercase tracking-widest text-sm">No other units detected</p>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </motion.div>
    );
  };

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
