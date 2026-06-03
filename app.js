// --- CONSTANTS ---
const SESSION_DURATION = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_ID = 'default-session';

// Default users if none exist
const DEFAULT_USERS = {
    'administrator': { username: 'administrator', password: 'admin123', role: 'administrator' },
    'admin': { username: 'admin', password: 'admin123', role: 'admin' }
};

// --- STATE ---
let sessions = JSON.parse(localStorage.getItem('qa_sessions')) || {};
let users = JSON.parse(localStorage.getItem('qa_users')) || DEFAULT_USERS;

// Default modules
const DEFAULT_MODULES = [
    {
        id: 'qa-system',
        name: 'TanyaAja Q&A',
        description: 'Sistem internal bawaan aplikasi utama.',
        type: 'internal',
        folder: 'Internal',
        icon: 'message-square',
        color: 'main-primary',
        textColor: 'main-text-primary',
        bgLight: 'bg-slate-50'
    },
    {
        id: 'qa-system-custom',
        name: 'Custom Q&A',
        description: 'Modul terpisah dengan tampilan kustom.',
        type: 'external',
        folder: '/modules/qa_system',
        icon: 'layout-template',
        color: 'bg-blue-600',
        textColor: 'text-blue-600',
        bgLight: 'bg-blue-50'
    }
];
let modules = JSON.parse(localStorage.getItem('qa_modules')) || DEFAULT_MODULES;

// Pastikan Administrator Utama selalu ada (Migration)
if (!users['administrator'] || (users['administrator'].role !== 'administrator' && users['administrator'].role !== 'superadmin')) {
    users['administrator'] = DEFAULT_USERS['administrator'];
    localStorage.setItem('qa_users', JSON.stringify(users));
}

let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null;

let currentSessionId = getSessionFromUrl() || DEFAULT_SESSION_ID;
let currentView = 'participant';
let isSuperAdmin = currentUser && (currentUser.role === 'administrator' || currentUser.role === 'superadmin');
let isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'administrator' || currentUser.role === 'superadmin');
let isClient = currentUser && currentUser.role === 'client';

// --- REAL-TIME SYNC (PeerJS) ---
let peer = null;
let conn = null; // Connection to Host (for Client)
let connections = []; // Connections from Clients (for Host)
let hostPeerId = null;
let isHost = false;

function initPeer() {
    const urlParams = new URLSearchParams(window.location.search);
    const remoteHostId = urlParams.get('host');

    if (remoteHostId) {
        // --- CLIENT MODE ---
        console.log("Initializing Client Mode...");
        peer = new Peer(); // Auto-generate ID
        
        peer.on('open', (id) => {
            console.log('My Peer ID: ' + id);
            conn = peer.connect(remoteHostId);
            
            conn.on('open', () => {
                console.log('Connected to Host');
                // Request initial state
                conn.send({ type: 'request_sync' });
                
                // Keep connection alive
                setInterval(() => {
                    if(conn.open) conn.send({ type: 'ping' });
                }, 5000);
            });

            conn.on('data', (data) => {
                handleIncomingData(data);
            });
            
            conn.on('close', () => {
                alert("Koneksi ke Host terputus.");
            });
        });
        
        peer.on('error', (err) => {
            console.error('PeerJS Error:', err);
            // alert("Gagal terhubung ke sesi realtime: " + err.type);
        });

    } else {
        // --- HOST MODE ---
        console.log("Initializing Host Mode...");
        // Try to retrieve previous ID to keep QR codes valid if possible, but PeerJS usually assigns new one unless we have API key
        peer = new Peer(); 
        
        peer.on('open', (id) => {
            console.log('Host Peer ID: ' + id);
            hostPeerId = id;
            isHost = true;
            
            // Render QR again to include host param
            if (qrModalSessionId) showQRCode(qrModalSessionId);
        });

        peer.on('connection', (c) => {
            console.log("New client connected:", c.peer);
            connections.push(c);
            
            c.on('data', (data) => {
                handleHostIncomingData(data, c);
            });
            
            c.on('close', () => {
                connections = connections.filter(conn => conn !== c);
            });
            
            // Send current state immediately
            c.send({ 
                type: 'sync_sessions', 
                data: sessions,
                currentSessionId: currentSessionId
            });
        });
    }
}

// Client handles data from Host
function handleIncomingData(data) {
    if (data.type === 'sync_sessions') {
        sessions = data.data;
        // Optionally sync current session if Host wants to force it
        // currentSessionId = data.currentSessionId; 
        renderAll();
    } else if (data.type === 'force_session_switch') {
        switchSession(data.sessionId);
    }
}

