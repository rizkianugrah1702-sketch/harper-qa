// --- REAL-TIME SYNC (PeerJS) ---
let peer = null;
let conn = null; // Connection to Host (for Client)
let connections = []; // Connections from Clients (for Host)
let hostPeerId = null;
let isHost = false;
let peerOpening = false;
let pendingPeerReady = [];
let hostListenersAttached = false;
let lastHostTargetId = null;
let pingIntervalId = null;
let peerErrorBound = false;
let rehostOnHashChangeBound = false;
let reconnectAttempts = 0;
let reconnectTimerId = null;

function bindPeerError() {
    if (!peer || peerErrorBound) return;
    peerErrorBound = true;
    peer.on('error', (err) => {
        console.error('PeerJS Error:', err);
    });
}

function isIOSSafari() {
    const ua = navigator.userAgent;
    const isIOS = /iP(ad|hone|od)/.test(ua);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return isIOS && isSafari;
}

function isChromeAndroid() {
    const ua = navigator.userAgent;
    return /Android/.test(ua) && /Chrome|CriOS/.test(ua);
}

function peerOptions() {
    return {
        debug: 2,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
            ]
        }
    };
}

function getShortCodeForSession(sessionId) {
    try {
        if (typeof sessions !== 'undefined') {
            const s = sessions[sessionId];
            if (s && s.shortCode) return s.shortCode;
        }
    } catch(_) {}
    return null;
}

function getDesiredHostIdForSession(sessionId) {
    const sc = getShortCodeForSession(sessionId);
    if (!sc) return null;
    return 'qa-' + sc.toLowerCase();
}

function attachHostListeners() {
    if (!peer || hostListenersAttached) return;
    hostListenersAttached = true;
    peer.on('connection', (c) => {
        console.log("New client connected:", c.peer);
        connections.push(c);
        
        c.on('data', (data) => {
            handleHostIncomingData(data, c);
        });
        
        c.on('close', () => {
            connections = connections.filter(conn => conn !== c);
        });
        
        if (typeof sessions !== 'undefined') {
            c.send({ 
                type: 'sync_sessions', 
                data: sessions,
                currentSessionId: currentSessionId
            });
        }
    });
}

function startHostWithId(desiredId) {
    if (!desiredId) return;
    if (peer) {
        try { peer.destroy(); } catch(_) {}
        peer = null;
        hostListenersAttached = false;
        peerErrorBound = false;
    }
    peer = new Peer(desiredId, peerOptions());
    bindPeerError();
    attachHostListeners();
    peer.on('open', (id) => {
        console.log('Host Peer ID: ' + id);
        hostPeerId = id;
        isHost = true;
        if (typeof qrModalSessionId !== 'undefined' && qrModalSessionId) {
            showQRCode(qrModalSessionId);
        }
    });
}

function ensurePeerReady(callback) {
    if (!peer) {
        peer = new Peer(undefined, peerOptions());
    }
    bindPeerError();
    if (peer.open && peer.id) {
        callback(peer.id);
        return;
    }
    pendingPeerReady.push(callback);
    if (peerOpening) return;
    peerOpening = true;
    peer.on('open', (id) => {
        peerOpening = false;
        const callbacks = pendingPeerReady.slice();
        pendingPeerReady = [];
        callbacks.forEach(fn => fn(id));
    });
}

