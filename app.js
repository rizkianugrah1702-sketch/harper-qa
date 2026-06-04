// --- CONSTANTS ---
const API_URL = 'https://script.google.com/macros/s/AKfycbwm2pHn9-iSFOVmBDu1skr1sjexKV385mo5BkzwWdKxEi6k9RQJeRojuIimqUiLWVaVdg/exec';
const SESSION_DURATION = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_ID = 'default-session';

// --- STATE ---
let sessions = JSON.parse(localStorage.getItem('qa_sessions')) || {};
let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null;
let currentSessionId = getSessionFromUrl() || '';
let isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'administrator');
let activeReactionQuestionId = null;

// --- APP INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

function initApp() {
    updateAdminUI();
    if (window.location.hash) {
        currentSessionId = getSessionFromUrl();
        if (isAdmin) {
            showAdminQADashboard(currentSessionId);
        } else {
            showParticipantView(currentSessionId);
        }
    } else {
        if (isAdmin) {
            showMasterDashboard();
        } else {
            showLandingPage();
        }
    }
    lucide.createIcons();
}

// --- NAVIGATION & VIEWS ---

function showLandingPage() {
    hideAllPages();
    document.getElementById('landing-page').classList.remove('hidden');
    lucide.createIcons();
}

function showMasterDashboard() {
    if (!isAdmin) return showLandingPage();
    hideAllPages();
    document.getElementById('master-dashboard').classList.remove('hidden');
    lucide.createIcons();
}

function showAdminAuthPage() {
    hideAllPages();
    document.getElementById('admin-auth-page').classList.remove('hidden');
    lucide.createIcons();
}

function hideAdminAuthPage() {
    showLandingPage();
}

function showSessionManagement() {
    if (!isAdmin) return showLandingPage();
    hideAllPages();
    document.getElementById('session-management-page').classList.remove('hidden');
    renderAdminSessions();
    lucide.createIcons();
}

function showAdminQADashboard(sessionId) {
    if (!isAdmin) return showParticipantView(sessionId);
    hideAllPages();
    currentSessionId = sessionId;
    const session = sessions[sessionId];
    if (session) {
        document.getElementById('active-session-name').textContent = session.name;
        document.getElementById('active-session-code-display').textContent = `#${session.shortCode || sessionId}`;
    }
    document.getElementById('admin-qa-dashboard').classList.remove('hidden');
    fetchQuestionsFromServer();
    lucide.createIcons();
}

function showParticipantView(sessionId) {
    hideAllPages();
    currentSessionId = sessionId;
    const session = sessions[sessionId];
    if (session) {
        document.getElementById('part-session-name').textContent = session.name;
    }
    document.getElementById('participant-dark-view').classList.remove('hidden');
    fetchQuestionsFromServer();
    lucide.createIcons();
}