// Host handles data from Clients
function handleHostIncomingData(data, sender) {
    if (data.type === 'submit_question') {
        // Add question logic
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
            renderQuestions();
            broadcastSync();
        }
    } else if (data.type === 'upvote') {
        const { sessionId, questionId } = data;
        const session = sessions[sessionId];
        if (session) {
            const q = session.questions.find(q => q.id === questionId);
            if (q) {
                q.upvotes += 1;
                saveSessions();
                renderQuestions();
                broadcastSync();
            }
        }
    } else if (data.type === 'reaction') {
        const { sessionId, questionId, emoji, action } = data; // action: add/remove
        const session = sessions[sessionId];
        if (session) {
            const q = session.questions.find(q => q.id === questionId);
            if (q) {
                if (!q.reactions) q.reactions = {};
                if (action === 'add') {
                    q.reactions[emoji] = (q.reactions[emoji] || 0) + 1;
                } else if (action === 'remove' && isAdmin) { // Only admin can remove via remote? Actually usually only admin removes
                    delete q.reactions[emoji];
                }
                saveSessions();
                renderQuestions();
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
                renderQuestions();
                broadcastSync();
            }
        }
    } else if (data.type === 'request_sync') {
        sender.send({ 
            type: 'sync_sessions', 
            data: sessions,
            currentSessionId: currentSessionId
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

// --- APP FUNCTIONS ---

function showMasterDashboard() {
    document.getElementById('master-dashboard').classList.remove('hidden');
    document.getElementById('admin-auth-page').classList.add('hidden');
    document.getElementById('landing-page').classList.add('hidden');
    document.getElementById('main-nav').classList.add('hidden');
    document.getElementById('sidebar').classList.add('hidden');
    document.getElementById('sidebar-overlay').classList.add('hidden');
    
    // Update stats
    const userCount = Object.keys(users).length;
    document.getElementById('master-total-users').textContent = userCount;
    
    renderModules();
    lucide.createIcons();
}

function renderModules() {
    const container = document.getElementById('master-modules-container');
    if (!container) return;

    container.innerHTML = modules.map(m => `
        <div class="group bg-white rounded-[2rem] border-2 border-slate-100 p-8 shadow-sm hover:border-blue-500 hover:shadow-xl hover:shadow-blue-100/50 transition-all cursor-pointer relative overflow-hidden" onclick="launchApp('${m.id}')">
            <div class="absolute top-0 right-0 w-32 h-32 ${m.bgLight} rounded-bl-[5rem] -mr-10 -mt-10 group-hover:bg-blue-100 transition-colors"></div>
            <div class="relative z-10 space-y-6">
                <div class="flex justify-between items-start">
                    <div class="w-16 h-16 ${m.color} rounded-2xl flex items-center justify-center text-white shadow-lg">
                        <i data-lucide="${m.icon}" class="w-8 h-8"></i>
                    </div>
                    <div class="flex gap-2">
                        ${m.id === 'qa-system' ? `
                            <button onclick="event.stopPropagation(); openModuleSettings('landing')" class="p-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl transition-all" title="Settings Halaman Depan">
                                <i data-lucide="home" class="w-5 h-5"></i>
                            </button>
                            <button onclick="event.stopPropagation(); openModuleSettings('login')" class="p-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl transition-all" title="Settings Halaman Login">
                                <i data-lucide="lock" class="w-5 h-5"></i>
                            </button>
                        ` : `
                            <button onclick="event.stopPropagation(); openModuleSettings('${m.id}')" class="p-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl transition-all">
                                <i data-lucide="settings" class="w-5 h-5"></i>
                            </button>
                            ${m.type !== 'internal' && m.id !== 'qa-system-custom' ? `
                                <button onclick="event.stopPropagation(); deleteModule('${m.id}')" class="p-3 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl transition-all">
                                    <i data-lucide="trash-2" class="w-5 h-5"></i>
                                </button>
                            ` : ''}
                        `}
                    </div>
                </div>
                <div>
                    <h4 class="text-2xl font-black text-slate-900 group-hover:${m.textColor} transition-colors">${m.name}</h4>
                    <p class="text-slate-500 font-medium mt-2 leading-relaxed">${m.description}</p>
                </div>
                <div class="pt-4 flex items-center justify-between">
                    <span class="px-4 py-1.5 ${m.bgLight} ${m.textColor} text-xs font-black rounded-full uppercase tracking-widest">
                        ${m.type === 'internal' ? 'Sistem Utama' : `Folder: ${m.folder}`}
                    </span>
                    <div class="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center text-white group-hover:translate-x-1 transition-transform">
                        <i data-lucide="${m.type === 'internal' ? 'arrow-right' : 'external-link'}" class="w-5 h-5"></i>
                    </div>
                </div>
            </div>
        </div>
    `).join('') + `
        <!-- Placeholder for New App -->
        <div class="group bg-slate-50 border-2 border-dashed border-slate-200 rounded-[2rem] p-8 flex flex-col items-center justify-center text-center space-y-4 hover:bg-white hover:border-slate-300 transition-all cursor-pointer" onclick="showAddModuleModal()">
            <div class="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 group-hover:scale-110 transition-transform">
                <i data-lucide="plus" class="w-8 h-8"></i>
            </div>
            <div>
                <h4 class="text-xl font-black text-slate-400 uppercase tracking-tight">Tambah Modul</h4>
                <p class="text-slate-400 text-sm mt-1">Gunakan core logic untuk app baru</p>
            </div>
        </div>
    `;
    lucide.createIcons();
}

function launchApp(appId) {
    const module = modules.find(m => m.id === appId);
    if (!module) return;

    if (module.id === 'qa-system') {
        document.getElementById('master-dashboard').classList.add('hidden');
        showMainApp();
        updateAdminUI();
    } else if (module.type === 'external') {
        const path = module.folder.startsWith('/') ? module.folder.substring(1) : module.folder;
        window.open(`${path}/index.html?app_id=${module.id}`, '_blank');
    }
}

function deleteModule(id) {
     if (!confirm('Hapus modul ini? Data folder tidak akan terhapus secara fisik, hanya dari dashboard.')) return;
     modules = modules.filter(m => m.id !== id);
     localStorage.setItem('qa_modules', JSON.stringify(modules));
     renderModules();
 }

 function showAddModuleModal() {
     document.getElementById('add-module-modal').classList.remove('hidden');
     lucide.createIcons();
 }

 function hideAddModuleModal() {
     document.getElementById('add-module-modal').classList.add('hidden');
     document.getElementById('new-module-name').value = '';
     document.getElementById('new-module-desc').value = '';
     document.getElementById('new-module-folder').value = '';
 }

 function handleFolderSelect(event) {
     const files = event.target.files;
     if (files.length > 0) {
         const fullPath = files[0].webkitRelativePath;
         const folderName = fullPath.split('/')[0];
         const suggestedPath = `/modules/${folderName}`;
         document.getElementById('new-module-folder').value = suggestedPath;
         const nameInput = document.getElementById('new-module-name');
         if (!nameInput.value.trim()) {
             nameInput.value = folderName.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
         }
     }
 }

 function confirmAddModule() {
     const name = document.getElementById('new-module-name').value.trim();
     const desc = document.getElementById('new-module-desc').value.trim();
     const folder = document.getElementById('new-module-folder').value.trim();

     if (!name || !folder) return alert("Nama dan Folder harus diisi.");

     const id = 'module-' + Date.now();
     const newModule = {
         id: id,
         name: name,
         description: desc || 'Tidak ada deskripsi.',
         type: 'external',
         folder: folder,
         icon: 'layout-template',
         color: 'bg-slate-800',
         textColor: 'text-slate-800',
         bgLight: 'bg-slate-50'
     };

     modules.push(newModule);
     localStorage.setItem('qa_modules', JSON.stringify(modules));
     hideAddModuleModal();
     renderModules();
     alert(`Modul "${name}" berhasil ditambahkan!`);
 }

let currentConfigType = 'custom';

function handleImageUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('config-bg-image').value = e.target.result;
        };
        reader.readAsDataURL(file);
    }
}

