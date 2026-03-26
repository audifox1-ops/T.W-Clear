export const audioService = {
  stream: null as MediaStream | null,
  audioContext: null as AudioContext | null,
  analyser: null as AnalyserNode | null,
  dataArray: null as Uint8Array | null,
  hasMic: false,

  async initialize() {
    if (this.stream) return;
    
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const error = new Error('이 브라우저는 마이크 접근을 지원하지 않습니다.');
      console.error(error.message);
      throw error;
    }

    try {
      // 1. 선호하는 제약 조건으로 시도 (에코 캔슬링, 소음 억제 등)
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          } 
        });
        this.hasMic = true;
        console.log('Audio initialized with preferred constraints.');
      } catch (err) {
        console.warn('Preferred audio constraints failed, falling back to basic audio:', err);
        // 2. 기본 오디오로 폴백 (제약 조건 없이)
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.hasMic = true;
          console.log('Audio initialized with basic constraints.');
        } catch (fallbackErr) {
          console.warn('Basic audio constraints also failed:', fallbackErr);
          // 3. 마이크가 없는 경우 (NotFoundError) - 에러를 던지지 않고 '수신 전용' 모드로 진입 허용
          if (fallbackErr instanceof Error && (fallbackErr.name === 'NotFoundError' || fallbackErr.name === 'DevicesNotFoundError')) {
            console.warn('No microphone found. Entering listen-only mode.');
            this.hasMic = false;
            this.stream = null;
          } else {
            throw fallbackErr;
          }
        }
      }
      
      // 마이크가 있는 경우에만 오디오 컨텍스트 및 분석기 설정
      if (this.stream) {
        // 초기에는 마이크 비활성화 (PTT 동작)
        this.stream.getAudioTracks().forEach(track => {
          track.enabled = false;
        });

        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const source = this.audioContext.createMediaStreamSource(this.stream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        source.connect(this.analyser);
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      } else {
        // 마이크가 없어도 비프음 재생 등을 위해 AudioContext는 생성
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
    } catch (err) {
      console.error('Failed to initialize audio:', err);
      throw err;
    }
  },

  getStream() {
    return this.stream;
  },

  getAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return this.audioContext;
  },

  async unlockAudio() {
    const ctx = this.getAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    
    // 1. Web Audio API Oscillator를 통한 잠금 해제
    const osc = ctx.createOscillator();
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    osc.connect(silentGain);
    silentGain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);

    // 2. HTML5 Audio 객체를 통한 강제 잠금 해제 (Base64 Silent WAV)
    try {
      const silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
      await silentAudio.play();
      console.log('HTML5 Audio unlocked successfully.');
    } catch (err) {
      console.warn('HTML5 Audio unlock failed, but AudioContext might still be active:', err);
    }
    
    console.log('AudioContext unlocked and dummy audio played.');
  },

  setTalking(isTalking: boolean) {
    if (this.stream) {
      this.stream.getAudioTracks().forEach(track => {
        track.enabled = isTalking;
      });
    }
  },

  getVolume() {
    if (!this.analyser || !this.dataArray) return 0;
    this.analyser.getByteFrequencyData(this.dataArray);
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i];
    }
    return sum / this.dataArray.length;
  },

  playBeep() {
    if (!this.audioContext) return;
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, this.audioContext.currentTime); // A5 note
    
    gain.gain.setValueAtTime(0.1, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
    
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.1);
  },

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
};
