import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import QRCode from 'qrcode';

const STORAGE_ROOMS_KEY = 'cast_rooms_v1';
const STORAGE_ACTIVE_ROOM_KEY = 'cast_active_host_room_v1';

function randomId(len = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function randomSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function loadStoredRooms() {
  try {
    const raw = localStorage.getItem(STORAGE_ROOMS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStoredRoom(roomData) {
  try {
    const rooms = loadStoredRooms();
    rooms[roomData.roomId] = roomData;
    localStorage.setItem(STORAGE_ROOMS_KEY, JSON.stringify(rooms));
    localStorage.setItem(STORAGE_ACTIVE_ROOM_KEY, roomData.roomId);
  } catch {
    // Ignore storage quota errors
  }
}

function initSession() {
  const params = new URLSearchParams(window.location.search);
  const urlRoom = (params.get('r') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const forceViewer = params.get('view') === '1';
  const storedRooms = loadStoredRooms();

  if (urlRoom) {
    const existing = storedRooms[urlRoom];
    if (existing && existing.hostSecret && !forceViewer) {
      return {
        roomId: urlRoom,
        isHost: true,
        hostSecret: existing.hostSecret,
        initialItems: Array.isArray(existing.items) ? existing.items : [],
        initialVersion: Number(existing.version) || 0,
      };
    }
    return {
      roomId: urlRoom,
      isHost: false,
      hostSecret: null,
      initialItems: [],
      initialVersion: 0,
    };
  }

  // No room in URL: restore active host room or create a new one
  const activeRoomId = localStorage.getItem(STORAGE_ACTIVE_ROOM_KEY);
  if (activeRoomId && storedRooms[activeRoomId]?.hostSecret) {
    const existing = storedRooms[activeRoomId];
    const nextUrl = `${window.location.pathname}?r=${existing.roomId}`;
    window.history.replaceState(null, '', nextUrl);
    return {
      roomId: existing.roomId,
      isHost: true,
      hostSecret: existing.hostSecret,
      initialItems: Array.isArray(existing.items) ? existing.items : [],
      initialVersion: Number(existing.version) || 0,
    };
  }

  const newRoomId = randomId(6);
  const newSecret = randomSecret();
  const initialData = {
    roomId: newRoomId,
    hostSecret: newSecret,
    items: [],
    version: 0,
    updatedAt: Date.now(),
  };
  saveStoredRoom(initialData);
  const nextUrl = `${window.location.pathname}?r=${newRoomId}`;
  window.history.replaceState(null, '', nextUrl);

  return {
    roomId: newRoomId,
    isHost: true,
    hostSecret: newSecret,
    initialItems: [],
    initialVersion: 0,
  };
}

export default function App() {
  const [session] = useState(initSession);
  const { roomId, isHost, hostSecret } = session;

  const [items, setItems] = useState(session.initialItems);
  const [newText, setNewText] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [qrSvg, setQrSvg] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [dragState, setDragState] = useState(null);

  const itemsRef = useRef(session.initialItems);
  const versionRef = useRef(session.initialVersion);
  const lastAckedVersionRef = useRef(0);
  const socketRef = useRef(null);
  const itemElsRef = useRef(new Map());
  const editInputRef = useRef(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Generate QR code SVG for the viewer join link
  useEffect(() => {
    const joinUrl = `${window.location.origin}${window.location.pathname}?r=${roomId}`;
    QRCode.toString(
      joinUrl,
      {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#111318',
          light: '#ffffff',
        },
      },
      (err, svg) => {
        if (!err && svg) {
          setQrSvg(svg);
        }
      }
    );
  }, [roomId]);

  // Focus inline edit input when editingId changes
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const pushHttpState = useCallback(
    async (itemsToPush, versionToPush, force = false) => {
      if (!isHost || !hostSecret) return;
      try {
        const res = await fetch('/api/socket-io/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            roomId,
            hostSecret,
            items: itemsToPush,
            version: versionToPush,
            force,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.ok && data.state) {
            lastAckedVersionRef.current = Math.max(
              lastAckedVersionRef.current,
              Number(data.state.version) || versionToPush
            );
          }
        }
      } catch {
        // Will retry on wakeup / interval
      }
    },
    [isHost, hostSecret, roomId]
  );

  const pullHttpState = useCallback(async () => {
    try {
      const res = await fetch(`/api/socket-io/state?r=${encodeURIComponent(roomId)}`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok && data.state && Array.isArray(data.state.items)) {
        const incomingVersion = Number(data.state.version) || 0;
        if (!isHost || incomingVersion > versionRef.current) {
          if (incomingVersion >= versionRef.current) {
            versionRef.current = incomingVersion;
            itemsRef.current = data.state.items;
            setItems(data.state.items);
            if (isHost) {
              saveStoredRoom({
                roomId,
                hostSecret,
                items: data.state.items,
                version: incomingVersion,
                updatedAt: Date.now(),
              });
            }
          }
        } else if (isHost && versionRef.current > incomingVersion) {
          // Server is behind local host state (e.g. after server restart while phone was off)
          pushHttpState(itemsRef.current, versionRef.current, true);
        }
      }
    } catch {
      // Ignore network errors while offline
    }
  }, [roomId, isHost, hostSecret, pushHttpState]);

  const commitHostItems = useCallback(
    (nextItems) => {
      if (!isHost) return;
      const nextVersion = versionRef.current + 1;
      versionRef.current = nextVersion;
      itemsRef.current = nextItems;
      setItems(nextItems);

      saveStoredRoom({
        roomId,
        hostSecret,
        items: nextItems,
        version: nextVersion,
        updatedAt: Date.now(),
      });

      const socket = socketRef.current;
      if (socket && socket.connected) {
        socket.emit(
          'room:update',
          {
            roomId,
            hostSecret,
            items: nextItems,
            version: nextVersion,
          },
          (ack) => {
            if (ack?.ok) {
              lastAckedVersionRef.current = Math.max(
                lastAckedVersionRef.current,
                ack.state?.version || nextVersion
              );
            }
          }
        );
      }

      pushHttpState(nextItems, nextVersion, true);
    },
    [isHost, roomId, hostSecret, pushHttpState]
  );

  // Socket.IO setup + phone sleep/wake resilience
  useEffect(() => {
    const socket = io({
      path: '/api/socket-io/socket.io',
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 250,
      reconnectionDelayMax: 2000,
      timeout: 8000,
    });

    socketRef.current = socket;

    const joinAndSync = () => {
      socket.emit(
        'room:join',
        {
          roomId,
          hostSecret: isHost ? hostSecret : undefined,
          state: isHost
            ? {
                items: itemsRef.current,
                version: versionRef.current,
              }
            : undefined,
        },
        (ack) => {
          if (ack?.ok && ack.state) {
            const srvVersion = Number(ack.state.version) || 0;
            if (isHost) {
              lastAckedVersionRef.current = Math.max(lastAckedVersionRef.current, srvVersion);
              if (srvVersion > versionRef.current) {
                versionRef.current = srvVersion;
                itemsRef.current = ack.state.items || [];
                setItems(itemsRef.current);
                saveStoredRoom({
                  roomId,
                  hostSecret,
                  items: itemsRef.current,
                  version: srvVersion,
                  updatedAt: Date.now(),
                });
              } else if (versionRef.current > srvVersion) {
                socket.emit('room:update', {
                  roomId,
                  hostSecret,
                  items: itemsRef.current,
                  version: versionRef.current,
                });
              }
            } else {
              versionRef.current = srvVersion;
              itemsRef.current = ack.state.items || [];
              setItems(itemsRef.current);
            }
          }
        }
      );
    };

    socket.on('connect', () => {
      joinAndSync();
    });

    socket.on('room:state', (state) => {
      if (!state || !Array.isArray(state.items)) return;
      const incomingVersion = Number(state.version) || 0;
      if (!isHost) {
        if (incomingVersion >= versionRef.current) {
          versionRef.current = incomingVersion;
          itemsRef.current = state.items;
          setItems(state.items);
        }
      } else if (incomingVersion > versionRef.current) {
        versionRef.current = incomingVersion;
        itemsRef.current = state.items;
        setItems(state.items);
        saveStoredRoom({
          roomId,
          hostSecret,
          items: state.items,
          version: incomingVersion,
          updatedAt: Date.now(),
        });
      }
    });

    // Initial HTTP sync for instant hydration
    if (isHost) {
      pushHttpState(itemsRef.current, versionRef.current, false).then(() => pullHttpState());
    } else {
      pullHttpState();
    }

    // Wake-up handler when phone screen turns back on or tab regains focus
    const handleWakeUp = () => {
      if (document.visibilityState === 'hidden') return;

      if (isHost) {
        pushHttpState(itemsRef.current, versionRef.current, false);
      } else {
        pullHttpState();
      }

      if (!socket.connected) {
        socket.connect();
      } else {
        // Verify mobile OS hasn't frozen the TCP socket while screen was off
        socket.timeout(1500).emit('room:ping', {}, (err) => {
          if (err) {
            socket.disconnect().connect();
          } else {
            joinAndSync();
          }
        });
      }
    };

    const handleSleep = () => {
      if (isHost) {
        pushHttpState(itemsRef.current, versionRef.current, false);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        handleWakeUp();
      } else {
        handleSleep();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', handleWakeUp);
    window.addEventListener('focus', handleWakeUp);
    window.addEventListener('online', handleWakeUp);
    window.addEventListener('pagehide', handleSleep);

    // Periodic safety-net sync
    const syncTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (isHost) {
        if (versionRef.current > lastAckedVersionRef.current) {
          pushHttpState(itemsRef.current, versionRef.current, true);
        }
      } else {
        pullHttpState();
      }
    }, 2000);

    // Progressive enhancement: Screen Wake Lock API when visible
    let wakeLock = null;
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        try {
          wakeLock = await navigator.wakeLock.request('screen');
        } catch {
          // Ignore wakeLock rejection
        }
      }
    };
    requestWakeLock();
    const reacquireWakeLock = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', reacquireWakeLock);

    return () => {
      clearInterval(syncTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('visibilitychange', reacquireWakeLock);
      window.removeEventListener('pageshow', handleWakeUp);
      window.removeEventListener('focus', handleWakeUp);
      window.removeEventListener('online', handleWakeUp);
      window.removeEventListener('pagehide', handleSleep);
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
      socket.disconnect();
    };
  }, [roomId, isHost, hostSecret, pushHttpState, pullHttpState]);

  // Add item handler
  const handleAddSubmit = (e) => {
    e.preventDefault();
    const trimmed = newText.trim();
    if (!trimmed || !isHost) return;
    const nextItem = {
      id: randomId(10),
      text: trimmed,
      createdAt: Date.now(),
    };
    setNewText('');
    commitHostItems([...itemsRef.current, nextItem]);
  };

  // Start editing item
  const startEdit = (item) => {
    if (!isHost) return;
    setEditingId(item.id);
    setEditingText(item.text);
  };

  // Save edited item
  const saveEdit = (id) => {
    if (!isHost || editingId !== id) return;
    const trimmed = editingText.trim();
    setEditingId(null);
    setEditingText('');
    if (!trimmed) {
      // If emptied, remove item
      commitHostItems(itemsRef.current.filter((it) => it.id !== id));
      return;
    }
    const next = itemsRef.current.map((it) => (it.id === id ? { ...it, text: trimmed } : it));
    commitHostItems(next);
  };

  // Delete item
  const removeItem = (id) => {
    if (!isHost) return;
    if (editingId === id) {
      setEditingId(null);
      setEditingText('');
    }
    commitHostItems(itemsRef.current.filter((it) => it.id !== id));
  };

  // Left-handle Pointer Drag-and-Drop
  const handleDragPointerDown = (e, index, itemId) => {
    if (!isHost || editingId) return;
    if (e.button !== undefined && e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    const currentItems = itemsRef.current;
    if (currentItems.length <= 1) return;

    const rects = currentItems.map((it) => {
      const el = itemElsRef.current.get(it.id);
      return el ? el.getBoundingClientRect() : { top: 0, bottom: 0, height: 56 };
    });

    const draggedRect = rects[index];
    const gap = 8;
    const shiftAmount = draggedRect.height + gap;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore pointer capture errors
    }

    setDragState({
      pointerId: e.pointerId,
      dragIndex: index,
      overIndex: index,
      itemId,
      startY: e.clientY,
      deltaY: 0,
      rects,
      shiftAmount,
    });
  };

  const handleDragPointerMove = (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    e.preventDefault();

    const deltaY = e.clientY - dragState.startY;
    const { dragIndex, rects } = dragState;
    const draggedCenterY = rects[dragIndex].top + rects[dragIndex].height / 2 + deltaY;

    let overIndex = dragIndex;
    for (let i = 0; i < rects.length; i++) {
      const midY = rects[i].top + rects[i].height / 2;
      if (i < dragIndex && draggedCenterY < midY) {
        overIndex = i;
        break;
      }
      if (i > dragIndex && draggedCenterY > midY) {
        overIndex = i;
      }
    }

    setDragState((prev) => (prev ? { ...prev, deltaY, overIndex } : null));
  };

  const finishDrag = (e) => {
    if (!dragState || (e && e.pointerId !== dragState.pointerId)) return;
    const { dragIndex, overIndex } = dragState;
    setDragState(null);

    if (dragIndex !== overIndex && overIndex >= 0 && overIndex < itemsRef.current.length) {
      const next = [...itemsRef.current];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(overIndex, 0, moved);
      commitHostItems(next);
    }
  };

  const getItemStyle = (index) => {
    if (!dragState) return undefined;
    const { dragIndex, overIndex, deltaY, shiftAmount } = dragState;

    if (index === dragIndex) {
      return {
        transform: `translate3d(0, ${deltaY}px, 0) scale(1.015)`,
        transition: 'none',
      };
    }

    let shift = 0;
    if (dragIndex < overIndex && index > dragIndex && index <= overIndex) {
      shift = -shiftAmount;
    } else if (dragIndex > overIndex && index >= overIndex && index < dragIndex) {
      shift = shiftAmount;
    }

    return {
      transform: `translate3d(0, ${shift}px, 0)`,
      transition: 'transform 180ms cubic-bezier(0.2, 0, 0, 1)',
    };
  };

  return (
    <main className="app-shell">
      {isHost && (
        <header className="top-bar">
          <form className="add-form" onSubmit={handleAddSubmit}>
            <input
              type="text"
              className="add-input"
              placeholder="Add item"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              enterKeyHint="done"
              autoComplete="off"
            />
            {newText.trim().length > 0 && (
              <button
                type="submit"
                className="icon-btn primary"
                aria-label="Add"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
          </form>

          <button
            type="button"
            className="icon-btn tonal"
            onClick={() => setQrOpen(true)}
            aria-label="Show QR Code"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13-2h3v2h-3v-2zm-5 0h2v3h-2v-3zm2 3h3v2h-3v-2zm-2 2h2v3h-2v-3zm3 2h3v1h-3v-1zm2-5h3v3h-3v-3z" />
            </svg>
          </button>
        </header>
      )}

      <section className="item-list" aria-live="polite">
        {items.map((item, index) => {
          const isDragging = dragState?.itemId === item.id;
          const isEditing = isHost && editingId === item.id;

          return (
            <div
              key={item.id}
              ref={(el) => {
                if (el) itemElsRef.current.set(item.id, el);
                else itemElsRef.current.delete(item.id);
              }}
              className={`item-card ${!isHost ? 'viewer-card' : ''} ${isDragging ? 'dragging' : ''}`}
              style={getItemStyle(index)}
            >
              {isHost && (
                <div
                  className="drag-handle"
                  onPointerDown={(e) => handleDragPointerDown(e, index, item.id)}
                  onPointerMove={handleDragPointerMove}
                  onPointerUp={finishDrag}
                  onPointerCancel={finishDrag}
                  role="button"
                  tabIndex={-1}
                  aria-label="Drag to reorder"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                  </svg>
                </div>
              )}

              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="edit-input"
                  value={editingText}
                  onChange={(e) => setEditingText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveEdit(item.id);
                    } else if (e.key === 'Escape') {
                      setEditingId(null);
                      setEditingText('');
                    }
                  }}
                  onBlur={() => saveEdit(item.id)}
                />
              ) : (
                <div
                  className="item-content"
                  onDoubleClick={() => isHost && startEdit(item)}
                >
                  {item.text}
                </div>
              )}

              {isHost && (
                <div className="item-actions">
                  {isEditing ? (
                    <button
                      type="button"
                      className="icon-btn confirm"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => saveEdit(item.id)}
                      aria-label="Save"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => startEdit(item)}
                      aria-label="Edit"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                    </button>
                  )}

                  <button
                    type="button"
                    className="icon-btn danger"
                    onMouseDown={(e) => isEditing && e.preventDefault()}
                    onClick={() => removeItem(item.id)}
                    aria-label="Remove"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {qrOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setQrOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="qr-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="qr-svg-wrap"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          </div>
        </div>
      )}
    </main>
  );
}