function initPeer() {
    // Check if PeerJS is loaded
    if (typeof Peer === 'undefined') {
        console.error("PeerJS library not loaded. Realtime features disabled.");
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const remoteHostId = urlParams.get('host');
    const canHost = (typeof isAdmin !== 'undefined' && isAdmin) || (typeof isSuperAdmin !== 'undefined' && isSuperAdmin);

    if (remoteHostId) {
        console.log("Initializing Client Mode...");
        connectToHost(remoteHostId);
        return;
    }

    if (!canHost) {
        return;
    }

    console.log("Initializing Host Mode...");
    const desiredId = getDesiredHostIdForSession(typeof currentSessionId !== 'undefined' ? currentSessionId : null);
    if (desiredId) {
        startHostWithId(desiredId);
    } else {
        ensurePeerReady((id) => {
            console.log('Host Peer ID: ' + id);
            hostPeerId = id;
            isHost = true;
            if (typeof qrModalSessionId !== 'undefined' && qrModalSessionId) {
                showQRCode(qrModalSessionId);
            }
        });
    }
    if (!rehostOnHashChangeBound) {
        rehostOnHashChangeBound = true;
        window.addEventListener('hashchange', () => {
            if (!((typeof isAdmin !== 'undefined' && isAdmin) || (typeof isSuperAdmin !== 'undefined' && isSuperAdmin))) return;
            const desired = getDesiredHostIdForSession(getSessionFromUrl ? getSessionFromUrl() : currentSessionId);
            if (desired && desired !== hostPeerId) {
                startHostWithId(desired);
            }
        });
    }
}

// Client handles data from Host
function handleIncomingData(data) {
    if (data.type === 'sync_sessions') {
        if (typeof sessions !== 'undefined') {
            sessions = data.data;
            // Force re-render
            if (typeof renderAll === 'function') renderAll();
            // Also update session list specifically if renderAll covers it
        }
    } else if (data.type === 'force_session_switch') {
        if (typeof switchSession === 'function') switchSession(data.sessionId);
    } else if (data.type === 'delete_question') {
        // Force re-render for delete events
        if (typeof renderAll === 'function') renderAll();
    } else if (data.type === 'toggle_answered') {
        // Force re-render for answered status changes
        if (typeof renderAll === 'function') renderAll();
    } else if (data.type === 'comment') {
        // Force re-render for new comments
        if (typeof renderAll === 'function') renderAll();
    } else if (data.type === 'reaction') {
        // Force re-render for reaction changes
        if (typeof renderAll === 'function') renderAll();
    } else if (data.type === 'request_sync') {
        // Force re-render for upvote changes
        if (typeof renderAll === 'function') renderAll();
    } else if (data.type === 'ping') {
        // Respond to ping to keep connection alive
        // No action needed, just acknowledge
    } else if (data.type === 'pong') {
        // Respond to pong to keep connection alive
        // No action needed, just acknowledge
    }
}

// Host handles data from Clients
function handleHostIncomingData(data, sender) {
    if (data.type === 'submit_question') {
        const { sessionId, text } = data;
        const session = sessions[sessionId];
        if (session) {
            session.questions.unshift({ 
                id: Date.now(), 
                text: text, 
                upvotes: 0, 
                timestamp: new Date().toISOString(), 
                isAnswered: false,
                comments: [],
                reactions: {}
            });
            saveSessions();
            if (typeof renderQuestions === 'function') renderQuestions();
            broadcastSync();
        }
    } else if (data.type === 'delete_question') {
        const { sessionId, questionId } = data;
        const session = sessions[sessionId];
        if (session) {
            session.questions = session.questions.filter(q => q.id !== questionId);
            saveSessions();
            if (typeof renderQuestions === 'function') renderQuestions();
            broadcastSync();
        }
    } else if (data.type === 'toggle_answered') {
        const { sessionId, questionId } = data;
        const session = sessions[sessionId];
        if (session) {
            const q = session.questions.find(q => q.id === questionId);
            if (q) {
                q.isAnswered = !q.isAnswered;
                saveSessions();
                if (typeof renderQuestions === 'function') renderQuestions();
                broadcastSync();
            }
        }
    } else if (data.type === 'request_sync') {
        const { sessionId, questionId } = data;
        const session = sessions[sessionId];
        if (session) {
            const q = session.questions.find(q => q.id === questionId);
            if (q) {
                q.upvotes += 1;
                saveSessions();
                if (typeof renderQuestions === 'function') renderQuestions();
                broadcastSync();
            }
        }
    } else if (data.type === 'reaction') {
        const { sessionId, questionId, emoji, action } = data;
        const session = sessions[sessionId];
        if (session) {
            const q = session.questions.find(q => q.id === questionId);
            if (q) {
                if (!q.reactions) q.reactions = {};
                if (action === 'add') {
                    q.reactions[emoji] = (q.reactions[emoji] || 0) + 1;
                } else if (action === 'remove') {
                    delete q.reactions[emoji];
                }
                saveSessions();
                if (typeof renderQuestions === 'function') renderQuestions();
                broadcastSync();
            }
        }
    } else if (data.type === 'comment') {
        const { sessionId, questionId, text } = data;
        const session = sessions[sessionId];
        if (session) {
            const q = session.questions.find(q => q.id === questionId);
            if (q) {
                if (!q.comments) q.comments = [];
                q.comments.push({
                    id: Date.now(),
                    text: text,
                    timestamp: new Date().toISOString()
                });
                saveSessions();
                if (typeof renderQuestions === 'function') renderQuestions();
                broadcastSync();
            }
        }
    } else if (data.type === 'request_sync') {
        sender.send({ 
            type: 'sync_sessions', 
            data: sessions,
            currentSessionId: currentSessionId
        });
    } else if (data.type === 'ping') {
        // Respond to ping to keep connection alive
        sender.send({ type: 'pong' });
    } else if (data.type === 'force_session_switch') {
        // Host receives force session switch from admin
        const { sessionId } = data;
        if (typeof switchSession === 'function') switchSession(sessionId);
        // Broadcast to all clients
        connections.forEach(c => {
            if (c.open && c !== sender) {
                c.send({ type: 'force_session_switch', sessionId: sessionId });
            }
        });
    }
}

function broadcastSync() {
    if (!isHost) return;
    const payload = { 
        type: 'sync_sessions', 
        data: sessions,
        currentSessionId: currentSessionId
    };
    connections.forEach(c => {
        if (c.open) c.send(payload);
    });
}

// --- OVERRIDES ---

// Override submitQuestion
window.submitQuestion = function() {
    const input = document.getElementById('question-input');
    const text = input.value.trim();
    if (!text) return;

    // Check if client connected to host
    if (conn && conn.open) {
        conn.send({ type: 'submit_question', sessionId: currentSessionId, text: text });
        input.value = '';
    } else {
        const session = sessions[currentSessionId];
        if (session) {
            session.questions.unshift({ 
                id: Date.now(), 
                text: text, 
                upvotes: 0, 
                timestamp: new Date().toISOString(), 
                isAnswered: false,
                comments: [],
                reactions: {}
            });
            saveSessions();
            if (typeof renderQuestions === 'function') renderQuestions();
            input.value = '';
            broadcastSync();
        }
    }
};

// Override upvoteQuestion
window.upvoteQuestion = function(id) {
    if (conn && conn.open) {
        conn.send({ type: 'upvote', sessionId: currentSessionId, questionId: id });
    } else {
        const session = sessions[currentSessionId];
        if (!session) return;
        const q = session.questions.find(q => q.id === id);
        if (q) { 
            q.upvotes += 1; 
            saveSessions(); 
            if (typeof renderQuestions === 'function') renderQuestions();
            broadcastSync();
        }
    }
};

// Override addReaction
window.addReaction = function(qId, emoji) {
    if (conn && conn.open) {
        conn.send({ type: 'reaction', sessionId: currentSessionId, questionId: qId, emoji: emoji, action: 'add' });
    } else {
        const session = sessions[currentSessionId];
        if (!session) return;
        const q = session.questions.find(q => q.id === qId);
        if (q) {
            if (!q.reactions) q.reactions = {};
            q.reactions[emoji] = (q.reactions[emoji] || 0) + 1;
            saveSessions();
            if (typeof renderQuestions === 'function') renderQuestions();
            broadcastSync();
        }
    }
};

// Override submitComment
window.submitComment = function(qId) {
    const input = document.getElementById(`comment-input-${qId}`);
    const text = input.value.trim();
    if (!text) return;

    if (conn && conn.open) {
        conn.send({ type: 'comment', sessionId: currentSessionId, questionId: qId, text: text });
    } else {
        const session = sessions[currentSessionId];
        if (!session) return;
        const q = session.questions.find(q => q.id === qId);
        if (q) {
            if (!q.comments) q.comments = [];
            q.comments.push({
                id: Date.now(),
                text: text,
                timestamp: new Date().toISOString()
            });
            saveSessions();
            if (typeof renderQuestions === 'function') renderQuestions();
            broadcastSync();
        }
    }
};

// Override removeReaction for admin real-time sync
window.removeReaction = function(qId, emoji) {
    if (!isAdmin) return;
    if (conn && conn.open) {
        conn.send({ type: 'reaction', sessionId: currentSessionId, questionId: qId, emoji: emoji, action: 'remove' });
    } else {
        const session = sessions[currentSessionId];
        if (!session) return;
        const q = session.questions.find(q => q.id === qId);
        if (q && q.reactions) {
            delete q.reactions[emoji];
            saveSessions();
            if (typeof renderQuestions === 'function') renderQuestions();
            broadcastSync();
        }
    }
};

// Override deleteQuestion for admin real-time sync
window.deleteQuestion = function(qId) {
    if (!isAdmin) return;
    if (!confirm("Hapus pertanyaan ini?")) return;
    
    if (conn && conn.open) {
        conn.send({ type: 'delete_question', sessionId: currentSessionId, questionId: qId });
    } else {
        const session = sessions[currentSessionId];
        if (!session) return;
        session.questions = session.questions.filter(q => q.id !== qId);
        saveSessions();
        if (typeof renderQuestions === 'function') renderQuestions();
        broadcastSync();
    }
};

// Override toggleAnswered for admin real-time sync
window.toggleAnswered = function(id) {
    if (!isAdmin) return;
    
    if (conn && conn.open) {
        conn.send({ type: 'toggle_answered', sessionId: currentSessionId, questionId: id });
    } else {
        const session = sessions[currentSessionId];
        if (!session) return;
        const q = session.questions.find(q => q.id === id);
        if (q) { 
            q.isAnswered = !q.isAnswered; 
            saveSessions(); 
            if (typeof renderQuestions === 'function') renderQuestions();
            broadcastSync();
        }
    }
};

// Override showQRCode to include host ID
window.showQRCode = function(id) {
    const sessionId = id || currentSessionId;
    qrModalSessionId = sessionId;
    
    const modal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qrcode');
    const session = sessions[sessionId];
    if (!session) return;

    document.getElementById('qr-session-name').textContent = session.name;
    document.getElementById('qr-session-id-display').textContent = session.shortCode || sessionId.split('-').pop();
    
    modal.classList.remove('hidden');
    qrContainer.innerHTML = '';
    
    // Build absolute URL for QR
    const baseUrl = window.location.origin + window.location.pathname;
    let sessionUrl = baseUrl;
    
    const desiredId = getDesiredHostIdForSession(sessionId) || hostPeerId;
    if (desiredId) {
        sessionUrl += '?host=' + desiredId + '#' + sessionId;
    } else {
        sessionUrl += '#' + sessionId;
    }
    
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--main-primary').trim() || "#ea580c";
    
    new QRCode(qrContainer, { 
        text: sessionUrl, 
        width: 200, 
        height: 200, 
        colorDark : primaryColor, 
        colorLight : "#ffffff", 
        correctLevel : QRCode.CorrectLevel.H 
    });
};

// --- SESSION CODE MAPPING ---
const sessionCodeMap = new Map(); // Maps session short codes to Peer IDs

// Function to register session code with host Peer ID
function registerSessionCode(sessionCode, peerId) {
    sessionCodeMap.set(sessionCode.toUpperCase(), peerId);
    console.log(`Registered session code: ${sessionCode.toUpperCase()} -> ${peerId}`);
}

// Function to get Peer ID from session code
function getPeerIdBySessionCode(sessionCode) {
    return sessionCodeMap.get(sessionCode.toUpperCase());
}

// Function to join session by code (without QR)
function joinSessionByCode() {
    // Check browser compatibility first
    if (!checkWebRTCSupport()) {
        alert('Browser Anda tidak mendukung fitur realtime. Gunakan Chrome, Firefox, Safari, atau Edge.');
        return;
    }
    
    const codeInput = document.getElementById('join-session-code');
    const sessionCode = codeInput.value.trim().toUpperCase();
    
    if (!sessionCode) {
        alert('Masukkan kode session terlebih dahulu');
        return;
    }
    
    // Check if we're already connected to a host
    if (conn && conn.open) {
        alert('Anda sudah terhubung ke session lain');
        return;
    }
    
    // Direct deterministic ID based on short code
    const deterministicId = 'qa-' + sessionCode.toLowerCase();
    connectToHost(deterministicId);
    // Also keep optional mapping if available (legacy)
    const hostPeerId = getPeerIdBySessionCode(sessionCode);
    
    if (hostPeerId) {
        // Connect directly using stored mapping
        connectToHost(hostPeerId);
    } else {
        // Try to connect using broadcast discovery
        discoverAndConnect(sessionCode);
    }
    
    codeInput.value = '';
}

// Browser compatibility check
function checkWebRTCSupport() {
    const hasRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
    const hasWebSocket = 'WebSocket' in window;
    return hasRTCPeerConnection && hasWebSocket;
}

// Connect to host using Peer ID
function connectToHost(hostId) {
    lastHostTargetId = hostId;
    if (typeof Peer === 'undefined') {
        alert('Fitur realtime tidak tersedia. Pastikan koneksi internet stabil.');
        return;
    }
    if (conn && conn.open) {
        return;
    }
    ensurePeerReady(() => {
        conn = peer.connect(hostId);
        
        conn.on('open', () => {
            console.log('Connected to Host');
            conn.send({ type: 'request_sync' });
            
            if (pingIntervalId) {
                clearInterval(pingIntervalId);
            }
            pingIntervalId = setInterval(() => {
                if(conn && conn.open) conn.send({ type: 'ping' });
            }, 5000);
            
            alert('Berhasil terhubung ke session!');
            reconnectAttempts = 0;
            if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
        });
        
        conn.on('data', (data) => {
            handleIncomingData(data);
        });
        
        conn.on('close', () => {
            if (pingIntervalId) {
                clearInterval(pingIntervalId);
                pingIntervalId = null;
            }
            alert("Koneksi ke Host terputus.");
            scheduleReconnect();
        });
        
        conn.on('error', (err) => {
            console.error('Connection error:', err);
            alert('Gagal terhubung ke session. Pastikan host aktif dan kode benar.');
            scheduleReconnect();
        });
    });
}

function scheduleReconnect() {
    if (!lastHostTargetId) return;
    // Limit exponential backoff to 30s
    const base = 1500;
    const delay = Math.min(base * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
    if (reconnectTimerId) clearTimeout(reconnectTimerId);
    reconnectTimerId = setTimeout(() => {
        if (!conn || !conn.open) {
            connectToHost(lastHostTargetId);
        }
    }, delay);
}

// Mobile resilience: retry on network restore or tab foreground
window.addEventListener('online', () => {
    if (!conn || !conn.open) scheduleReconnect();
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!conn || !conn.open) scheduleReconnect();
    }
});
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        if (!conn || !conn.open) scheduleReconnect();
    }
});
window.addEventListener('pagehide', () => {
    // Clear timers to avoid leaks on iOS Safari bfcache
    if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null; }
});