function openModuleSettings(type) {
    currentConfigType = type || 'custom';
    const modal = document.getElementById('module-settings-modal');
    let configKey = 'qa_module_config';
    let defaultBg = 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?q=80&w=2070&auto=format&fit=crop';
    
    if (currentConfigType === 'landing') {
        configKey = 'qa_landing_config';
    } else if (currentConfigType === 'login') {
        configKey = 'qa_login_config';
        defaultBg = 'https://images.unsplash.com/photo-1497366216548-37526070297c?q=80&w=2069&auto=format&fit=crop';
    } else if (currentConfigType === 'main') {
        configKey = 'qa_main_config';
    } else {
        configKey = `qa_${currentConfigType}_config`;
    }

    const config = JSON.parse(localStorage.getItem(configKey)) || {
        primaryColor: (currentConfigType === 'landing' || currentConfigType === 'login' || currentConfigType === 'main') ? '#ea580c' : '#2563eb',
        bgImage: defaultBg
    };
    
    const modalTitle = document.querySelector('#module-settings-modal h3');
    if (currentConfigType === 'landing') modalTitle.textContent = 'Kustomisasi Landing Page';
    else if (currentConfigType === 'login') modalTitle.textContent = 'Kustomisasi Login Admin';
    else if (currentConfigType === 'main') modalTitle.textContent = 'Kustomisasi Sistem Utama';
    else modalTitle.textContent = 'Kustomisasi Modul Kustom';

    document.getElementById('config-primary-color').value = config.primaryColor;
    document.getElementById('config-primary-text').value = config.primaryColor;
    document.getElementById('config-bg-image').value = config.bgImage;
    
    modal.classList.remove('hidden');
    lucide.createIcons();

    const colorPicker = document.getElementById('config-primary-color');
    const colorText = document.getElementById('config-primary-text');
    
    colorPicker.oninput = (e) => colorText.value = e.target.value.toUpperCase();
    colorText.oninput = (e) => {
        if (/^#[0-9A-F]{6}$/i.test(e.target.value)) {
            colorPicker.value = e.target.value;
        }
    };
}

function closeModuleSettings() {
    document.getElementById('module-settings-modal').classList.add('hidden');
}

function saveModuleSettings() {
    const primaryColor = document.getElementById('config-primary-color').value;
    const bgImage = document.getElementById('config-bg-image').value.trim();
    
    const r = parseInt(primaryColor.slice(1, 3), 16);
    const g = parseInt(primaryColor.slice(3, 5), 16);
    const b = parseInt(primaryColor.slice(5, 7), 16);
    const primaryHover = `rgb(${Math.max(0, r-20)}, ${Math.max(0, g-20)}, ${Math.max(0, b-20)})`;

    const config = {
        primaryColor: primaryColor,
        primaryHover: primaryHover,
        logoUrl: (currentConfigType === 'landing' || currentConfigType === 'login' || currentConfigType === 'main') ? 'assets/img/logo.png' : '../../assets/img/logo.png',
        bgImage: bgImage
    };
    
    let configKey = 'qa_module_config';
    if (currentConfigType === 'landing') configKey = 'qa_landing_config';
    else if (currentConfigType === 'login') configKey = 'qa_login_config';
    else if (currentConfigType === 'main') configKey = 'qa_main_config';

    localStorage.setItem(configKey, JSON.stringify(config));
    
    if (currentConfigType === 'landing' || currentConfigType === 'main') {
        applyLandingConfig();
    }
    if (currentConfigType === 'login' || currentConfigType === 'main') {
        applyLoginConfig();
    }
    
    alert('Pengaturan berhasil disimpan!');
    closeModuleSettings();
}

function applyLandingConfig() {
    const config = JSON.parse(localStorage.getItem('qa_landing_config')) || JSON.parse(localStorage.getItem('qa_main_config'));
    if (config) {
        document.documentElement.style.setProperty('--main-primary', config.primaryColor);
        document.documentElement.style.setProperty('--main-hover', config.primaryHover);
        document.documentElement.style.setProperty('--landing-bg', `url(${config.bgImage})`);
    }
}

function applyLoginConfig() {
    const config = JSON.parse(localStorage.getItem('qa_login_config')) || JSON.parse(localStorage.getItem('qa_main_config'));
    if (config) {
        document.documentElement.style.setProperty('--login-bg', `url(${config.bgImage})`);
    }
}

let qrModalSessionId = null;

if (Object.keys(sessions).length === 0) {
    sessions[DEFAULT_SESSION_ID] = {
        id: DEFAULT_SESSION_ID,
        name: 'Sesi Utama',
        questions: [],
        startTime: Date.now().toString()
    };
    saveSessions();
}

function showAdminAuthPage() {
    document.getElementById('landing-page').classList.add('hidden');
    document.getElementById('admin-auth-page').classList.remove('hidden');
    lucide.createIcons();
}

function hideAdminAuthPage() {
    document.getElementById('admin-auth-page').classList.add('hidden');
    document.getElementById('landing-page').classList.remove('hidden');
}

function showLandingPage() {
    document.getElementById('landing-page').classList.remove('hidden');
    document.getElementById('admin-auth-page').classList.add('hidden');
    document.getElementById('thank-you-page').classList.add('hidden');
    document.getElementById('main-nav').classList.add('hidden');
    document.getElementById('main-content').classList.add('hidden');
    document.getElementById('sidebar').classList.add('-translate-x-full');
    document.getElementById('sidebar-overlay').classList.add('hidden');
    updateAdminUI(); 
}

function showMainApp() {
    document.getElementById('landing-page').classList.add('hidden');
    document.getElementById('admin-auth-page').classList.add('hidden');
    document.getElementById('thank-you-page').classList.add('hidden');
    document.getElementById('main-nav').classList.remove('hidden');
    document.getElementById('main-content').classList.remove('hidden');
    renderAll();
}

function exitEvent() {
    if (confirm("Apakah Anda yakin ingin keluar dari sesi ini?")) {
        document.getElementById('main-nav').classList.add('hidden');
        document.getElementById('main-content').classList.add('hidden');
        document.getElementById('thank-you-page').classList.remove('hidden');
        window.location.hash = ''; 
        lucide.createIcons();
    }
}

function loginAdminFromPage() {
    const user = document.getElementById('admin-page-username').value.trim();
    const pass = document.getElementById('admin-page-password').value.trim();
    
    const foundUser = Object.values(users).find(u => u.username === user && u.password === pass);
    
    if (foundUser) {
        currentUser = foundUser;
        isSuperAdmin = foundUser.role === 'administrator' || foundUser.role === 'superadmin';
        isAdmin = foundUser.role === 'admin' || foundUser.role === 'administrator' || foundUser.role === 'superadmin';
        isClient = foundUser.role === 'client';
        localStorage.setItem('currentUser', JSON.stringify(foundUser));
        
        if (isSuperAdmin) {
            showMasterDashboard();
        } else {
            showMainApp();
            updateAdminUI();
            if (window.innerWidth < 1024) {
                const sidebar = document.getElementById('sidebar');
                const overlay = document.getElementById('sidebar-overlay');
                sidebar.classList.remove('-translate-x-full');
                overlay.classList.remove('hidden');
            }
        }

        document.getElementById('admin-page-username').value = '';
        document.getElementById('admin-page-password').value = '';
    } else {
        alert("Username atau Password salah!");
    }
}

