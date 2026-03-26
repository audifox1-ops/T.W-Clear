/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class AudioService {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private noiseFilterNode: BiquadFilterNode | null = null;
  private gainNode: GainNode | null = null;
  private isNoiseCancelling: boolean = true;

  async initialize() {
    if (this.audioContext) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      
      this.audioContext = new AudioContext();
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      // 1. Noise Filter (High-pass to remove low-end rumble)
      this.noiseFilterNode = this.audioContext.createBiquadFilter();
      this.noiseFilterNode.type = 'highpass';
      this.noiseFilterNode.frequency.value = 150;

      // 2. Gain Node for volume control
      this.gainNode = this.audioContext.createGain();

      // 3. Analyser for visualization
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;

      // Connect nodes
      this.sourceNode.connect(this.noiseFilterNode);
      this.noiseFilterNode.connect(this.gainNode);
      this.gainNode.connect(this.analyserNode);
      
      this.updateFilterState();
    } catch (error) {
      console.error('Failed to initialize audio service:', error);
      throw error;
    }
  }

  setNoiseCancelling(enabled: boolean) {
    this.isNoiseCancelling = enabled;
    this.updateFilterState();
  }

  private updateFilterState() {
    if (!this.noiseFilterNode) return;
    // When disabled, we set frequency to very low to effectively bypass
    this.noiseFilterNode.frequency.value = this.isNoiseCancelling ? 150 : 20;
  }

  getAnalyserData(): Uint8Array {
    if (!this.analyserNode) return new Uint8Array(0);
    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(dataArray);
    return dataArray;
  }

  getVolume(): number {
    const data = this.getAnalyserData();
    if (data.length === 0) return 0;
    const sum = data.reduce((a, b) => a + b, 0);
    return sum / data.length;
  }

  getStream(): MediaStream | null {
    return this.mediaStream;
  }

  stop() {
    this.mediaStream?.getTracks().forEach(track => track.stop());
    this.audioContext?.close();
    this.audioContext = null;
  }
}

export const audioService = new AudioService();
