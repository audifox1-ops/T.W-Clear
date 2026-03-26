/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'motion/react';
import { 
  Radio, 
  Mic, 
  Settings, 
  Users, 
  Battery, 
  ShieldCheck,
  Volume2,
  Zap,
  LogOut,
  ChevronLeft,
  ChevronRight,
  User as UserIcon
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import mqtt, { MqttClient } from 'mqtt';
import { audioService } from './services/audioService';

/**
 * Tailwind 클래스 병합 유틸리티
 */
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- 타입 정의 ---
type View = 'AUTH' | 'PTT';

interface UserProfile {
  name: string;
  group: string;
}

// 작업조 목록 업데이트
const AVAILABLE_GROUPS = ['P15', 'P5', 'R/M', '절단', '열처리', '출하', '공무', '기타'];

// --- 컴포넌트 ---

/**
 * 오디오 시각화 컴포넌트
 */
const AudioVisualizer = ({ isActive, color = '#3A3F47', volume = 0 }: { isActive: boolean, color?: string, volume?: number }) => {
  return (
    <div className="flex items-center gap-2 h-16">
      {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <motion.div
          key={i}
          animate={isActive ? { height: [12, (volume / 1.2) + (Math.random() * 30) + 12, 12] } : { height: 12 }}
          transition={{ repeat: Infinity, duration: 0.15, delay: i * 0.02 }}
          style={{ backgroundColor: color }}
          className="w-2 rounded-full opacity-90"
        />
      ))}
    </div>
  );
};

/**
 * 상대방 오디오 증폭 컴포넌트 (GainNode 활용)
 */
interface RemoteAudioProps {
  stream: MediaStream;
  volumeMultiplier: number;
}

const RemoteAudio: React.FC<RemoteAudioProps & { onBlocked?: (blocked: boolean) => void }> = ({ stream, volumeMultiplier, onBlocked }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const destNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // 스피커 출력 강제 전환 (setSinkId)
  const forceSpeakerOutput = useCallback(async (element: HTMLAudioElement) => {
    if (!('setSinkId' in element)) {
      console.warn('이 브라우저는 setSinkId를 지원하지 않습니다.');
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
      
      // 'speaker', 'loudspeaker', 'built-in speaker' 등의 키워드가 포함된 장치 찾기
      const speaker = audioOutputs.find(device => 
        device.label.toLowerCase().includes('speaker') || 
        device.label.toLowerCase().includes('loudspeaker') ||
        device.label.toLowerCase().includes('스피커')
      ) || audioOutputs[0]; // 못 찾으면 첫 번째 출력 장치 선택

      if (speaker) {
        await (element as any).setSinkId(speaker.deviceId);
        console.log(`오디오 출력을 다음 장치로 설정함: ${speaker.label}`);
      }
    } catch (err) {
      console.error('스피커 전환 중 오류 발생:', err);
    }
  }, []);

  const attemptPlay = useCallback(async () => {
    if (audioRef.current) {
      try {
        await audioRef.current.play();
        if (onBlocked) onBlocked(false);
        console.log('Remote audio playback started successfully.');
      } catch (err) {
        console.warn('Remote audio playback blocked by browser:', err);
        if (onBlocked) onBlocked(true);
      }
    }
  }, [onBlocked]);

  useEffect(() => {
    if (!stream) return;

    const ctx = audioService.getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    // Web Audio API를 통한 강제 증폭
    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    
    // 초기 볼륨 설정
    const initialGain = volumeMultiplier * 3.0;
    gainNode.gain.setTargetAtTime(initialGain, ctx.currentTime, 0.01);
    
    // MediaStreamAudioDestinationNode를 사용하여 증폭된 스트림 생성
    const dest = ctx.createMediaStreamDestination();
    
    source.connect(gainNode);
    gainNode.connect(dest);

    sourceNodeRef.current = source;
    gainNodeRef.current = gainNode;
    destNodeRef.current = dest;

    if (audioRef.current) {
      // 증폭된 스트림을 오디오 태그에 연결
      audioRef.current.srcObject = dest.stream;
      forceSpeakerOutput(audioRef.current);
      attemptPlay();
    }

    return () => {
      source.disconnect();
      gainNode.disconnect();
      gainNodeRef.current = null;
    };
  }, [stream, forceSpeakerOutput, attemptPlay]);

  useEffect(() => {
    if (gainNodeRef.current) {
      const ctx = gainNodeRef.current.context;
      const targetGain = volumeMultiplier * 3.0;
      gainNodeRef.current.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.01);
    }
  }, [volumeMultiplier]);

  return (
    <audio
      ref={audioRef}
      autoPlay={true}
      playsInline={true}
      muted={false} // 절대 음소거되지 않아야 함 (상대방 목소리)
      style={{ display: 'none' }}
      onLoadedMetadata={() => {
        if (audioRef.current) {
          audioRef.current.volume = 1.0; // HTML 오디오 볼륨 최대치
          forceSpeakerOutput(audioRef.current);
          attemptPlay();
        }
      }}
    />
  );
};