function logoutAdmin() {
    if (confirm("Logout dari akun ini?")) {
        currentUser = null;
        isSuperAdmin = false;
        isAdmin = false;
        isClient = false;
        localStorage.removeItem('currentUser');
        window.location.hash = '';
        document.getElementById('master-dashboard').classList.add('hidden');
        showLandingPage();
        updateAdminUI();
    }
}

function joinSessionByCode() {
    const code = document.getElementById('join-session-code').value.trim().toUpperCase();
    if (!code) return;
    
    const foundId = Object.keys(sessions).find(id => 
        (sessions[id].shortCode && sessions[id].shortCode === code) || 
        sessions[id].name.toLowerCase().includes(code.toLowerCase())
    );
    
    if (foundId) {
        switchSession(foundId);
        document.getElementById('join-session-code').value = '';
    } else {
        alert("Sesi tidak ditemukan. Pastikan kode benar.");
    }
}

function updateAdminUI() {
    applyLandingConfig();
    applyLoginConfig();
    const landingPage = document.getElementById('landing-page');
    const mainNav = document.getElementById('main-nav');
    const mainContent = document.getElementById('main-content');
    const badge = document.getElementById('admin-badge');
    const createContainer = document.getElementById('admin-create-container');
    const participantInfo = document.getElementById('participant-info');
    const sidebarToggle = document.querySelector('button[onclick="toggleSidebar()"]');
    const sidebar = document.getElementById('sidebar');
    const navPdfBtn = document.getElementById('nav-download-pdf');
    const navExitBtn = document.getElementById('nav-exit-btn');

    if (window.location.hash) {
        if (navPdfBtn) navPdfBtn.classList.remove('hidden');
        if (navExitBtn) navExitBtn.classList.remove('hidden');
    } else {
        if (navPdfBtn) navPdfBtn.classList.add('hidden');
        if (navExitBtn) navExitBtn.classList.add('hidden');
    }

    if (window.location.hash || isAdmin || isClient) {
        landingPage.classList.add('hidden');
        document.getElementById('admin-auth-page').classList.add('hidden');
        document.getElementById('thank-you-page').classList.add('hidden');
        mainNav.classList.remove('hidden');
        mainContent.classList.remove('hidden');
    } else {
        landingPage.classList.remove('hidden');
        document.getElementById('admin-auth-page').classList.add('hidden');
        mainNav.classList.add('hidden');
        mainContent.classList.add('hidden');
    }

    if (isAdmin || isClient) {
        badge.classList.remove('hidden');
        
        let roleLabel = 'CLIENT';
        let roleIcon = 'eye';
        let roleColor = 'text-blue-400';
        
        if (isSuperAdmin) {
            roleLabel = 'ADMINISTRATOR';
            roleIcon = 'shield-check';
            roleColor = 'main-text-primary';
        } else if (isAdmin) {
            roleLabel = 'ADMIN';
            roleIcon = 'user-check';
            roleColor = 'text-green-400';
        }

        badge.innerHTML = `
            <i data-lucide="${roleIcon}" class="w-3.5 h-3.5 ${roleColor}"></i>
            ${roleLabel}
            <div class="flex items-center gap-1.5 ml-1 pl-1.5 border-l border-slate-700">
                ${isSuperAdmin ? `
                    <button onclick="showCreateUserModal()" class="hover:main-text-primary transition-colors" title="Create User">
                        <i data-lucide="user-plus" class="w-3.5 h-3.5"></i>
                    </button>
                ` : ''}
                <button onclick="logoutAdmin()" class="hover:text-red-400 transition-colors" title="Logout">
                    <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
                </button>
            </div>
        `;
        lucide.createIcons();
        
        if (isAdmin) {
            createContainer.classList.remove('hidden');
            participantInfo.classList.add('hidden');
        } else {
            createContainer.classList.add('hidden');
            participantInfo.classList.remove('hidden');
            participantInfo.innerHTML = '<p class="text-xs text-blue-500 font-bold uppercase tracking-wider">Mode Viewers (Client)</p>';
        }
        
        if (sidebarToggle) sidebarToggle.classList.remove('hidden');
        sidebar.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
        createContainer.classList.add('hidden');
        participantInfo.classList.remove('hidden');
        participantInfo.innerHTML = '<p class="text-xs text-gray-400">Pilih sesi yang tersedia di bawah untuk bergabung.</p>';
        if (sidebarToggle) sidebarToggle.classList.add('hidden');
        sidebar.classList.add('hidden');
    }
}

function getSessionFromUrl() { return window.location.hash.substring(1); }
function saveSessions() { localStorage.setItem('qa_sessions', JSON.stringify(sessions)); }
function getCurrentSession() { 
    return sessions[currentSessionId] || sessions[DEFAULT_SESSION_ID] || Object.values(sessions)[0] || null; 
}

function checkSessions() {
    const now = Date.now();
    let changed = false;
    Object.keys(sessions).forEach(id => {
        const session = sessions[id];
        if ((now - parseInt(session.startTime)) > SESSION_DURATION) {
            session.questions = [];
            session.startTime = now.toString(); 
            changed = true;
        }
    });
    if (changed) { 
        saveSessions(); 
        if (typeof renderAll === 'function') renderAll(); 
    }
}

function showCreateUserModal() {
    if (!isSuperAdmin) return alert("Hanya Administrator Utama yang bisa mengelola user.");
    document.getElementById('create-user-modal').classList.remove('hidden');
    renderUserList();
    lucide.createIcons();
}

function hideCreateUserModal() {
    document.getElementById('create-user-modal').classList.add('hidden');
    document.getElementById('new-user-username').value = '';
    document.getElementById('new-user-password').value = '';
}

