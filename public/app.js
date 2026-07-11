'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl    = document.getElementById('messages');
const quickRepliesEl = document.getElementById('quick-replies');
const inputEl       = document.getElementById('text-input');
const sendBtn       = document.getElementById('send-btn');
const headerDot     = document.getElementById('header-dot');
const headerSub     = document.getElementById('header-sub');
const banner        = document.getElementById('payment-banner');
const bannerText    = document.getElementById('payment-banner-text');
const bannerClose   = document.getElementById('banner-close');

let sending = false;

// ── Markdown-lite: convert *text* to <strong>text</strong> ───────────────────
function parseBold(text) {
  return text.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
}

// ── Append a message bubble ───────────────────────────────────────────────────
function appendMessage(role, text, paymentUrl) {
  const msg    = document.createElement('div');
  msg.className = `msg ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = parseBold(escapeHtml(text));

  // Attach payment button if URL provided
  if (paymentUrl && role === 'bot') {
    const payBtn = document.createElement('a');
    payBtn.href      = paymentUrl;
    payBtn.target    = '_blank';
    payBtn.rel       = 'noopener noreferrer';
    payBtn.className = 'pay-btn';
    payBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg> Pay Now';
    bubble.appendChild(document.createElement('br'));
    bubble.appendChild(payBtn);
  }

  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  scrollToBottom();
  return msg;
}

// ── Typing indicator ──────────────────────────────────────────────────────────
function showTyping() {
  const msg    = document.createElement('div');
  msg.className = 'msg bot typing';
  msg.id       = 'typing-indicator';
  msg.innerHTML = '<div class="bubble"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
  messagesEl.appendChild(msg);
  scrollToBottom();
}

function hideTyping() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

// ── Quick replies ─────────────────────────────────────────────────────────────
function setQuickReplies(replies) {
  quickRepliesEl.innerHTML = '';
  if (!replies || replies.length === 0) return;

  replies.forEach(label => {
    const btn    = document.createElement('button');
    btn.className = 'qr-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      // Extract the numeric prefix (e.g. "1. Place an order" → "1")
      const match = label.match(/^(\d+)/);
      const value = match ? match[1] : label;
      sendMessage(value, label);
    });
    quickRepliesEl.appendChild(btn);
  });
}

// ── Scroll helpers ────────────────────────────────────────────────────────────
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Escape HTML ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Send a message ────────────────────────────────────────────────────────────
async function sendMessage(value, displayLabel) {
  if (sending || !value.trim()) return;
  sending = true;
  sendBtn.disabled = true;

  const display = (displayLabel || value).trim();
  appendMessage('user', display);
  setQuickReplies([]);
  inputEl.value = '';

  showTyping();

  try {
    const res  = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: value.trim() }),
    });

    const data = await res.json();
    hideTyping();

    if (data.reply) {
      appendMessage('bot', data.reply, data.paymentUrl || null);
    }
    setQuickReplies(data.quickReplies || []);
  } catch {
    hideTyping();
    appendMessage('bot', 'Connection error. Please try again.');
  } finally {
    sending = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ── Input events ──────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', () => sendMessage(inputEl.value));

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});

// ── Payment banner ────────────────────────────────────────────────────────────
let bannerTimer;
function showBanner(type, text) {
  bannerText.textContent = text;
  banner.className       = `payment-banner ${type}`;
  banner.hidden          = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 5000);
}

bannerClose.addEventListener('click', () => { banner.hidden = true; clearTimeout(bannerTimer); });

// ── SSE — real-time payment confirmation ──────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/api/session/stream');

  es.addEventListener('connected', () => {
    headerDot.classList.add('online');
    headerSub.textContent = 'Online';
  });

  es.addEventListener('payment_confirmed', e => {
    const { reference, amount } = JSON.parse(e.data);
    const amountStr = Number(amount).toLocaleString();
    appendMessage('bot', `Payment confirmed for order *${reference}*.\nAmount: *${amountStr} XAF*\n\nThank you! Your order is being prepared.\n${'─'.repeat(30)}\n1. Place a new order`);
    setQuickReplies(['1. Place a new order']);
    showBanner('success', `Payment confirmed — order ${reference}`);
    // Reset server-side session step so next input goes to MAIN
    fetch('/api/session/reset', { method: 'POST' }).catch(() => {});
  });

  es.onerror = () => {
    headerDot.classList.remove('online');
    headerSub.textContent = 'Reconnecting…';
    // EventSource reconnects automatically
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Check for payment redirect query params
  const params = new URLSearchParams(location.search);
  const payment = params.get('payment');
  const ref     = params.get('ref');

  if (payment === 'success') {
    showBanner('success', `Payment successful${ref ? ` — order ${ref}` : ''}. Your order is confirmed!`);
  } else if (payment === 'pending') {
    showBanner('pending', `Payment pending${ref ? ` for order ${ref}` : ''}. Complete it using your payment link.`);
  }

  // Clean URL without reload
  if (payment) {
    history.replaceState(null, '', '/');
  }

  // Load welcome message
  try {
    const res  = await fetch('/api/session/init');
    const data = await res.json();
    if (data.reply) {
      appendMessage('bot', data.reply);
      setQuickReplies(data.quickReplies || []);
    }
  } catch {
    appendMessage('bot', 'Could not connect to the server. Please refresh.');
  }

  connectSSE();
  inputEl.focus();
}

init();
