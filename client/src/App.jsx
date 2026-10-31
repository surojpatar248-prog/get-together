import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SERVER = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';
const socket = io(SERVER, { autoConnect: true });
const videoIdFromUrl = value => {
  try {
    const u = new URL(value);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
  } catch {}
  return null;
};

export default function App() {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(socket.connected);
  const [url, setUrl] = useState('');
  const [mediaMode, setMediaMode] = useState('youtube');
  const [localUrl, setLocalUrl] = useState('');
  const [localName, setLocalName] = useState('');
  const [messages, setMessages] = useState([]);
  const [chatText, setChatText] = useState('');
  const [serverOffset, setServerOffset] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [notice, setNotice] = useState('');
  const playerRef = useRef(null);
  const localRef = useRef(null);
  const lastActionRef = useRef('');
  const suppressRef = useRef(false);
  const roomRef = useRef(room);
  useEffect(() => { roomRef.current = room; }, [room]);

  useEffect(() => {
    const onConnect = () => setConnected(true), onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect); socket.on('disconnect', onDisconnect);
    const ping = () => socket.emit('clock:ping', { clientSentAt: Date.now() }, res => {
      if (res) setServerOffset(res.serverNow - (res.clientSentAt + Date.now()) / 2);
    });
    ping(); const interval = setInterval(ping, 5000);
    const onRoom = next => setRoom(next);
    const onPlayback = event => applyRemote(event);
    const onChat = msg => setMessages(old => [...old.slice(-99), msg]);
    socket.on('room:updated', onRoom); socket.on('playback:event', onPlayback); socket.on('chat:message', onChat);
    return () => {
      clearInterval(interval); socket.off('connect', onConnect); socket.off('disconnect', onDisconnect);
      socket.off('room:updated', onRoom); socket.off('playback:event', onPlayback); socket.off('chat:message', onChat);
    };
  }, [serverOffset]);

  // Load YouTube IFrame API once, then create player when the room has YouTube media.
  useEffect(() => {
    if (!window.YT) {
      if (!document.querySelector('#youtube-iframe-api')) {
        const script = document.createElement('script'); script.id = 'youtube-iframe-api'; script.src = 'https://www.youtube.com/iframe_api';
        document.body.appendChild(script);
      }
    }
    window.onYouTubeIframeAPIReady = () => setPlayerReady(true);
    if (window.YT?.Player) setPlayerReady(true);
  }, []);

  const sendCommand = useCallback((action, extra = {}) => {
    if (!roomRef.current) return;
    socket.emit('playback:command', { code: roomRef.current.code, action, ...extra }, result => {
      if (result && !result.ok) setError(result.error);
    });
  }, []);

  const applyRemote = useCallback(event => {
    const state = event.state;
    if (!state) return;
    suppressRef.current = true;
    lastActionRef.current = event.action;
    const desired = state.playing
      ? state.position + Math.max(0, ((event.startAt || state.startedAt || event.serverNow) - event.serverNow) / 1000) +
        Math.max(0, (Date.now() + serverOffset - (event.startAt || event.serverNow)) / 1000)
      : state.position;
    const run = () => {
      const currentRoom = roomRef.current;
      if (state.media?.type === 'youtube' && playerRef.current?.seekTo) {
        const player = playerRef.current;
        const current = player.getCurrentTime?.() || 0;
        if (event.action === 'QUEUE_CHANGE') {
          const id = videoIdFromUrl(state.media.url);
          if (id) player.loadVideoById(id);
        } else if (event.action === 'SEEK' || Math.abs(current - desired) > 0.8) player.seekTo(desired, true);
        if (state.playing && (event.action === 'PLAY' || player.getPlayerState?.() !== 1)) {
          const delay = Math.max(0, (event.startAt || event.serverNow) - (Date.now() + serverOffset));
          setTimeout(() => playerRef.current?.playVideo?.(), delay);
        } else if (!state.playing) player.pauseVideo?.();
      } else if (state.media?.type === 'local' && localRef.current) {
        const el = localRef.current;
        if (event.action === 'QUEUE_CHANGE') { /* every participant must select the same local file */ }
        if (Math.abs((el.currentTime || 0) - desired) > 0.8 || event.action === 'SEEK') el.currentTime = desired;
        if (state.playing) {
          const delay = Math.max(0, (event.startAt || event.serverNow) - (Date.now() + serverOffset));
          setTimeout(() => el.play().catch(() => setNotice('Tap play once to allow audio playback.')), delay);
        } else el.pause();
      }
      setTimeout(() => { suppressRef.current = false; }, 250);
    };
    if (event.action === 'PLAY' && event.startAt) setTimeout(run, Math.max(0, event.startAt - (Date.now() + serverOffset)));
    else run();
  }, [serverOffset]);

  useEffect(() => {
    if (!playerReady || !room?.state?.media || room.state.media.type !== 'youtube') return;
    const id = videoIdFromUrl(room.state.media.url);
    if (!id) return;
    if (playerRef.current?.loadVideoById) {
      if (playerRef.current.getVideoUrl?.() !== room.state.media.url) playerRef.current.loadVideoById(id);
      return;
    }
    playerRef.current = new window.YT.Player('youtube-player', {
      width: '100%', height: '100%', videoId: id,
      playerVars: { playsinline: 1, rel: 0 },
      events: {
        onReady: () => {
          const state = roomRef.current?.state;
          if (state) applyRemote({ action: 'INIT', state, serverNow: Date.now() + serverOffset });
        },
        onStateChange: e => {
          if (suppressRef.current || !roomRef.current) return;
          // Avoid interpreting buffering/end state as an intentional remote command.
          if (e.data === window.YT.PlayerState.PLAYING) sendCommand('PLAY', { position: playerRef.current.getCurrentTime() });
          if (e.data === window.YT.PlayerState.PAUSED) sendCommand('PAUSE', { position: playerRef.current.getCurrentTime() });
        }
      }
    });
  }, [playerReady, room?.state?.media?.url, room?.state?.media?.type, applyRemote, sendCommand, serverOffset]);

  // Drift correction: once per 2s, seek only when drift is noticeable.
  useEffect(() => {
    if (!room?.state?.playing) return;
    const timer = setInterval(() => {
      const state = roomRef.current?.state;
      if (!state?.playing || suppressRef.current) return;
      const expected = state.position + Math.max(0, ((Date.now() + serverOffset) - (state.startedAt || state.updatedAt)) / 1000);
      const actual = state.media?.type === 'youtube' ? playerRef.current?.getCurrentTime?.() : localRef.current?.currentTime;
      if (Number.isFinite(actual) && Math.abs(actual - expected) > 0.75) {
        if (state.media?.type === 'youtube') playerRef.current?.seekTo?.(expected, true);
        else if (localRef.current) localRef.current.currentTime = expected;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [room?.state?.playing, room?.state?.updatedAt, serverOffset]);

  const createRoom = () => {
    setError('');
    socket.emit('room:create', { name: name || 'Guest', controlMode: 'host' }, res => {
      if (!res?.ok) setError(res?.error || 'Could not create room.');
      else setRoom(res.room);
    });
  };
  const joinRoom = () => {
    setError('');
    socket.emit('room:join', { code: joinCode, name: name || 'Guest' }, res => {
      if (!res?.ok) setError(res?.error || 'Could not join room.');
      else setRoom(res.room);
    });
  };
  const chooseYouTube = () => {
    const id = videoIdFromUrl(url);
    if (!id) return setError('Enter a valid YouTube URL.');
    const media = { type: 'youtube', title: `YouTube video ${id}`, url: `https://www.youtube.com/watch?v=${id}` };
    socket.emit('queue:add', { code: room.code, item: media }, () => {});
    sendCommand('QUEUE_CHANGE', { media });
    setError('');
  };
  const chooseLocal = file => {
    if (!file) return;
    setLocalName(file.name);
    setLocalUrl(old => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
    const media = { type: 'local', title: file.name, url: '' };
    sendCommand('QUEUE_CHANGE', { media });
    setMediaMode('local');
    setNotice('Local file selected on this device. Other participants must select the same file separately.');
  };
  const control = (action, position) => sendCommand(action, position == null ? {} : { position });
  const togglePlay = () => {
    const state = room?.state;
    if (state?.playing) control('PAUSE', currentPosition());
    else control('PLAY', currentPosition());
  };
  function currentPosition() {
    if (room?.state?.media?.type === 'youtube') return playerRef.current?.getCurrentTime?.() || room.state.position || 0;
    return localRef.current?.currentTime || room?.state?.position || 0;
  }
  const addQueue = item => socket.emit('queue:add', { code: room.code, item }, res => { if (!res?.ok) setError(res.error); });
  const playQueueItem = item => {
    if (item.type === 'youtube') { setUrl(item.url); sendCommand('QUEUE_CHANGE', { media: item }); }
    else setNotice('For local media, each participant must choose the same file on their device.');
  };
  const sendChat = e => {
    e.preventDefault(); if (!chatText.trim()) return;
    socket.emit('chat:send', { code: room.code, text: chatText }, res => { if (res?.ok) setChatText(''); });
  };
  const isHost = room?.hostId === socket.id;

  if (!room) return <main className="landing">
    <div className="brand"><div className="brand-icon">♫</div><span>get<span className="accent">together</span></span></div>
    <p className="eyebrow">ONE ROOM. ONE BEAT.</p><h1>Watch and listen<br/><span className="gradient">in sync.</span></h1>
    <p className="sub">Bring your people together, wherever they are.</p>
    <section className="entry-card">
      <label>Your name<input value={name} onChange={e=>setName(e.target.value)} placeholder="What should we call you?" maxLength={32}/></label>
      <button className="primary full" onClick={createRoom} disabled={!connected}>＋ Create a room</button>
      <div className="separator"><span>OR JOIN WITH A CODE</span></div>
      <div className="join-row"><input value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase().slice(0,6))} placeholder="6-character code" maxLength={6}/><button className="secondary" onClick={joinRoom} disabled={!connected || joinCode.length!==6}>Join ↗</button></div>
      {error && <p className="error">{error}</p>}
      <p className="tiny"><span className={connected?'dot':'dot offline'}></span>{connected?'Connected and ready':'Connecting to server…'}</p>
    </section>
    <footer>Made for the moments you share <span>✦</span></footer>
  </main>;

  return <main className="app-shell">
    <header className="topbar"><div className="brand small-brand"><div className="brand-icon">♫</div><span>get<span className="accent">together</span></span></div><div className="room-badge"><span className="dot"></span> ROOM <b>{room.code}</b><button title="Copy room code" onClick={()=>navigator.clipboard?.writeText(room.code)}>⧉</button></div><div className="top-right"><span className="online-pill">{room.participants.length} here</span><button className="quiet" onClick={()=>{socket.emit('room:leave',{code:room.code});setRoom(null);setMessages([]);}}>Leave</button></div></header>
    <div className="workspace">
      <section className="main-column">
        <div className="welcome-row"><div><p className="eyebrow">YOUR PRIVATE LISTENING ROOM</p><h1>Good vibes, <span className="gradient">together.</span></h1></div><div className="live-pill"><span className="dot"></span> LIVE SESSION</div></div>
        <div className="player-card">
          <div className="player-top"><div><span className="tag">NOW PLAYING</span><h2>{room.state.media?.title || 'Choose something to play'}</h2><p>{room.state.media?.type==='youtube'?'YouTube video':room.state.media?.type==='local'?'Local media':'Ready when you are'}</p></div><div className="vinyl">♫</div></div>
          <div className="media-frame">
            {room.state.media?.type==='youtube' ? <div id="youtube-player"></div> :
             room.state.media?.type==='local' ? (localUrl ? <video ref={localRef} src={localUrl} controls={false} onPlay={()=>{if(!suppressRef.current)control('PLAY',localRef.current.currentTime)}} onPause={()=>{if(!suppressRef.current)control('PAUSE',localRef.current.currentTime)}} onSeeked={()=>{if(!suppressRef.current)control('SEEK',localRef.current.currentTime)}} /> : <div className="empty-media"><div className="big-note">♫</div><b>{room.state.media.title}</b><p>Choose the same file on this device to play it.</p><label className="secondary upload-label">Select local file<input type="file" accept="audio/*,video/*" onChange={e=>chooseLocal(e.target.files?.[0])}/></label></div>) :
             <div className="empty-media"><div className="big-note">♫</div><b>Your room, your soundtrack.</b><p>Paste a YouTube link or pick a local file below.</p></div>}
          </div>
          <div className="player-controls"><button className="control-btn" title="Seek back 10 seconds" onClick={()=>control('SEEK',Math.max(0,currentPosition()-10))}>↶ 10</button><button className="play-btn" onClick={togglePlay}>{room.state.playing?'Ⅱ':'▶'}</button><button className="control-btn" title="Seek forward 10 seconds" onClick={()=>control('SEEK',currentPosition()+10)}>10 ↷</button><span className="sync-label">◉ Sync enabled</span></div>
          <div className="source-row"><button className={mediaMode==='youtube'?'source active':'source'} onClick={()=>setMediaMode('youtube')}>▶ YouTube</button><button className={mediaMode==='local'?'source active':'source'} onClick={()=>setMediaMode('local')}>♫ Local file</button></div>
          {mediaMode==='youtube' ? <div className="add-source"><input value={url} onChange={e=>setUrl(e.target.value)} placeholder="Paste a YouTube video URL…"/><button className="primary" onClick={chooseYouTube}>Play together ↗</button></div> :
            <div className="add-source"><label className="secondary upload-label">＋ Choose audio/video<input type="file" accept="audio/*,video/*" onChange={e=>chooseLocal(e.target.files?.[0])}/></label><span className="tiny">{localName || 'Select a file stored on this device'}</span></div>}
          {notice && <p className="notice">{notice}</p>}
        </div>
        <div className="below-grid">
          <section className="panel"><div className="panel-heading"><h3>Up next</h3><span>{room.queue.length} tracks</span></div>{room.queue.length===0?<p className="muted">Your shared queue is waiting for a first track.</p>:<div className="queue-list">{room.queue.map((item,i)=><button className="queue-item" key={item.id} onClick={()=>playQueueItem(item)}><span className="queue-num">{String(i+1).padStart(2,'0')}</span><span className="queue-title">{item.title}<small>{item.type==='youtube'?'YouTube':'Local file'}</small></span><span>▶</span></button>)}</div>}</section>
          <section className="panel"><div className="panel-heading"><h3>Room settings</h3><span>⚙</span></div><p className="muted">Who can control playback?</p><div className="permission-options"><button className={room.controlMode==='host'?'permission selected':'permission'} disabled={!isHost} onClick={()=>socket.emit('room:control-mode',{code:room.code,controlMode:'host'})}><b>♙ Host only</b><small>Only host can play or pause</small></button><button className={room.controlMode==='collaborative'?'permission selected':'permission'} disabled={!isHost} onClick={()=>socket.emit('room:control-mode',{code:room.code,controlMode:'collaborative'})}><b>♧ Everyone</b><small>Shared playback controls</small></button></div>{!isHost&&<p className="tiny">Only the host can change settings.</p>}</section>
        </div>
      </section>
      <aside className="side-column">
        <section className="panel people-panel"><div className="panel-heading"><h3>In the room</h3><span className="count">{room.participants.length}</span></div><div className="people-list">{room.participants.map((p,i)=><div className="person" key={p.id}><div className={'avatar avatar-'+(i%5)}>{(p.name||'?').slice(0,1).toUpperCase()}</div><div className="person-name">{p.name}<small>{p.id===room.hostId?'Host':'Participant'}</small></div><span className="dot"></span></div>)}</div><button className="invite-btn" onClick={()=>navigator.clipboard?.writeText(`${location.origin}?room=${room.code}`)}>＋ Copy invite link</button></section>
        <section className="panel chat-panel"><div className="panel-heading"><h3>Room chat</h3><span>✧</span></div><div className="chat-messages">{messages.map(m=><div className="chat-message" key={m.id}><b>{m.name}</b><p>{m.text}</p></div>)}{messages.length===0&&<p className="muted">Say hi to your people 👋</p>}</div><form className="chat-form" onSubmit={sendChat}><input value={chatText} onChange={e=>setChatText(e.target.value)} placeholder="Send a message…" maxLength={500}/><button aria-label="Send message">➤</button></form></section>
      </aside>
    </div>
  </main>;
}