/**
 * 내 마이크 오디오 컴포넌트 (에코 방지를 위해 반드시 muted 처리)
 */
const LocalAudio = ({ stream }: { stream: MediaStream | null }) => {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      muted={true} // 내 목소리가 내 스피커로 나가지 않도록 음소거
      style={{ display: 'none' }}
    />
  );
};

export default function App() {
  const [view, setView] = useState<View>('AUTH');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isTalking, setIsTalking] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);
  const [noiseCancelling, setNoiseCancelling] = useState(true);
  const [activeMembers, setActiveMembers] = useState<string[]>([]);
  const [showMembersList, setShowMembersList] = useState(false);
  const [incomingVolume, setIncomingVolume] = useState(0.8);
  const [showVolumeControl, setShowVolumeControl] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isAudioBlocked, setIsAudioBlocked] = useState(false);
  
  // 로그인 입력 상태
  const [inputName, setInputName] = useState('');
  const [inputGroup, setInputGroup] = useState(AVAILABLE_GROUPS[0]);

  // WebRTC 및 MQTT 상태
  const clientId = useMemo(() => Math.random().toString(36).substring(2, 15), []);
  const mqttClientRef = useRef<MqttClient | null>(null);
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const visualizerIntervalRef = useRef<number | null>(null);
  
  // Screen Wake Lock 상태 관리
  const wakeLockRef = useRef<any>(null);

  const requestWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        console.log('Screen Wake Lock is active');
        
        wakeLockRef.current.addEventListener('release', () => {
          console.log('Screen Wake Lock was released');
        });
      } catch (err: any) {
        console.error(`Wake Lock Error: ${err.name}, ${err.message}`);
      }
    } else {
      console.error('Wake Lock API not supported in this browser');
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      } catch (err: any) {
        console.error(`Wake Lock Release Error: ${err.name}, ${err.message}`);
      }
    }
  }, []);

  // 화면 꺼짐 방지 로직 (PTT 뷰 진입 시 활성화)
  useEffect(() => {
    if (view === 'PTT') {
      requestWakeLock();

      const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible' && view === 'PTT') {
          requestWakeLock();
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        releaseWakeLock();
      };
    } else {
      releaseWakeLock();
    }
  }, [view, requestWakeLock, releaseWakeLock]);

  // 사용자 퇴장 처리
  const handleUserLeft = useCallback((userId: string) => {
    setActiveMembers(prev => prev.filter(id => id !== userId));
    setRemoteStreams(prev => {
      const newStreams = { ...prev };
      delete newStreams[userId];
      return newStreams;
    });
    if (peerConnections.current[userId]) {
      peerConnections.current[userId].close();
      delete peerConnections.current[userId];
    }
  }, []);

  // WebRTC PeerConnection 생성
  const createPeerConnection = useCallback(async (targetId: string, isInitiator: boolean, channelTopic: string) => {
    if (peerConnections.current[targetId]) return peerConnections.current[targetId];

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ]
    });

    peerConnections.current[targetId] = pc;

    // ★ 중요: 늦게 트랙이 추가될 때를 대비한 재협상 로직
    pc.onnegotiationneeded = async () => {
      try {
        if (isInitiator) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (mqttClientRef.current) {
            mqttClientRef.current.publish(`twclear/peer/${targetId}`, JSON.stringify({
              type: 'offer',
              from: clientId,
              offer
            }));
          }
        }
      } catch (err) {
        console.error('재협상 에러:', err);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && mqttClientRef.current) {
        mqttClientRef.current.publish(`twclear/peer/${targetId}`, JSON.stringify({
          type: 'ice-candidate',
          from: clientId,
          candidate: event.candidate
        }));
      }
    };

    pc.ontrack = (event) => {
      setRemoteStreams(prev => ({
        ...prev,
        [targetId]: event.streams[0]
      }));
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        handleUserLeft(targetId);
      }
    };

    // 항상 최신의 단일 스트림(singleton) 객체를 가져옵니다.
    const stream = audioService.getStream();
    if (stream) {
      const senders = pc.getSenders();
      stream.getTracks().forEach(track => {
        const alreadyAdded = senders.some(s => s.track === track);
        if (!alreadyAdded) {
          pc.addTrack(track, stream);
        }
      });
    }

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      mqttClientRef.current?.publish(`twclear/peer/${targetId}`, JSON.stringify({
        type: 'offer',
        from: clientId,
        offer
      }));
    }

    return pc;
  }, [clientId, handleUserLeft]);

  // 소켓 및 WebRTC 초기화
  const initializeNetwork = useCallback((userName: string, userGroup: string) => {
    if (mqttClientRef.current) {
      mqttClientRef.current.end();
    }
    
    const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt');
    mqttClientRef.current = client;

    const channelTopic = `twclear/channel/${userGroup}`;
    const peerTopic = `twclear/peer/${clientId}`;

    client.on('connect', () => {
      client.subscribe([channelTopic, peerTopic]);
      client.publish(channelTopic, JSON.stringify({ type: 'join', from: clientId, name: userName }));
    });

    client.on('message', async (topic, message) => {
      try {
        const data = JSON.parse(message.toString());
        
        if (topic === channelTopic) {
          if (data.type === 'join' && data.from !== clientId) {
            setActiveMembers(prev => [...new Set([...prev, data.from])]);
            await createPeerConnection(data.from, true, channelTopic);
            client.publish(`twclear/peer/${data.from}`, JSON.stringify({ type: 'hello', from: clientId, name: userName }));
          } else if (data.type === 'ptt-start' && data.from !== clientId) {
            setActiveSpeaker(data.name);
            audioService.playBeep();
          } else if (data.type === 'ptt-stop' && data.from !== clientId) {
            setActiveSpeaker(null);
          } else if (data.type === 'leave' && data.from !== clientId) {
            handleUserLeft(data.from);
          }
        } else if (topic === peerTopic) {
          if (data.type === 'hello') {
            setActiveMembers(prev => [...new Set([...prev, data.from])]);
          } else if (data.type === 'offer') {
            setActiveMembers(prev => [...new Set([...prev, data.from])]);
            const pc = await createPeerConnection(data.from, false, channelTopic);
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            client.publish(`twclear/peer/${data.from}`, JSON.stringify({
              type: 'answer',
              from: clientId,
              answer
            }));
          } else if (data.type === 'answer') {
            const pc = peerConnections.current[data.from];
            if (pc) {
              await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
          } else if (data.type === 'ice-candidate') {
            const pc = peerConnections.current[data.from];
            if (pc) {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
          }
        }
      } catch (err) {
        console.error('MQTT message error:', err);
      }
    });
  }, [clientId, createPeerConnection, handleUserLeft]);

  // 자동 접속 (Session Persistence) - 의존성 배열을 비워 한 번만 실행되도록 수정
  useEffect(() => {
    const saved = localStorage.getItem('twclear_session');
    if (saved && view === 'AUTH') {
      try {
        const parsed = JSON.parse(saved);
        setProfile(parsed);
        setInputName(parsed.name);
        setInputGroup(parsed.group);
        
        // ★ 중요: 자동 로그인 시에도 오디오를 완전히 세팅한 뒤에 네트워크 연결
        audioService.unlockAudio().then(() => {
          audioService.initialize().then(() => {
            const stream = audioService.getStream();
            if (stream) {
              // 최초 접속 시 마이크를 꺼둡니다. (PTT를 누를 때만 활성화)
              stream.getAudioTracks().forEach(track => track.enabled = false);
              setLocalStream(stream);
            }
            initializeNetwork(parsed.name, parsed.group);
            setView('PTT');
          });
        });
      } catch (e) {
        localStorage.removeItem('twclear_session');
      }
    }
  }, []); // 의존성 배열 비움 (마운트 시 단 1회 실행)

  // 오디오 시각화 및 클린업 관리
  useEffect(() => {
    if (view === 'PTT' && localStream) {
      visualizerIntervalRef.current = window.setInterval(() => {
        setVolume(audioService.getVolume());
      }, 50);
    } else {
      if (visualizerIntervalRef.current) clearInterval(visualizerIntervalRef.current);
    }

    return () => {
      if (visualizerIntervalRef.current) clearInterval(visualizerIntervalRef.current);
    };
  }, [view, localStream]);

  // 페이지 종료 시 클린업
  useEffect(() => {
    return () => {
      audioService.stop();
      if (mqttClientRef.current && profile) {
        mqttClientRef.current.publish(`twclear/channel/${profile.group}`, JSON.stringify({ type: 'leave', from: clientId }));
        mqttClientRef.current.end();
      }
    };
  }, [clientId, profile]);

  // 수동 접속 핸들러
  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputName || !inputGroup) return;

    // 오디오 컨텍스트 활성화 및 브라우저 권한 즉시 획득
    await audioService.unlockAudio();
    await audioService.initialize();
    
    const stream = audioService.getStream();
    if (stream) {
      // 최초 접속 시 마이크를 꺼둡니다.
      stream.getAudioTracks().forEach(track => track.enabled = false);
      setLocalStream(stream);
    }

    const newProfile = { name: inputName, group: inputGroup };
    setProfile(newProfile);
    localStorage.setItem('twclear_session', JSON.stringify(newProfile));
    
    // 오디오 준비 완료 후 네트워크 접속
    initializeNetwork(inputName, inputGroup);
    setView('PTT');

    if ('vibrate' in navigator) navigator.vibrate(100);
  };

  // 로그아웃 핸들러
  const handleLogout = () => {
    localStorage.removeItem('twclear_session');
    if (mqttClientRef.current && profile) {
      mqttClientRef.current.publish(`twclear/channel/${profile.group}`, JSON.stringify({ type: 'leave', from: clientId }));
      mqttClientRef.current.end();
      mqttClientRef.current = null;
    }
    audioService.stop();
    setProfile(null);
    setLocalStream(null);
    setView('AUTH');
    setActiveMembers([]);
    setRemoteStreams({});
    (Object.values(peerConnections.current) as RTCPeerConnection[]).forEach(pc => pc.close());
    peerConnections.current = {};
    if ('vibrate' in navigator) navigator.vibrate(50);
  };

  // 작업조 변경 핸들러
  const switchGroup = (direction: 'next' | 'prev') => {
    if (!profile) return;
    
    if (mqttClientRef.current) {
      mqttClientRef.current.publish(`twclear/channel/${profile.group}`, JSON.stringify({ type: 'leave', from: clientId }));
    }

    const currentIndex = AVAILABLE_GROUPS.indexOf(profile.group);
    let nextIndex;
    
    if (direction === 'next') {
      nextIndex = (currentIndex + 1) % AVAILABLE_GROUPS.length;
    } else {
      nextIndex = (currentIndex - 1 + AVAILABLE_GROUPS.length) % AVAILABLE_GROUPS.length;
    }
    
    const newGroup = AVAILABLE_GROUPS[nextIndex];
    const newProfile = { ...profile, group: newGroup };
    
    setProfile(newProfile);
    localStorage.setItem('twclear_session', JSON.stringify(newProfile));
    setActiveMembers([]);
    setActiveSpeaker(null);
    setRemoteStreams({});
    
    (Object.values(peerConnections.current) as RTCPeerConnection[]).forEach(pc => pc.close());
    peerConnections.current = {};
    
    initializeNetwork(profile.name, newGroup);
    
    if ('vibrate' in navigator) navigator.vibrate(50);
  };

  // 무전 시작/종료 핸들러 (중복 방지 및 강제 종료 로직 포함)
  const handlePTTStart = useCallback((e?: any) => {
    if (e && e.cancelable) e.preventDefault(); // 터치와 마우스 이벤트 동시 발생 방지
    if (activeSpeaker || !localStream || isTalking) return;
    
    try {
      // 내 마이크 트랙 전송 스위치 ON
      localStream.getAudioTracks().forEach(track => {
        track.enabled = true;
      });
      
      audioService.setTalking(true);
      setIsTalking(true);
      if (mqttClientRef.current && profile) {
        mqttClientRef.current.publish(`twclear/channel/${profile.group}`, JSON.stringify({ 
          type: 'ptt-start', 
          from: clientId, 
          name: profile.name 
        }));
      }
      if ('vibrate' in navigator) navigator.vibrate(80);
    } catch (err) {
      console.error('PTT 시작 실패:', err);
    }
  }, [activeSpeaker, clientId, profile, localStream, isTalking]);

  const handlePTTEnd = useCallback((e?: any) => {
    if (e && e.cancelable) e.preventDefault();
    if (!isTalking || !localStream) return;
    
    // 내 마이크 트랙 전송 스위치 OFF (즉시 음소거)
    localStream.getAudioTracks().forEach(track => {
      track.enabled = false;
    });

    audioService.setTalking(false);
    setIsTalking(false);
    if (mqttClientRef.current && profile) {
      mqttClientRef.current.publish(`twclear/channel/${profile.group}`, JSON.stringify({ 
        type: 'ptt-stop', 
        from: clientId 
      }));
    }
    if ('vibrate' in navigator) navigator.vibrate([40, 40]);
  }, [isTalking, clientId, profile, localStream]);

  // --- 뷰 렌더링 로직 ---

  const dragX = useMotionValue(0);
  const opacity = useTransform(dragX, [-100, 0, 100], [0, 1, 0]);

  const handleDragEnd = (event: any, info: any) => {
    if (info.offset.x > 100) {
      switchGroup('prev');
    } else if (info.offset.x < -100) {
      switchGroup('next');
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-industrial-bg overflow-hidden select-none">
      {/* 내 마이크 오디오 (에코 방지를 위해 반드시 muted 처리) */}
      <LocalAudio stream={localStream} />

      {/* 상대방 오디오 증폭 재생 (GainNode + Autoplay Policy 우회) */}
      {(Object.entries(remoteStreams) as [string, MediaStream][]).map(([id, stream]) => (
        <RemoteAudio 
          key={id} 
          stream={stream} 
          volumeMultiplier={incomingVolume} 
          onBlocked={setIsAudioBlocked}
        />
      ))}

      {/* 오디오 자동재생 차단 시 복구 UI */}
      <AnimatePresence>
        {isAudioBlocked && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-8"
          >
            <div className="text-center">
              <div className="w-20 h-20 bg-industrial-accent rounded-full mx-auto flex items-center justify-center mb-6 animate-bounce">
                <Volume2 size={40} className="text-black" />
              </div>
              <h2 className="text-2xl font-black text-white mb-4">오디오 재생이 차단되었습니다</h2>
              <p className="text-industrial-muted mb-8">브라우저 정책에 의해 소리가 들리지 않을 수 있습니다.<br/>아래 버튼을 눌러 소리를 활성화해주세요.</p>
              <button
                onClick={async () => {
                  await audioService.unlockAudio();
                  setIsAudioBlocked(false);
                  if ('vibrate' in navigator) navigator.vibrate(100);
                }}
                className="w-full bg-industrial-accent text-black font-black py-6 rounded-2xl text-xl shadow-[0_0_30px_rgba(255,215,0,0.4)]"
              >
                소리 활성화하기
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {view === 'AUTH' ? (
          <motion.div 
            key="auth"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col h-full px-8 justify-center bg-industrial-bg"
          >
            <div className="mb-12 text-center">
              <div className="w-24 h-24 bg-industrial-accent rounded-[32px] mx-auto flex items-center justify-center mb-6 shadow-[0_0_40px_rgba(255,215,0,0.3)] rugged-border">
                <Radio size={48} className="text-black" />
              </div>
              <h1 className="text-5xl font-black tracking-tighter text-white mb-2">T.W CLEAR</h1>
              <p className="status-label text-industrial-accent">산업 현장 스마트 무전 시스템</p>
            </div>

            <form onSubmit={handleJoin} className="space-y-6">
              <div className="space-y-4">
                <div>
                  <label className="status-label mb-2 block ml-2">사용자 정보</label>
                  <input 
                    type="text"
                    placeholder="이름 또는 직급 입력"
                    value={inputName}
                    onChange={(e) => setInputName(e.target.value)}
                    className="w-full bg-industrial-card border-2 border-white/10 rounded-3xl py-6 px-8 text-2xl font-bold text-white placeholder:text-industrial-muted focus:outline-none focus:border-industrial-accent transition-all"
                  />
                </div>
                <div>
                  <label className="status-label mb-2 block ml-2">초기 작업조 선택</label>
                  <div className="grid grid-cols-4 gap-2">
                    {AVAILABLE_GROUPS.map(group => (
                      <button
                        key={group}
                        type="button"
                        onClick={() => setInputGroup(group)}
                        className={cn(
                          "py-3 rounded-xl font-bold transition-all border-2 text-sm",
                          inputGroup === group 
                            ? "bg-industrial-accent text-black border-industrial-accent" 
                            : "bg-white/5 text-industrial-muted border-transparent"
                        )}
                      >
                        {group}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <button 
                type="submit"
                disabled={!inputName || !inputGroup}
                className="w-full bg-industrial-accent text-black font-black py-8 rounded-[32px] shadow-2xl hover:brightness-110 active:scale-[0.97] disabled:opacity-30 transition-all text-2xl tracking-tighter"
              >
                현장 접속하기
              </button>
            </form>
          </motion.div>
        ) : (
          <motion.div 
            key="ptt"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col h-full bg-industrial-bg relative"
          >
            {/* 상단 헤더 */}
            <header className="px-8 pt-10 pb-6 flex flex-col items-center border-b border-white/5 bg-industrial-card/50 backdrop-blur-xl">
              <div className="w-full flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-industrial-accent rounded-xl flex items-center justify-center text-black">
                    <Radio size={24} />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-white leading-none">T.W CLEAR</h2>
                    <span className="status-label text-industrial-accent">온라인</span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex flex-col items-end">
                    <span className="status-label">배터리</span>
                    <div className="flex items-center gap-1 text-industrial-transmitting">
                      <span className="data-value">85%</span>
                      <Battery size={18} className="rotate-90" />
                    </div>
                  </div>
                  <button 
                    onClick={handleLogout}
                    className="p-3 bg-white/5 rounded-xl text-industrial-muted hover:text-industrial-accent transition-colors"
                  >
                    <LogOut size={20} />
                  </button>
                </div>
              </div>

              {/* 작업조 스위처 (스와이프 가능) */}
              <div className="w-full relative">
                <motion.div 
                  drag="x"
                  dragConstraints={{ left: 0, right: 0 }}
                  style={{ x: dragX, opacity }}
                  onDragEnd={handleDragEnd}
                  className="w-full bg-white/5 rounded-2xl p-4 flex items-center justify-between border border-white/10 cursor-grab active:cursor-grabbing"
                >
                  <button onClick={() => switchGroup('prev')} className="p-2 text-industrial-muted hover:text-white">
                    <ChevronLeft size={32} />
                  </button>
                  
                  <div className="flex flex-col items-center flex-1">
                    <span className="status-label text-[10px]">현재 작업조 (좌우 스와이프)</span>
                    <span className="text-3xl font-black text-white uppercase tracking-tighter">{profile?.group}</span>
                  </div>

                  <button onClick={() => switchGroup('next')} className="p-2 text-industrial-muted hover:text-white">
                    <ChevronRight size={32} />
                  </button>
                </motion.div>
                
                <div className="flex justify-center gap-1 mt-2">
                  {AVAILABLE_GROUPS.map(g => (
                    <div key={g} className={cn("w-1.5 h-1.5 rounded-full", profile?.group === g ? "bg-industrial-accent" : "bg-white/10")} />
                  ))}
                </div>
              </div>
            </header>

            {/* 상태 표시 영역 */}
            <main className="flex-1 flex flex-col items-center justify-center relative">
              <AnimatePresence>
                {isTalking && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 0.2, scale: 1.5 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-industrial-transmitting rounded-full blur-[100px]"
                  />
                )}
                {activeSpeaker && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 0.2, scale: 1.5 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-industrial-receiving rounded-full blur-[100px]"
                  />
                )}
              </AnimatePresence>

              <div className="z-10 flex flex-col items-center">
                {isTalking ? (
                  <div className="flex flex-col items-center">
                    <div className="px-8 py-3 bg-industrial-transmitting rounded-full mb-6 shadow-[0_0_40px_rgba(0,255,65,0.4)]">
                      <span className="text-black font-black text-2xl">방송 중...</span>
                    </div>
                    <AudioVisualizer isActive={true} color="#00FF41" volume={volume} />
                  </div>
                ) : activeSpeaker ? (
                  <div className="flex flex-col items-center">
                    <div className="px-8 py-3 bg-industrial-receiving rounded-full mb-6 shadow-[0_0_40px_rgba(0,163,255,0.4)]">
                      <span className="text-black font-black text-2xl">수신 중...</span>
                    </div>
                    <span className="text-3xl font-black text-white mb-4 uppercase">{activeSpeaker}</span>
                    <AudioVisualizer isActive={true} color="#00A3FF" volume={40} />
                  </div>
                ) : (
                  <div className="flex flex-col items-center opacity-40">
                    <span className="text-2xl font-bold text-industrial-muted mb-6">대기 중</span>
                    <AudioVisualizer isActive={false} />
                  </div>
                )}
              </div>
            </main>

            {/* 거대 PTT 버튼 */}
            <footer className="h-[45vh] bg-industrial-card border-t-4 border-white/5 flex items-center justify-center px-10 pb-12 relative">
              <div className="absolute top-4 left-1/2 -translate-x-1/2 w-16 h-1.5 bg-white/10 rounded-full" />
              
              <motion.button
                onMouseDown={handlePTTStart}
                onMouseUp={handlePTTEnd}
                onMouseLeave={handlePTTEnd}    // ★ 마우스 이탈 시 강제 종료
                onTouchStart={handlePTTStart}
                onTouchEnd={handlePTTEnd}
                onTouchCancel={handlePTTEnd}   // ★ 터치 취소(스크롤 등) 시 강제 종료
                whileTap={{ scale: 0.92 }}
                className={cn(
                  "w-full aspect-square max-w-[320px] rounded-full flex flex-col items-center justify-center transition-all duration-300 shadow-2xl rugged-border relative overflow-hidden",
                  isTalking 
                    ? "bg-industrial-transmitting text-black scale-105" 
                    : activeSpeaker
                      ? "bg-industrial-receiving/20 text-industrial-receiving border-industrial-receiving/40"
                      : "bg-industrial-idle text-industrial-muted"
                )}
              >
                {isTalking && (
                  <motion.div 
                    animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                    className="absolute inset-0 bg-white/20"
                  />
                )}
                
                <div className={cn(
                  "w-32 h-32 rounded-full flex items-center justify-center mb-6 transition-colors",
                  isTalking ? "bg-black/10" : "bg-white/5"
                )}>
                  <Mic size={80} className={cn(isTalking && "animate-pulse")} />
                </div>
                
                <span className="font-black text-4xl tracking-tighter">
                  {isTalking ? '방송 중' : '누르고 말하기'}
                </span>
                
                <div className="mt-4 flex items-center gap-2 opacity-50">
                  <Zap size={18} />
                  <span className="status-label text-inherit">실시간 연결됨</span>
                </div>
              </motion.button>

              {/* 보조 컨트롤 */}
              <div className="absolute top-8 right-8 flex flex-col gap-4">
                <div className="relative">
                  <AnimatePresence>
                    {showVolumeControl && (
                      <motion.div
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        className="absolute right-16 top-0 bg-industrial-card border border-white/10 p-4 rounded-2xl shadow-2xl flex items-center gap-4 w-48"
                      >
                        <Volume2 size={20} className="text-industrial-muted" />
                        <input 
                          type="range" 
                          min="0" 
                          max="1" 
                          step="0.01" 
                          value={incomingVolume}
                          onChange={(e) => setIncomingVolume(parseFloat(e.target.value))}
                          className="flex-1 accent-industrial-accent"
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <button 
                    onClick={() => setShowVolumeControl(!showVolumeControl)}
                    className={cn(
                      "p-4 rounded-2xl border transition-all",
                      showVolumeControl ? "bg-industrial-accent text-black border-industrial-accent" : "bg-white/5 border-white/10 text-industrial-muted"
                    )}
                  >
                    <Volume2 size={28} />
                  </button>
                </div>

                <button 
                  onClick={() => setNoiseCancelling(!noiseCancelling)}
                  className={cn(
                    "p-4 rounded-2xl border transition-all",
                    noiseCancelling ? "bg-industrial-transmitting/10 border-industrial-transmitting/30 text-industrial-transmitting" : "bg-white/5 border-white/10 text-industrial-muted"
                  )}
                >
                  <ShieldCheck size={28} />
                </button>
                <button 
                  onClick={() => setShowMembersList(true)}
                  className="p-4 rounded-2xl bg-white/5 border border-white/10 text-industrial-muted relative"
                >
                  <Users size={28} />
                  {activeMembers.length > 0 && (
                    <span className="absolute -top-1 -right-1 w-6 h-6 bg-industrial-accent text-black text-[10px] font-black flex items-center justify-center rounded-full">
                      {activeMembers.length}
                    </span>
                  )}
                </button>
              </div>
            </footer>

            {/* 접속자 명단 팝업 */}
            <AnimatePresence>
              {showMembersList && (
                <>
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    onClick={() => setShowMembersList(false)}
                    className="absolute inset-0 bg-black/80 backdrop-blur-md z-[100]"
                  />
                  <motion.div 
                    initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                    className="absolute bottom-0 left-0 right-0 bg-industrial-card rounded-t-[40px] border-t-4 border-white/10 z-[101] max-h-[60vh] flex flex-col p-10"
                  >
                    <div className="flex items-center justify-between mb-8">
                      <h2 className="text-3xl font-black text-white tracking-tighter">접속자 명단</h2>
                      <button onClick={() => setShowMembersList(false)} className="text-industrial-muted font-bold text-xl">닫기</button>
                    </div>
                    <div className="space-y-4 overflow-y-auto">
                      <div className="bg-white/5 p-6 rounded-3xl flex items-center justify-between border border-white/10">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-industrial-accent rounded-2xl flex items-center justify-center text-black">
                            <UserIcon size={24} />
                          </div>
                          <span className="text-xl font-bold text-white">{profile?.name} (나)</span>
                        </div>
                        <span className="status-label text-industrial-transmitting">접속 중</span>
                      </div>
                      {activeMembers.map(id => (
                        <div key={id} className="bg-white/5 p-6 rounded-3xl flex items-center justify-between border border-white/5 opacity-60">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-industrial-muted">
                              <UserIcon size={24} />
                            </div>
                            <span className="text-xl font-bold text-white">현장 대원 ({id.slice(0,4)})</span>
                          </div>
                          <span className="status-label">온라인</span>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