// Broadcast discovery for session
function discoverAndConnect(sessionCode) {
    // This is a fallback method - broadcast to find host
    if (!peer) {
        peer = new Peer();
    }
    
    peer.on('open', (myId) => {
        console.log(`Starting discovery for session: ${sessionCode}`);
        
        // Try multiple discovery methods
        const discoveryMethods = [
            () => {
                return ['qa-' + sessionCode.toLowerCase()];
            },
            // Method 1: Try predefined patterns
            () => {
                const possibleHosts = [
                    'host-' + sessionCode.toLowerCase(), 
                    'session-' + sessionCode.toLowerCase(),
                    'qa-' + sessionCode.toLowerCase(),
                    'event-' + sessionCode.toLowerCase()
                ];
                return possibleHosts;
            },
            // Method 2: Try numeric patterns based on session code
            () => {
                if (sessionCode.match(/^\d+$/)) {
                    return ['host' + sessionCode, 'session' + sessionCode];
                }
                return [];
            },
            // Method 3: Try direct peer ID if session code looks like one
            () => {
                if (sessionCode.length > 10 && sessionCode.includes('-')) {
                    return [sessionCode];
                }
                return [];
            }
        ];
        
        let methodIndex = 0;
        let currentHosts = [];
        let hostIndex = 0;
        
        const tryNextMethod = () => {
            if (methodIndex >= discoveryMethods.length) {
                alert('Session tidak ditemukan. Pastikan kode benar dan host aktif.');
                return;
            }
            
            currentHosts = discoveryMethods[methodIndex]();
            methodIndex++;
            hostIndex = 0;
            
            if (currentHosts.length > 0) {
                tryConnect();
            } else {
                tryNextMethod();
            }
        };
        
        const tryConnect = () => {
            if (hostIndex >= currentHosts.length) {
                tryNextMethod();
                return;
            }
            
            const hostId = currentHosts[hostIndex];
            hostIndex++;
            
            console.log(`Trying to connect to: ${hostId}`);
            const testConn = peer.connect(hostId);
            
            let connectionTimeout = setTimeout(() => {
                testConn.close();
                tryConnect();
            }, 3000);
            
            testConn.on('open', () => {
                clearTimeout(connectionTimeout);
                conn = testConn;
                conn.send({ type: 'request_sync' });
                
                setInterval(() => {
                    if(conn && conn.open) conn.send({ type: 'ping' });
                }, 5000);
                
                alert('Berhasil terhubung ke session!');
            });
            
            testConn.on('error', () => {
                clearTimeout(connectionTimeout);
                setTimeout(tryConnect, 500);
            });
        };
        
        tryConnect();
    });
}

// Override createNewSession to register session code
const originalCreateNewSession = window.createNewSession;
window.createNewSession = function() {
    // Call original function
    if (originalCreateNewSession) {
        originalCreateNewSession();
    }
    
    // Register session code if we're host
    if (isHost && hostPeerId) {
        setTimeout(() => {
            // Fallback getCurrentSession function if not available
            const getCurrentSessionFallback = window.getCurrentSession || function() {
                if (typeof sessions !== 'undefined' && typeof currentSessionId !== 'undefined') {
                    return sessions[currentSessionId];
                }
                return null;
            };
            
            const currentSession = getCurrentSessionFallback();
            if (currentSession && currentSession.shortCode) {
                registerSessionCode(currentSession.shortCode, hostPeerId);
                
                // Update CODE span
                const codeSpan = document.querySelector('span.font-mono.tracking-tighter');
                if (codeSpan && codeSpan.textContent.includes('CODE:')) {
                    codeSpan.textContent = `CODE: ${currentSession.shortCode}`;
                }
            }
        }, 1000);
    }
};

// Initialize PeerJS when script loads
initPeer();