function hideAllPages() {
    const pages = ['landing-page', 'master-dashboard', 'session-management-page', 'admin-qa-dashboard', 'participant-dark-view', 'admin-auth-page'];
    pages.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

function exitEvent() {
    if (confirm("Apakah Anda yakin ingin keluar dari sesi ini?")) {
        window.location.hash = '';
        showLandingPage();
    }
}

// --- AUTH ---

async function loginAdminFromPage() {
    const user = document.getElementById('admin-page-username').value.trim();
    const pass = document.getElementById('admin-page-password').value.trim();
    
    if (!user || !pass) return alert("Username dan Password harus diisi.");

    const btn = document.querySelector('button[onclick="loginAdminFromPage()"]');
    btn.innerHTML = 'Memproses...';
    btn.disabled = true;

    try {
        const params = new URLSearchParams({ action: 'login_admin', username: user, password: pass });
        const response = await fetch(`${API_URL}?${params.toString()}`);
        const result = await response.json();

        if (result.status === "success") {
            currentUser = { username: user, role: result.role };
            isAdmin = true;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            showMasterDashboard();
        } else {
            alert(result.message || "Login Gagal!");
        }
    } catch (error) {
        console.error("Login error:", error);
        alert("Koneksi gagal ke server Google.");
    } finally {
        btn.innerHTML = 'Masuk Sekarang';
        btn.disabled = false;
    }
}

function logoutAdmin() {
    if (confirm("Logout dari akun ini?")) {
        currentUser = null;
        isAdmin = false;
        localStorage.removeItem('currentUser');
        window.location.hash = '';
        showLandingPage();
    }
}

async function joinSessionByCode() {
    const code = document.getElementById('join-session-code').value.trim().toUpperCase();
    if (!code) return;
    
    const btn = document.querySelector('button[onclick="joinSessionByCode()"]');
    btn.innerHTML = '...';

    try {
        const response = await fetch(`${API_URL}?action=join_session&code=${code}`);
        const result = await response.json();

        if (result.status === 'success') {
            sessions[code] = { id: code, shortCode: code, name: result.session_name, questions: [] };
            saveSessions();
            currentSessionId = code;
            window.location.hash = code;
            showParticipantView(code);
        } else {
            alert(result.message);
        }
    } catch (error) {
        alert("Gagal terhubung ke server.");
    } finally {
        btn.innerHTML = 'Gabung Sesi';
    }
}

// --- SESSION MANAGEMENT ---

function renderAdminSessions() {
    const tbody = document.getElementById('admin-sessions-table-body');
    const sessionsList = Object.values(sessions);
    document.getElementById('total-sessions-count').textContent = sessionsList.length;

    tbody.innerHTML = sessionsList.map(s => `
        <tr class="hover:bg-slate-50 transition-colors cursor-pointer" onclick="showAdminQADashboard('${s.id}')">
            <td class="px-6 py-4">
                <div class="flex flex-col">
                    <span class="font-bold text-slate-900">${escapeHtml(s.name)} <span class="text-slate-400 font-normal ml-1">(#${s.shortCode})</span></span>
                </div>
            </td>
            <td class="px-6 py-4">
                <div class="flex items-center gap-2 text-[#ea580c] text-sm font-semibold">
                    <i data-lucide="radio" class="w-4 h-4"></i>
                    Aktif
                </div>
            </td>
            <td class="px-6 py-4 text-right" onclick="event.stopPropagation()">
                <div class="flex justify-end gap-3">
                    <button onclick="showQRCode('${s.id}')" class="p-2 text-slate-400 hover:text-[#ea580c]"><i data-lucide="share-2" class="w-5 h-5"></i></button>
                    <button onclick="deleteSession('${s.id}')" class="p-2 text-slate-400 hover:text-red-500"><i data-lucide="trash-2" class="w-5 h-5"></i></button>
                </div>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

function showCreateSessionModal() {
    document.getElementById('create-session-modal').classList.remove('hidden');
}

function hideCreateSessionModal() {
    document.getElementById('create-session-modal').classList.add('hidden');
}

async function confirmCreateSession() {
    const name = document.getElementById('new-session-name').value.trim();
    if (!name) return alert("Nama sesi harus diisi.");
    
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
        await fetch(`${API_URL}?action=create_session&code=${code}&name=${name}`);
        sessions[code] = { id: code, shortCode: code, name: name, questions: [] };
        saveSessions();
        hideCreateSessionModal();
        renderAdminSessions();
    } catch (e) {
        alert("Gagal membuat sesi.");
    }
}

function deleteSession(id) {
    if (confirm("Hapus sesi ini?")) {
        delete sessions[id];
        saveSessions();
        renderAdminSessions();
    }
}

// --- Q&A LOGIC ---

async function fetchQuestionsFromServer() {
    if (!currentSessionId) return;
    try {
        const response = await fetch(`${API_URL}?action=get_questions&code=${currentSessionId}`);
        const questions = await response.json();
        if (Array.isArray(questions)) {
            sessions[currentSessionId].questions = questions.map((q, idx) => ({
                id: q.id || idx,
                text: q.content,
                upvotes: q.votes || 0,
                timestamp: q.time,
                isAnswered: q.isAnswered || false,
                comments: q.comments ? (typeof q.comments === 'string' ? JSON.parse(q.comments) : q.comments) : [],
                reactions: q.reactions ? (typeof q.reactions === 'string' ? JSON.parse(q.reactions) : q.reactions) : {}
            }));
            renderQuestions();
        }
    } catch (e) {
        console.error("Fetch error:", e);
    }
}

function renderQuestions() {
    if (isAdmin) {
        renderAdminQuestions();
    } else {
        renderPartQuestions();
    }
}

function renderAdminQuestions() {
    const list = document.getElementById('admin-questions-list');
    const session = sessions[currentSessionId];
    if (!session) return;
    
    document.getElementById('admin-question-count').textContent = session.questions.length;
    
    list.innerHTML = session.questions.map(q => `
        <div class="bg-white border border-slate-100 rounded-xl p-6 shadow-sm space-y-4">
            <div class="flex justify-between items-start">
                <div class="flex gap-3">
                    <div class="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400">
                        <i data-lucide="user" class="w-6 h-6"></i>
                    </div>
                    <div>
                        <div class="font-bold text-slate-900">Anonymous <span class="text-slate-400 font-normal ml-2">${formatTime(q.timestamp)}</span></div>
                        <p class="text-lg text-slate-800 mt-1">${escapeHtml(q.text)}</p>
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <div class="flex items-center gap-1 text-slate-500 font-bold">
                        ${q.upvotes} <i data-lucide="thumbs-up" class="w-5 h-5"></i>
                    </div>
                </div>
            </div>
            
            <div class="flex gap-2">
                ${Object.entries(q.reactions).map(([emoji, count]) => `
                    <span class="px-2 py-1 bg-slate-50 rounded-full text-sm border border-slate-100">${emoji} ${count}</span>
                `).join('')}
                <button onclick="promptNewReaction(${q.id})" class="p-1 text-slate-400 hover:text-[#ea580c]"><i data-lucide="smile" class="w-5 h-5"></i></button>
            </div>

            <div class="pl-12 space-y-3">
                ${q.comments.map(c => `
                    <div class="bg-slate-50 p-3 rounded-lg text-sm text-slate-700">
                        <span class="font-bold text-[#ea580c]">Host:</span> ${escapeHtml(c.text)}
                    </div>
                `).join('')}
                <div class="flex gap-2">
                    <input type="text" id="comment-input-${q.id}" class="flex-1 bg-slate-50 border-none rounded-lg text-sm px-4 py-2" placeholder="Balas sebagai host...">
                    <button onclick="submitComment(${q.id})" class="text-[#ea580c] font-bold text-sm">Balas</button>
                </div>
            </div>
        </div>
    `).join('');
    lucide.createIcons();
}

function renderPartQuestions() {
    const list = document.getElementById('part-questions-list');
    const session = sessions[currentSessionId];
    if (!session) return;

    document.getElementById('part-question-count-label').textContent = `${session.questions.length} pertanyaan`;

    list.innerHTML = session.questions.map(q => `
        <div class="bg-[#111] border border-[#222] rounded-2xl p-6 space-y-4 shadow-lg">
            <div class="flex justify-between items-start">
                <div class="flex gap-4">
                    <div class="w-10 h-10 bg-[#222] rounded-full flex items-center justify-center text-slate-500">
                        <i data-lucide="user" class="w-6 h-6"></i>
                    </div>
                    <div>
                        <div class="font-bold text-white">Anonymous <span class="text-slate-500 font-normal ml-2">${formatTime(q.timestamp)}</span></div>
                        <p class="text-lg text-slate-200 mt-1">${escapeHtml(q.text)}</p>
                    </div>
                </div>
                <button onclick="upvoteQuestion(${q.id})" class="flex items-center gap-2 text-slate-400 hover:text-[#ea580c] transition-colors">
                    <span class="font-bold">${q.upvotes}</span>
                    <i data-lucide="thumbs-up" class="w-5 h-5"></i>
                </button>
            </div>

            <div class="flex gap-2">
                ${Object.entries(q.reactions).map(([emoji, count]) => `
                    <button onclick="addReaction(${q.id}, '${emoji}')" class="px-3 py-1 bg-[#1a1a1a] rounded-full text-sm border border-[#333] text-slate-300 hover:border-[#ea580c] transition-colors">
                        ${emoji} ${count}
                    </button>
                `).join('')}
                <button onclick="promptNewReaction(${q.id})" class="p-1 text-slate-500 hover:text-white"><i data-lucide="smile" class="w-5 h-5"></i></button>
            </div>

            <div class="pl-14 space-y-3">
                ${q.comments.map((c, idx) => `
                    <div class="bg-[#1a1a1a] p-3 rounded-xl text-sm text-slate-300 border border-[#222]">
                        <span class="font-bold text-[#ea580c]">Host:</span> ${escapeHtml(c.text)}
                        <div class="mt-2 flex gap-2">
                             <button onclick="addReactionToComment(${q.id}, ${idx}, '👍')" class="text-xs text-slate-500 hover:text-[#ea580c]">👍</button>
                             <button onclick="addReactionToComment(${q.id}, ${idx}, '❤️')" class="text-xs text-slate-500 hover:text-[#ea580c]">❤️</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
    lucide.createIcons();
}

async function submitQuestion() {
    if (isAdmin) return alert("Host tidak bisa mengirim pertanyaan, hanya peserta.");
    const input = document.getElementById('part-question-input');
    const text = input.value.trim();
    if (!text) return;
    
    try {
        const params = new URLSearchParams({ action: 'submit_question', session_code: currentSessionId, content: text });
        await fetch(`${API_URL}?${params.toString()}`);
        input.value = '';
        fetchQuestionsFromServer();
    } catch (e) {
        alert("Gagal mengirim pertanyaan.");
    }
}

async function submitComment(qId) {
    if (!isAdmin) return alert("Hanya Host yang bisa memberikan komentar.");
    const input = document.getElementById(`comment-input-${qId}`);
    const text = input.value.trim();
    if (!text) return;

    const question = sessions[currentSessionId].questions.find(q => q.id === qId);
    if (!question) return;

    try {
        const params = new URLSearchParams({ action: 'submit_comment', session_code: currentSessionId, question_text: question.text, content: text });
        await fetch(`${API_URL}?${params.toString()}`);
        input.value = '';
        fetchQuestionsFromServer();
    } catch (e) {
        alert("Gagal mengirim komentar.");
    }
}

async function upvoteQuestion(qId) {
    const question = sessions[currentSessionId].questions.find(q => q.id === qId);
    if (!question) return;
    try {
        const params = new URLSearchParams({ action: 'upvote_question', session_code: currentSessionId, question_text: question.text });
        await fetch(`${API_URL}?${params.toString()}`);
        fetchQuestionsFromServer();
    } catch (e) {}
}

async function addReaction(qId, emoji) {
    const question = sessions[currentSessionId].questions.find(q => q.id === qId);
    if (!question) return;
    try {
        const params = new URLSearchParams({ action: 'submit_reaction', session_code: currentSessionId, question_text: question.text, emoji: emoji });
        await fetch(`${API_URL}?${params.toString()}`);
        fetchQuestionsFromServer();
    } catch (e) {}
}

// --- UTILS ---

function saveSessions() { localStorage.setItem('qa_sessions', JSON.stringify(sessions)); }
function getSessionFromUrl() { return window.location.hash.substring(1); }
function formatTime(ts) { 
    if (!ts) return '';
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(text) { 
    const d = document.createElement('div'); 
    d.textContent = text; 
    return d.innerHTML; 
}

function promptNewReaction(qId) {
    activeReactionQuestionId = qId;
    document.getElementById('emoji-modal').classList.remove('hidden');
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

function updateAdminUI() {
    // Basic UI logic for global states
}

function showQRCode(id) {
    const sessionId = id || currentSessionId;
    const modal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qrcode');
    const session = sessions[sessionId];
    if (!session) return;

    document.getElementById('qr-session-name').textContent = session.name;
    document.getElementById('qr-session-id-display').textContent = `#${session.shortCode || sessionId}`;
    
    modal.classList.remove('hidden');
    qrContainer.innerHTML = '';
    const sessionUrl = window.location.origin + window.location.pathname + '#' + sessionId;
    new QRCode(qrContainer, { text: sessionUrl, width: 200, height: 200, colorDark : "#008248", colorLight : "#ffffff" });
}

function hideQRCode() { document.getElementById('qr-modal').classList.add('hidden'); }

function copySessionLink(id) {
    const sessionId = id || currentSessionId;
    const sessionUrl = window.location.origin + window.location.pathname + '#' + sessionId;
    navigator.clipboard.writeText(sessionUrl).then(() => alert("Link disalin!"));
}

setInterval(fetchQuestionsFromServer, 5000);
