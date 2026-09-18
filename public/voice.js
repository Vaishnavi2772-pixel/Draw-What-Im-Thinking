class VoiceChat {
  constructor(socket) {
    this.socket = socket;
    document.querySelector('#voiceDock').hidden = true;
    this.roomCode = null;
    this.players = new Map();
    this.peers = new Map();
    this.audios = new Map();
    this.remoteMuted = new Set();
    this.localStream = null;
    this.rawMicStream = null;
    this.micContext = null;
    this.micGain = null;
    this.muted = true;
    this.muteEveryone = false;
    this.settings = JSON.parse(sessionStorage.getItem('voice-settings') || '{"voiceVolume":1,"micVolume":1,"pushToTalk":false,"microphone":"default","speaker":"default"}');
    this.setupSocketEvents();
    this.setupControls();
  }

  setupSocketEvents() {
    this.socket.on('voice-offer', async ({ from, offer }) => {
      const peer = await this.getPeer(from, false);
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.socket.emit('voice-answer', { to: from, answer });
    });
    this.socket.on('voice-answer', async ({ from, answer }) => {
      const peer = this.peers.get(from);
      if (peer) await peer.setRemoteDescription(answer);
    });
    this.socket.on('voice-ice', async ({ from, candidate }) => {
      const peer = this.peers.get(from);
      if (peer && candidate) await peer.addIceCandidate(candidate).catch(() => {});
    });
  }

  setupControls() {
    document.querySelector('#micButton').addEventListener('click', () => this.toggleMic());
    document.querySelector('#muteEveryoneButton').addEventListener('click', () => this.toggleMuteEveryone());
    document.querySelector('#voiceSettingsButton').addEventListener('click', () => this.openSettings());
    document.querySelector('#voiceSettingsTop').addEventListener('click', () => this.openSettings());
    const talkButton = document.querySelector('#pushToTalkButton');
    const talkStart = (event) => { event.preventDefault(); this.setPushToTalk(true); };
    const talkEnd = (event) => { event.preventDefault(); this.setPushToTalk(false); };
    ['mousedown', 'touchstart'].forEach((event) => talkButton.addEventListener(event, talkStart, { passive: false }));
    ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach((event) => talkButton.addEventListener(event, talkEnd, { passive: false }));
    window.addEventListener('keydown', (event) => { if (this.settings.pushToTalk && event.code === 'Space' && !event.repeat) this.setPushToTalk(true); });
    window.addEventListener('keyup', (event) => { if (this.settings.pushToTalk && event.code === 'Space') this.setPushToTalk(false); });
    document.querySelector('#voiceSettingsForm').addEventListener('submit', () => this.saveSettings());
    document.querySelector('#testMicButton').addEventListener('click', () => this.testMicrophone());
    document.querySelector('#voiceVolume').addEventListener('input', (event) => { this.settings.voiceVolume = Number(event.target.value); this.updateAudioVolumes(); });
    document.querySelector('#micVolume').addEventListener('input', (event) => { this.settings.micVolume = Number(event.target.value); });
    document.querySelector('#pushToTalkToggle').addEventListener('change', (event) => { this.settings.pushToTalk = event.target.checked; this.renderPushToTalk(); });
  }

  async update(state) {
    if (!state?.code) {
      this.cleanup();
      document.querySelector('#voiceDock').hidden = true;
      return;
    }
    if (state.settings && !state.settings.voiceEnabled) {
      this.cleanup();
      document.querySelector('#voiceDock').hidden = true;
      return;
    }
    document.querySelector('#voiceDock').hidden = false;
    if (this.roomCode !== state.code) {
      this.cleanup();
      this.roomCode = state.code;
    }
    const nextPlayers = new Map(state.players.map((player) => [player.id, player]));
    for (const id of this.peers.keys()) if (!nextPlayers.has(id)) this.removePeer(id);
    this.players = nextPlayers;
    this.renderMicButton();
    this.renderPushToTalk();
    const remoteIds = [...nextPlayers.keys()].filter((id) => id !== this.socket.id);
    for (const remoteId of remoteIds) {
      if (!this.peers.has(remoteId) && this.socket.id && this.socket.id < remoteId) this.getPeer(remoteId, true).catch(() => {});
    }
    for (const player of nextPlayers.values()) this.updateSpeakingLabel(player.id, player.voiceMuted);
  }

  async getPeer(remoteId, initiator) {
    if (this.peers.has(remoteId)) return this.peers.get(remoteId);
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.peers.set(remoteId, peer);
    if (this.localStream) this.localStream.getTracks().forEach((track) => peer.addTrack(track, this.localStream));
    else peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.onicecandidate = ({ candidate }) => { if (candidate) this.socket.emit('voice-ice', { to: remoteId, candidate }); };
    peer.ontrack = ({ streams }) => this.attachAudio(remoteId, streams[0]);
    peer.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) this.removePeer(remoteId); };
    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.socket.emit('voice-offer', { to: remoteId, offer });
    }
    return peer;
  }

  async enableMic() {
    if (this.localStream) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.showPermissionMessage('Voice chat is not supported by this browser. The game still works normally.');
      return false;
    }
    try {
      this.rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: this.settings.microphone === 'default' ? true : { deviceId: { exact: this.settings.microphone } }, video: false });
      this.micContext = new AudioContext();
      this.micGain = this.micContext.createGain();
      this.micGain.gain.value = Number(this.settings.micVolume ?? 1);
      const destination = this.micContext.createMediaStreamDestination();
      this.micContext.createMediaStreamSource(this.rawMicStream).connect(this.micGain).connect(destination);
      this.localStream = destination.stream;
      this.localStream.getAudioTracks().forEach((track) => { track.enabled = false; });
      for (const [id, peer] of this.peers) {
        this.localStream.getTracks().forEach((track) => peer.addTrack(track, this.localStream));
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        this.socket.emit('voice-offer', { to: id, offer });
      }
      return true;
    } catch (error) {
      this.showPermissionMessage(error.name === 'NotAllowedError' ? 'Microphone access is blocked. You can enable it in your browser settings.' : 'Microphone could not be started. The game still works normally.');
      return false;
    }
  }

  async toggleMic() {
    if (this.muted) {
      const ready = await this.enableMic();
      if (!ready) return;
      this.muted = false;
      this.setTracksEnabled(true);
    } else {
      this.muted = true;
      this.setTracksEnabled(false);
    }
    this.socket.emit('voice-state', { muted: this.muted });
    this.renderMicButton();
  }

  setPushToTalk(active) {
    if (!this.settings.pushToTalk) return;
    if (active && this.muted) this.enableMic().then((ready) => { if (ready) { this.setTracksEnabled(true); this.renderMicButton(); } });
    if (!active) this.setTracksEnabled(false);
  }

  setTracksEnabled(enabled) {
    if (this.localStream) this.localStream.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    if (enabled) this.muted = false;
    else this.muted = true;
    this.socket.emit('voice-state', { muted: this.muted });
    this.renderMicButton();
  }

  toggleMuteEveryone() {
    this.muteEveryone = !this.muteEveryone;
    document.querySelector('#muteEveryoneButton').innerHTML = this.muteEveryone ? '🔇 <span>Unmute everyone</span>' : '🔊 <span>Voice</span>';
    this.updateAudioVolumes();
  }

  toggleRemoteMute(playerId) {
    if (this.remoteMuted.has(playerId)) this.remoteMuted.delete(playerId);
    else this.remoteMuted.add(playerId);
    this.updateAudioVolumes();
    document.querySelector(`[data-mute-player="${playerId}"]`)?.classList.toggle('muted-local', this.remoteMuted.has(playerId));
  }

  attachAudio(playerId, stream) {
    let audio = this.audios.get(playerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.dataset.playerId = playerId;
      document.querySelector('#remoteAudio').appendChild(audio);
      this.audios.set(playerId, audio);
    }
    audio.srcObject = stream;
    this.updateAudioVolumes();
    this.startSpeakingMeter(playerId, stream);
  }

  startSpeakingMeter(playerId, stream) {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const check = () => {
        if (!this.audios.has(playerId)) { context.close(); return; }
        analyser.getByteFrequencyData(data);
        const loud = data.reduce((sum, value) => sum + value, 0) / data.length > 18;
        document.querySelector(`#player-${playerId}`)?.classList.toggle('speaking', loud);
        requestAnimationFrame(check);
      };
      check();
    } catch (_) { /* Audio indicators are optional enhancement. */ }
  }

  updateAudioVolumes() {
    for (const [id, audio] of this.audios) {
      audio.volume = this.muteEveryone || this.remoteMuted.has(id) ? 0 : Number(this.settings.voiceVolume ?? 1);
      if (this.settings.speaker && this.settings.speaker !== 'default' && audio.setSinkId) audio.setSinkId(this.settings.speaker).catch(() => {});
    }
  }

  removePeer(playerId) {
    this.peers.get(playerId)?.close();
    this.peers.delete(playerId);
    this.audios.get(playerId)?.remove();
    this.audios.delete(playerId);
    document.querySelector(`#player-${playerId}`)?.classList.remove('speaking');
  }

  cleanup() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.rawMicStream?.getTracks().forEach((track) => track.stop());
    this.micContext?.close();
    this.localStream = null;
    this.rawMicStream = null;
    this.micContext = null;
    this.micGain = null;
    this.roomCode = null;
  }

  renderMicButton() {
    const button = document.querySelector('#micButton');
    if (!button) return;
    button.innerHTML = this.muted ? '🔇 <span>Muted</span>' : '🎤 <span>Mic On</span>';
    button.classList.toggle('active', !this.muted);
  }

  renderPushToTalk() {
    const button = document.querySelector('#pushToTalkButton');
    button.hidden = !this.settings.pushToTalk;
  }

  updateSpeakingLabel(playerId, muted) {
    const element = document.querySelector(`#player-${playerId} .player-mic`);
    if (element && !element.classList.contains('muted-local')) element.textContent = muted ? '🔇' : '🎤';
  }

  openSettings() {
    const dialog = document.querySelector('#voiceSettingsDialog');
    document.querySelector('#voiceVolume').value = this.settings.voiceVolume ?? 1;
    document.querySelector('#micVolume').value = this.settings.micVolume ?? 1;
    document.querySelector('#pushToTalkToggle').checked = Boolean(this.settings.pushToTalk);
    this.populateDevices();
    dialog.showModal();
  }

  async populateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = devices.filter((device) => device.kind === 'audioinput');
      const speakers = devices.filter((device) => device.kind === 'audiooutput');
      document.querySelector('#microphoneSelect').innerHTML = microphones.map((device) => `<option value="${device.deviceId}">${device.label || 'Microphone'}</option>`).join('') || '<option value="default">Default microphone</option>';
      document.querySelector('#speakerSelect').innerHTML = speakers.map((device) => `<option value="${device.deviceId}">${device.label || 'Default speaker'}</option>`).join('') || '<option value="default">Default speaker</option>';
    } catch (_) { this.showPermissionMessage('Device names become available after microphone permission is granted.'); }
  }

  saveSettings() {
    this.settings.microphone = document.querySelector('#microphoneSelect').value;
    this.settings.speaker = document.querySelector('#speakerSelect').value;
    sessionStorage.setItem('voice-settings', JSON.stringify(this.settings));
    if (this.micGain) this.micGain.gain.value = Number(this.settings.micVolume ?? 1);
    this.updateAudioVolumes();
    this.showPermissionMessage('Voice settings saved for this browser session.');
  }

  async testMicrophone() {
    const ready = await this.enableMic();
    if (!ready) return;
    const meter = document.querySelector('#micMeterFill');
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(this.localStream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const started = Date.now();
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      const level = data.reduce((sum, value) => sum + Math.abs(value - 128), 0) / data.length / 128;
      meter.style.width = `${Math.min(100, level * 250)}%`;
      if (Date.now() - started < 3000) requestAnimationFrame(tick); else { meter.style.width = '0%'; context.close(); }
    };
    tick();
  }

  showPermissionMessage(message) { const element = document.querySelector('#micPermissionMessage'); if (element) element.textContent = message; }
}

window.voiceChat = new VoiceChat(window.gameSocket);