function renderUserList() {
    const tbody = document.getElementById('user-list-table-body');
    tbody.innerHTML = Object.values(users).map(u => `
        <tr class="hover:bg-slate-50 transition-colors">
            <td class="py-4 px-2">
                <div class="flex items-center gap-2">
                    <div class="w-8 h-8 rounded-full main-primary flex items-center justify-center text-white text-xs font-bold">
                        ${u.username.charAt(0).toUpperCase()}
                    </div>
                    <span class="font-medium text-slate-700">${u.username}</span>
                </div>
            </td>
            <td class="py-4 px-2">
                <span class="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                    u.role === 'administrator' || u.role === 'superadmin' ? 'bg-red-100 text-red-600' : 
                    (u.role === 'admin' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-600')
                }">
                    ${u.role}
                </span>
            </td>
            <td class="py-4 px-2 text-right">
                <div class="flex items-center justify-end gap-1">
                    <button onclick="showEditPasswordModal('${u.username}')" class="p-2 text-slate-300 hover:main-text-primary transition-colors" title="Edit Password">
                        <i data-lucide="key-round" class="w-4 h-4"></i>
                    </button>
                    ${u.username !== 'administrator' ? `
                        <button onclick="deleteUser('${u.username}')" class="p-2 text-slate-300 hover:text-red-500 transition-colors" title="Hapus User">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    ` : '<span class="text-[10px] text-slate-300 font-bold italic pr-2">System</span>'}
                </div>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

function confirmCreateUser() {
    if (!isSuperAdmin) return alert("Akses ditolak.");
    const user = document.getElementById('new-user-username').value.trim();
    const pass = document.getElementById('new-user-password').value.trim();
    const role = document.getElementById('new-user-role').value;

    if (!user || !pass) return alert("Username dan Password harus diisi.");
    if (users[user]) return alert("Username sudah digunakan.");

    users[user] = { username: user, password: pass, role: role };
    localStorage.setItem('qa_users', JSON.stringify(users));
    
    alert(`User ${user} berhasil dibuat sebagai ${role}.`);
    
    document.getElementById('new-user-username').value = '';
    document.getElementById('new-user-password').value = '';
    
    renderUserList();
}

function deleteUser(username) {
    if (!isSuperAdmin) return;
    if (username === 'administrator') return alert('Tidak bisa menghapus Super Admin!');
    if (!confirm(`Hapus user "${username}"?`)) return;

    delete users[username];
    localStorage.setItem('qa_users', JSON.stringify(users));
    renderUserList();
}

let editingUsername = null;
function showEditPasswordModal(username) {
    editingUsername = username;
    document.getElementById('edit-password-username').textContent = username;
    document.getElementById('edit-password-modal').classList.remove('hidden');
    document.getElementById('edit-user-new-password').focus();
}

function hideEditPasswordModal() {
    editingUsername = null;
    document.getElementById('edit-password-modal').classList.add('hidden');
    document.getElementById('edit-user-new-password').value = '';
}

function confirmEditPassword() {
    const newPass = document.getElementById('edit-user-new-password').value.trim();
    if (!newPass) return alert('Password baru tidak boleh kosong!');
    
    if (users[editingUsername]) {
        users[editingUsername].password = newPass;
        localStorage.setItem('qa_users', JSON.stringify(users));
        
        if (currentUser && currentUser.username === editingUsername) {
            currentUser.password = newPass;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
        }
        
        alert(`Password untuk "${editingUsername}" berhasil diperbarui!`);
        hideEditPasswordModal();
        renderUserList();
    }
}

function createNewSession() {
    if (!isAdmin) return alert("Hanya admin yang bisa membuat sesi.");
    const input = document.getElementById('new-session-name');
    input.value = `Sesi ${Object.keys(sessions).length + 1}`;
    document.getElementById('create-session-modal').classList.remove('hidden');
    input.focus();
    input.select();
}

function hideCreateSessionModal() {
    document.getElementById('create-session-modal').classList.add('hidden');
}

function confirmCreateSession() {
    const input = document.getElementById('new-session-name');
    const name = input.value.trim();
    if (!name) return alert("Nama sesi tidak boleh kosong.");

    const id = 'session-' + Date.now();
    const shortCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    sessions[id] = {
        id: id,
        shortCode: shortCode,
        name: name,
        questions: [],
        startTime: Date.now().toString()
    };
    saveSessions();
    broadcastSync();
    
    currentSessionId = id;
    window.location.hash = id;
    
    hideCreateSessionModal();
    if (window.innerWidth < 1024) toggleSidebar();
    
    setTimeout(() => {
        showQRCode(id);
        renderAll();
    }, 100);
}

function switchSession(id) {
    window.location.hash = id;
    if (window.innerWidth < 1024) toggleSidebar();
}

function deleteSession(id, event) {
    event.stopPropagation();
    if (!isAdmin && !isSuperAdmin) return alert("Hanya Administrator yang dapat menghapus sesi.");
    if (!confirm("Hapus sesi ini beserta semua pertanyaannya?")) return;
    
    delete sessions[id];
    saveSessions();
    broadcastSync();
    
    const remainingIds = Object.keys(sessions);
    if (currentSessionId === id) {
        if (remainingIds.length > 0) {
            window.location.hash = remainingIds[0];
        } else {
            window.location.hash = ''; 
            updateAdminUI();
        }
    } else {
        renderSessionsList();
    }
}

function deleteQuestion(qId) {
    if (!isAdmin) return;
    if (!confirm("Hapus pertanyaan ini?")) return;
    const session = getCurrentSession();
    if (!session) return;
    session.questions = session.questions.filter(q => q.id !== qId);
    saveSessions();
    renderQuestions();
    broadcastSync();
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const isHidden = sidebar.classList.contains('-translate-x-full');
    if (isHidden) { sidebar.classList.remove('-translate-x-full'); overlay.classList.remove('hidden'); }
    else { sidebar.classList.add('-translate-x-full'); overlay.classList.add('hidden'); }
}

function switchView(view) {
    currentView = view;
    const pView = document.getElementById('participant-view');
    const presView = document.getElementById('presenter-view');
    const btnP = document.getElementById('btn-participant');
    const btnPres = document.getElementById('btn-presenter');

    if (view === 'participant') {
        pView.classList.remove('hidden'); presView.classList.add('hidden');
        btnP.classList.add('bg-white', 'shadow-sm', 'main-text-primary'); btnP.classList.remove('text-gray-600');
        btnPres.classList.remove('bg-white', 'shadow-sm', 'main-text-primary'); btnPres.classList.add('text-gray-600');
    } else {
        pView.classList.add('hidden'); presView.classList.remove('hidden');
        btnPres.classList.add('bg-white', 'shadow-sm', 'main-text-primary'); btnPres.classList.remove('text-gray-600');
        btnP.classList.remove('bg-white', 'shadow-sm', 'main-text-primary'); btnP.classList.add('text-gray-600');
    }
    renderQuestions();
}

function renderSessionsList() {
    if (!isAdmin && !isClient) return;
    const list = document.getElementById('sessions-list');
    list.innerHTML = Object.keys(sessions).map(id => {
        const s = sessions[id];
        const isActive = id === currentSessionId;
        const Tag = isActive ? 'div' : 'button';
        const onclick = isActive ? '' : `onclick="switchSession('${id}')"`;
        
        return `
            <div class="group relative">
                <${Tag} ${onclick} class="w-full flex items-center justify-between p-3 rounded-xl transition-all ${isActive ? 'main-bg-light main-text-primary' : 'hover:bg-gray-50 text-gray-600 cursor-pointer text-left'}">
                    <div class="flex items-center gap-3 overflow-hidden pr-24">
                        <i data-lucide="${isActive ? 'play-circle' : 'circle'}" class="w-4 h-4 shrink-0 ${isActive ? 'main-text-primary' : 'text-gray-300'}"></i>
                        <div class="flex flex-col overflow-hidden">
                            <span class="font-bold truncate text-sm">${escapeHtml(s.name)}</span>
                            <span class="text-[10px] opacity-60 font-mono tracking-tighter">CODE: ${s.shortCode || 'N/A'}</span>
                        </div>
                    </div>
                </${Tag}>
                <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    ${(isAdmin || isClient) ? `
                        ${isActive ? `
                            <button onclick="downloadQuestionsPDF()" class="p-1.5 text-slate-400 hover:main-text-primary transition-colors" title="Download Report">
                                <i data-lucide="file-text" class="w-3.5 h-3.5"></i>
                            </button>
                        ` : ''}
                        <button onclick="copySessionLink('${id}')" class="px-2 py-1 text-[9px] font-black bg-slate-100 text-slate-600 rounded shadow-sm hover:bg-slate-200 transition-all uppercase tracking-tighter flex items-center gap-1">
                            <i data-lucide="link" class="w-2.5 h-2.5"></i>
                            Salin
                        </button>
                        <button onclick="showQRCode('${id}')" class="px-2 py-1 text-[9px] font-black main-primary text-white rounded shadow-sm opacity-90 hover:opacity-100 transition-all uppercase tracking-tighter">
                            QR
                        </button>
                    ` : ''}
                    ${(isAdmin || isSuperAdmin) ? `
                        <button onclick="deleteSession('${id}', event)" class="p-1 hover:text-red-500 transition-all" title="Hapus Sesi">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
    lucide.createIcons();
}

function renderQuestions() {
    const session = getCurrentSession();
    const list = document.getElementById('questions-list');
    const presList = document.getElementById('presenter-questions');
    const countLabel = document.getElementById('question-count');
    const sessionNameElem = document.getElementById('current-session-name');

    if (!session) {
        if (sessionNameElem) sessionNameElem.textContent = 'Tidak ada sesi aktif';
        if (list) list.innerHTML = '<div class="text-center py-12 text-gray-400">Pilih atau buat sesi baru untuk melihat pertanyaan.</div>';
        if (presList) presList.innerHTML = '<div class="text-center py-12 text-gray-400">Pilih atau buat sesi baru.</div>';
        if (countLabel) countLabel.textContent = '0 Pertanyaan';
        return;
    }
    
    if (sessionNameElem) sessionNameElem.textContent = session.name;
    const sorted = [...session.questions].sort((a, b) => b.upvotes - a.upvotes);
    countLabel.textContent = `${session.questions.length} Pertanyaan`;

    list.innerHTML = sorted.length === 0 
        ? `<div class="text-center py-12 text-gray-400">Belum ada pertanyaan di sesi ini.</div>`
        : sorted.map(q => {
            const comments = q.comments || [];
            const reactions = q.reactions || {};
            return `
            <div class="question-card bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden ${q.isAnswered ? 'opacity-80 bg-gray-50' : ''}">
                <div class="p-5 flex gap-4 items-start">
                    <div class="flex flex-col items-center gap-1">
                        <button onclick="upvoteQuestion(${q.id})" class="p-2 hover:bg-slate-50 rounded-lg main-text-primary transition-colors group">
                            <i data-lucide="chevron-up" class="w-6 h-6 group-hover:-translate-y-1 transition-transform"></i>
                        </button>
                        <span class="font-bold main-text-primary">${q.upvotes}</span>
                    </div>
                    <div class="flex-1">
                        <div class="flex justify-between items-start">
                            <p class="text-gray-800 leading-relaxed mb-2 font-medium">${escapeHtml(q.text)}</p>
                            ${isAdmin ? `<button onclick="deleteQuestion(${q.id})" class="text-gray-300 hover:text-red-500 p-1"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
                        </div>
                        <div class="flex flex-wrap items-center gap-4 text-xs text-gray-400">
                            <span class="flex items-center gap-1"><i data-lucide="clock" class="w-3 h-3"></i> ${formatTime(q.timestamp)}</span>
                            ${q.isAnswered ? '<span class="text-green-600 font-bold flex items-center gap-1"><i data-lucide="check-circle" class="w-3 h-3"></i> TERJAWAB</span>' : ''}
                            <button onclick="toggleComments(${q.id})" class="flex items-center gap-1.5 hover:opacity-70 transition-colors font-bold uppercase tracking-wider main-text-primary">
                                <i data-lucide="message-square" class="w-3.5 h-3.5"></i>
                                ${comments.length} Komentar
                            </button>
                        </div>

                        <!-- Emoji Reactions -->
                        <div class="flex flex-wrap gap-2 mt-3">
                            ${Object.entries(reactions).filter(([_, count]) => count > 0).map(([emoji, count]) => `
                                <div class="relative group/reac">
                                    <button onclick="addReaction(${q.id}, '${emoji}')" class="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-full transition-all group active:scale-90">
                                        <span class="text-base">${emoji}</span>
                                        <span class="font-bold main-text-primary">${count}</span>
                                    </button>
                                    ${isAdmin ? `
                                        <button onclick="removeReaction(${q.id}, '${emoji}')" class="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center opacity-0 group-hover/reac:opacity-100 transition-opacity shadow-sm hover:bg-red-600">
                                            <i data-lucide="x" class="w-2.5 h-2.5"></i>
                                        </button>
                                    ` : ''}
                                </div>
                            `).join('')}
                            <button onclick="promptNewReaction(${q.id})" class="flex items-center justify-center w-9 h-9 bg-slate-50 hover:bg-slate-100 border border-dashed border-slate-200 rounded-full transition-all group active:scale-90" title="Tambah Reaksi">
                                <i data-lucide="plus" class="w-4 h-4 text-slate-400 group-hover:main-text-primary"></i>
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Comments Section -->
                <div id="comments-${q.id}" class="hidden bg-slate-50 border-t border-gray-100 p-4 space-y-4">
                    <div class="space-y-3">
                        ${comments.map(c => `
                            <div class="flex gap-3 items-start">
                                <div class="w-7 h-7 bg-white rounded-full flex items-center justify-center border border-gray-200 shrink-0">
                                    <i data-lucide="user" class="w-4 h-4 text-slate-400"></i>
                                </div>
                                <div class="bg-white px-4 py-2 rounded-2xl border border-gray-100 shadow-sm flex-1">
                                    <p class="text-sm text-slate-700">${escapeHtml(c.text)}</p>
                                    <span class="text-[10px] text-slate-400 mt-1 block">${formatTime(c.timestamp)}</span>
                                </div>
                            </div>
                        `).join('')}
                        ${comments.length === 0 ? '<p class="text-center text-xs text-slate-400 py-2 italic">Belum ada komentar.</p>' : ''}
                    </div>
                    
                     <div class="flex gap-2 pt-2 border-t border-slate-200/50">
                         <input type="text" id="comment-input-${q.id}" onkeypress="if(event.key === 'Enter') submitComment(${q.id})" class="flex-1 px-4 py-2 text-sm bg-white border border-gray-200 rounded-xl focus:ring-2 main-border-primary focus:border-transparent outline-none transition-all" placeholder="Tulis komentar...">
                         <button onclick="submitComment(${q.id})" class="bg-slate-800 text-white p-2 rounded-xl hover:bg-slate-900 transition-all">
                             <i data-lucide="send" class="w-4 h-4"></i>
                         </button>
                     </div>
                </div>
            </div>
        `;
        }).join('');

    presList.innerHTML = sorted.length === 0
        ? `<div class="text-center py-12 text-gray-300 text-xl italic">Menunggu pertanyaan...</div>`
        : sorted.map((q, index) => `
            <div class="bg-white p-8 rounded-2xl shadow-md border-l-8 ${index === 0 ? 'main-border-primary' : 'border-gray-200'} flex justify-between items-center">
                <div class="flex-1">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="bg-gray-100 text-gray-600 px-2 py-1 rounded text-xs font-bold">#${index + 1}</span>
                        <span class="text-gray-400 text-xs">${formatTime(q.timestamp)}</span>
                    </div>
                    <h2 class="text-2xl font-semibold text-gray-800">${escapeHtml(q.text)}</h2>
                    <div class="flex flex-wrap gap-3 mt-4">
                        ${Object.entries(q.reactions || {}).map(([emoji, count]) => count > 0 ? `
                            <div class="flex items-center gap-1.5 px-3 py-1 bg-gray-50 rounded-full border border-gray-100">
                                <span class="text-xl">${emoji}</span>
                                <span class="font-bold text-gray-700">${count}</span>
                            </div>
                        ` : '').join('')}
                    </div>
                </div>
                <div class="text-center ml-8 px-6 border-l border-gray-100">
                    <div class="text-4xl font-black main-text-primary">${q.upvotes}</div>
                    <div class="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Upvotes</div>
                    ${isAdmin ? `
                    <button onclick="toggleAnswered(${q.id})" class="mt-4 px-4 py-1.5 rounded-full text-xs font-medium border ${q.isAnswered ? 'bg-green-50 text-green-600 border-green-200' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}">
                        ${q.isAnswered ? 'Selesai' : 'Tandai Terjawab'}
                    </button>
                    ` : ''}
                </div>
            </div>
        `).join('');
    lucide.createIcons();
}

function submitQuestion() {
    const input = document.getElementById('question-input');
    const text = input.value.trim();
    if (!text) return;
    
    if (conn && conn.open) {
        // Client: Send to Host
        conn.send({ 
            type: 'submit_question', 
            sessionId: currentSessionId, 
            text: text 
        });
        input.value = ''; // Optimistic clear
    } else {
        // Host or Offline
        const session = getCurrentSession();
        if (!session) return;
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
        renderQuestions(); 
        input.value = '';
        broadcastSync();
    }
}

function toggleComments(qId) {
    const commentSection = document.getElementById(`comments-${qId}`);
    if (commentSection) {
        commentSection.classList.toggle('hidden');
    }
}

function submitComment(qId) {
    const input = document.getElementById(`comment-input-${qId}`);
    const text = input.value.trim();
    if (!text) return;
    
    if (conn && conn.open) {
        conn.send({ type: 'comment', sessionId: currentSessionId, questionId: qId, text: text });
        input.value = '';
    } else {
        const session = getCurrentSession();
        if (!session) return;
        const question = session.questions.find(q => q.id === qId);
        if (question) {
            if (!question.comments) question.comments = [];
            question.comments.push({
                id: Date.now(),
                text: text,
                timestamp: new Date().toISOString()
            });
            saveSessions();
            renderQuestions();
            broadcastSync();
        }
    }
}

function upvoteQuestion(id) {
    if (conn && conn.open) {
        conn.send({ type: 'upvote', sessionId: currentSessionId, questionId: id });
    } else {
        const session = getCurrentSession();
        if (!session) return;
        const q = session.questions.find(q => q.id === id);
        if (q) { q.upvotes += 1; saveSessions(); renderQuestions(); broadcastSync(); }
    }
}

let activeReactionQuestionId = null;

function addReaction(qId, emoji) {
    if (conn && conn.open) {
        conn.send({ type: 'reaction', sessionId: currentSessionId, questionId: qId, emoji: emoji, action: 'add' });
    } else {
        const session = getCurrentSession();
        if (!session) return;
        const q = session.questions.find(q => q.id === qId);
        if (q) {
            if (!q.reactions) {
                q.reactions = {};
            }
            if (q.reactions[emoji] === undefined) {
                q.reactions[emoji] = 0;
            }
            q.reactions[emoji]++;
            saveSessions();
            renderQuestions();
            broadcastSync();
        }
    }
}

function removeReaction(qId, emoji) {
    if (!isAdmin) return;
    if (conn && conn.open) {
        conn.send({ type: 'reaction', sessionId: currentSessionId, questionId: qId, emoji: emoji, action: 'remove' });
    } else {
        const session = getCurrentSession();
        if (!session) return;
        const q = session.questions.find(q => q.id === qId);
        if (q && q.reactions) {
            delete q.reactions[emoji];
            saveSessions();
            renderQuestions();
            broadcastSync();
        }
    }
}

function promptNewReaction(qId) {
    activeReactionQuestionId = qId;
    document.getElementById('emoji-modal').classList.remove('hidden');
    document.getElementById('custom-emoji-input').value = '';
    lucide.createIcons();
}

function hideEmojiModal() {
    document.getElementById('emoji-modal').classList.add('hidden');
    activeReactionQuestionId = null;
}

function selectEmoji(emoji) {
    if (activeReactionQuestionId) {
        addReaction(activeReactionQuestionId, emoji);
        hideEmojiModal();
    }
}

function submitCustomEmoji() {
    const input = document.getElementById('custom-emoji-input');
    const emoji = input.value.trim();
    if (emoji && activeReactionQuestionId) {
        addReaction(activeReactionQuestionId, emoji);
        hideEmojiModal();
    }
}

function toggleAnswered(id) {
    if (!isAdmin) return;
    const session = getCurrentSession();
    if (!session) return;
    const q = session.questions.find(q => q.id === id);
    if (q) { q.isAnswered = !q.isAnswered; saveSessions(); renderQuestions(); broadcastSync(); }
}

function updateTimer() {
    const session = getCurrentSession();
    if (!session) return;
    const now = Date.now();
    const elapsed = now - parseInt(session.startTime);
    const remaining = Math.max(0, SESSION_DURATION - elapsed);
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
    document.getElementById('session-timer').textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    if (remaining <= 0) checkSessions();
}

function showQRCode(id) {
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
    // Include Host ID if we are host
    let baseUrl = window.location.origin + window.location.pathname;
    
    // Add ?host=MY_PEER_ID if we have one
    if (hostPeerId) {
        baseUrl += `?host=${hostPeerId}`;
    }
    
    const sessionUrl = baseUrl + '#' + sessionId;
    
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--main-primary').trim() || "#ea580c";
    
    new QRCode(qrContainer, { 
        text: sessionUrl, 
        width: 200, 
        height: 200, 
        colorDark : primaryColor, 
        colorLight : "#ffffff", 
        correctLevel : QRCode.CorrectLevel.H 
    });
}

function hideQRCode() { 
    document.getElementById('qr-modal').classList.add('hidden');
    qrModalSessionId = null;
}

function downloadQRCode() {
    const qrCanvas = document.querySelector('#qrcode canvas');
    if (!qrCanvas || !qrModalSessionId) return;
    
    const session = sessions[qrModalSessionId];
    if (!session) return;
    
    const suffix = session.shortCode || qrModalSessionId.split('-').pop();
    const link = document.createElement('a');
    link.download = `barcode-${session.name.replace(/\s+/g, '-').toLowerCase()}-${suffix}.png`;
    link.href = qrCanvas.toDataURL("image/png");
    link.click();
}

function downloadQuestionsPDF() {
    const session = getCurrentSession();
    if (!session || !session.questions || session.questions.length === 0) {
        alert("Tidak ada pertanyaan untuk diunduh.");
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--main-primary').trim() || "#ea580c";
    const hexToRgb = (hex) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return [r, g, b];
    };
    const rgbColor = hexToRgb(primaryColor);

    const logoUrl = 'assets/img/logo.png';
    
    doc.setFontSize(20);
    doc.setTextColor(rgbColor[0], rgbColor[1], rgbColor[2]);
    doc.text("Laporan Pertanyaan Q&A", 14, 22);
    
    try {
        doc.addImage(logoUrl, 'PNG', 140, 8, 50, 20);
    } catch (e) {
        console.warn("Logo tidak ditemukan atau gagal dimuat:", e);
    }
    
    doc.setFontSize(12);
    doc.setTextColor(100, 116, 139); 
    doc.text(`Sesi: ${session.name}`, 14, 32);
    doc.text(`Waktu Unduh: ${new Date().toLocaleString('id-ID')}`, 14, 39);
    
    const tableData = session.questions
        .sort((a, b) => b.upvotes - a.upvotes)
        .map((q, index) => {
            const reactionsStr = Object.entries(q.reactions || {})
                .filter(([_, count]) => count > 0)
                .map(([emoji, count]) => `${emoji} ${count}`)
                .join(', ');
            
            return [
                index + 1,
                q.text,
                q.upvotes,
                reactionsStr || '-',
                q.isAnswered ? 'Ya' : 'Tidak',
                formatTime(q.timestamp)
            ];
        });

    doc.autoTable({
        startY: 50,
        head: [['No', 'Pertanyaan', 'Upvotes', 'Reaksi', 'Terjawab', 'Waktu']],
        body: tableData,
        headStyles: { fillColor: rgbColor },
        styles: { font: 'helvetica', fontSize: 10 },
        columnStyles: {
            0: { cellWidth: 10 },
            1: { cellWidth: 'auto' },
            2: { cellWidth: 20, halign: 'center' },
            3: { cellWidth: 30 },
            4: { cellWidth: 20, halign: 'center' },
            5: { cellWidth: 30 }
        }
    });

    doc.save(`Q&A-${session.name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.pdf`);
}

function copySessionLink(id) {
    const sessionId = id || qrModalSessionId || currentSessionId;
    let baseUrl = window.location.origin + window.location.pathname;
    if (hostPeerId) {
        baseUrl += `?host=${hostPeerId}`;
    }
    const sessionUrl = baseUrl + '#' + sessionId;
    
    navigator.clipboard.writeText(sessionUrl).then(() => {
        alert('Link sesi berhasil disalin ke clipboard!');
    }).catch(err => {
        console.error('Gagal menyalin link: ', err);
        const el = document.createElement('textarea');
        el.value = sessionUrl;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        alert('Link sesi berhasil disalin!');
    });
}

function renderAll() { renderSessionsList(); renderQuestions(); }
function formatTime(iso) { return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); }
function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

// --- LISTENERS ---
window.addEventListener('hashchange', () => { 
    currentSessionId = getSessionFromUrl() || DEFAULT_SESSION_ID; 
    updateAdminUI();
    renderAll(); 
});
window.addEventListener('storage', (e) => { if (e.key === 'qa_sessions') { sessions = JSON.parse(e.newValue); renderAll(); } });

['admin-page-username', 'admin-page-password'].forEach(id => {
    document.getElementById(id).addEventListener('keypress', (e) => { if (e.key === 'Enter') loginAdminFromPage(); });
});

document.getElementById('new-session-name').addEventListener('keypress', (e) => { if (e.key === 'Enter') confirmCreateSession(); });

document.getElementById('join-session-code').addEventListener('keypress', (e) => { if (e.key === 'Enter') joinSessionByCode(); });

// --- INIT ---
setInterval(updateTimer, 1000);

if (currentUser) {
    if (isSuperAdmin) {
        showMasterDashboard();
    } else {
        showMainApp();
        updateAdminUI();
    }
} else {
    showLandingPage();
}

checkSessions();
applyLandingConfig();
applyLoginConfig();
lucide.createIcons();
renderAll();
lucide.createIcons();

// Initialize Real-time Peer Connection
initPeer();
